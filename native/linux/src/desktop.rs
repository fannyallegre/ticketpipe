use crate::protocol::{self, fail, live, Reply};
use atspi::zbus::{self, proxy::CacheProperties};
use atspi::{AccessibilityConnection, ObjectRefOwned, Role, State, StateSet};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    os::unix::fs::MetadataExt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::runtime::Runtime;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Node {
    bus: String,
    path: String,
}
impl From<ObjectRefOwned> for Node {
    fn from(o: ObjectRefOwned) -> Self {
        Self {
            bus: o.name_as_str().unwrap_or("").to_string(),
            path: o.path_as_str().to_string(),
        }
    }
}
#[derive(Clone)]
struct Target {
    node: Node,
    app: Node,
    pid: u32,
    start: String,
    title: String,
    xid: Option<u32>,
    keys: bool,
}
#[derive(Default)]
struct Gate {
    target: Option<Target>,
    started: bool,
    settling: Option<Instant>,
    failed: bool,
}
#[derive(Clone)]
struct Backend {
    connection: Arc<AccessibilityConnection>,
    gate: Arc<Mutex<Gate>>,
    revoked: Arc<AtomicBool>,
    session: String,
    destroyed: Arc<Mutex<HashSet<Node>>>,
}
pub struct Desktop {
    runtime: Runtime,
    revoked: Arc<AtomicBool>,
    backend: Option<Backend>,
    snapshot: String,
    controls: HashMap<String, (Node, Value)>,
    serial: u64,
    observed_root: Option<Node>,
}
fn inaccessible<E>(_e: E) -> Value {
    fail("inaccessible", "The accessibility service or application did not respond. Please check accessibility setup.")
}
fn process_identity(pid: u32) -> Reply<String> {
    if fs::metadata(format!("/proc/{pid}"))
        .map_err(inaccessible)?
        .uid()
        != fs::metadata("/proc/self").map_err(inaccessible)?.uid()
    {
        return Err(fail(
            "elevated",
            "Applications running as another user cannot be controlled.",
        ));
    }
    let exe = fs::read_link(format!("/proc/{pid}/exe")).map_err(inaccessible)?;
    if protocol::protected(&exe.to_string_lossy()) {
        return Err(fail("protected", "This application cannot be controlled."));
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(inaccessible)?;
    stat.rsplit_once(')')
        .and_then(|(_, s)| s.split_whitespace().nth(19))
        .map(String::from)
        .ok_or_else(|| fail("target_lost", "The selected process is unavailable."))
}
fn session() -> Option<String> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase();
    if !desktop
        .split(':')
        .any(|d| d.contains("gnome") || d == "ubuntu")
    {
        return None;
    }
    // An XWayland display does not grant Xorg keyboard capabilities.
    match std::env::var("XDG_SESSION_TYPE")
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "wayland" => Some("gnome-wayland".into()),
        "x11" if std::env::var_os("WAYLAND_DISPLAY").is_none() => Some("gnome-xorg".into()),
        _ => None,
    }
}
async fn proxy<'a>(
    backend: &'a Backend,
    node: &'a Node,
    interface: &'a str,
) -> Reply<zbus::Proxy<'a>> {
    zbus::proxy::Builder::new(backend.connection.connection())
        .destination(node.bus.as_str())
        .map_err(inaccessible)?
        .path(node.path.as_str())
        .map_err(inaccessible)?
        .interface(interface)
        .map_err(inaccessible)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(inaccessible)
}
async fn accessible<'a>(b: &'a Backend, n: &'a Node) -> Reply<zbus::Proxy<'a>> {
    proxy(b, n, "org.a11y.atspi.Accessible").await
}
async fn states(b: &Backend, n: &Node) -> Reply<StateSet> {
    accessible(b, n)
        .await?
        .call("GetState", &())
        .await
        .map_err(inaccessible)
}
async fn name(b: &Backend, n: &Node) -> Reply<String> {
    accessible(b, n)
        .await?
        .get_property("Name")
        .await
        .map_err(inaccessible)
}
async fn role(b: &Backend, n: &Node) -> Reply<Role> {
    accessible(b, n)
        .await?
        .call("GetRole", &())
        .await
        .map_err(inaccessible)
}
async fn children(b: &Backend, n: &Node) -> Reply<Vec<Node>> {
    let objects: Vec<ObjectRefOwned> = accessible(b, n)
        .await?
        .call("GetChildren", &())
        .await
        .map_err(inaccessible)?;
    if objects.len() > 1500 {
        return Err(fail(
            "inaccessible",
            "The application exposes too many ambiguous controls.",
        ));
    }
    Ok(objects
        .into_iter()
        .map(Node::from)
        .filter(|n| n.path != "/org/a11y/atspi/null")
        .collect())
}
async fn apps(b: &Backend) -> Reply<Vec<Node>> {
    children(
        b,
        &Node {
            bus: "org.a11y.atspi.Registry".into(),
            path: "/org/a11y/atspi/accessible/root".into(),
        },
    )
    .await
}
async fn windows(b: &Backend) -> Reply<Vec<Target>> {
    let mut result = Vec::new();
    for app in apps(b).await?.into_iter().take(100) {
        let dbus = zbus::fdo::DBusProxy::new(b.connection.connection())
            .await
            .map_err(inaccessible)?;
        let owner = dbus
            .get_name_owner(app.bus.as_str().try_into().map_err(inaccessible)?)
            .await
            .map_err(inaccessible)?
            .to_string();
        let pid = dbus
            .get_connection_unix_process_id(owner.as_str().try_into().map_err(inaccessible)?)
            .await
            .map_err(inaccessible)?;
        let Ok(start) = process_identity(pid) else {
            continue;
        };
        let app = Node {
            bus: owner,
            path: app.path,
        };
        let Ok(list) = children(b, &app).await else {
            continue;
        };
        for node in list.into_iter().take(100) {
            if node.bus != app.bus {
                continue;
            }
            let Ok(r) = role(b, &node).await else {
                continue;
            };
            if !matches!(r, Role::Frame | Role::Window | Role::Dialog) {
                continue;
            }
            let Ok(s) = states(b, &node).await else {
                continue;
            };
            let Ok(title) = name(b, &node).await else {
                continue;
            };
            if !s.contains(State::Showing)
                || s.contains(State::Defunct)
                || title.is_empty()
                || protocol::protected(&title)
            {
                continue;
            }
            result.push(Target {
                node,
                app: app.clone(),
                pid,
                start: start.clone(),
                title,
                xid: None,
                keys: false,
            });
        }
    }
    Ok(result)
}
impl Target {
    fn id(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.node.bus, self.node.path, self.pid, self.start
        )
    }
}
impl Backend {
    async fn identity(&self, target: &Target) -> Reply<()> {
        live(&self.revoked)?;
        if self
            .destroyed
            .lock()
            .map_err(inaccessible)?
            .contains(&target.node)
        {
            return Err(fail(
                "target_lost",
                "The selected accessibility window was destroyed or replaced.",
            ));
        }
        if !Desktop::enabled().await? {
            return Err(fail(
                "permissions",
                "Desktop accessibility was disabled. Check setup before starting a new attempt.",
            ));
        }
        if process_identity(target.pid)? != target.start {
            return Err(fail(
                "target_lost",
                "The selected application process was replaced.",
            ));
        }
        let dbus = zbus::fdo::DBusProxy::new(self.connection.connection())
            .await
            .map_err(inaccessible)?;
        let owner = dbus
            .get_name_owner(target.node.bus.as_str().try_into().map_err(inaccessible)?)
            .await
            .map_err(inaccessible)?;
        if owner.as_str() != target.node.bus {
            return Err(fail(
                "target_lost",
                "The application's accessibility connection was replaced.",
            ));
        }
        let s = states(self, &target.node).await?;
        if s.contains(State::Defunct) || !s.contains(State::Showing) {
            return Err(fail(
                "target_lost",
                "The selected window is no longer accessible.",
            ));
        }
        Ok(())
    }
    async fn active_root(&self, target: &Target) -> Reply<Option<Node>> {
        self.identity(target).await?;
        let s = states(self, &target.node).await?;
        let mut root = if s.contains(State::Active) {
            Some(target.node.clone())
        } else {
            None
        };
        let mut dialog = None;
        for sibling in children(self, &target.app).await? {
            if sibling == target.node {
                continue;
            }
            if matches!(
                role(self, &sibling).await?,
                Role::Frame | Role::Window | Role::Dialog
            ) && states(self, &sibling).await?.contains(State::Active)
            {
                if !owned_dialog(self, &sibling, &target.node).await? || dialog.is_some() {
                    return Ok(None);
                }
                dialog = Some(sibling);
            }
        }
        if dialog.is_some() {
            root = dialog;
        }
        if let (Some(xid), Some(active)) = (target.xid, root.as_ref()) {
            let expected = if active == &target.node {
                Some(xid)
            } else {
                let mut dialog = target.clone();
                dialog.node = active.clone();
                dialog.title = name(self, active).await?;
                correlate_x11(&dialog)?
            };
            if expected != Some(x11_active()?) {
                return Ok(None);
            }
        }
        Ok(root)
    }
    async fn focused(&self, target: &Target) -> Reply<bool> {
        Ok(self.active_root(target).await?.is_some())
    }
    async fn guard(&self) -> Reply<Target> {
        live(&self.revoked)?;
        let target = {
            let gate = self.gate.lock().map_err(inaccessible)?;
            if !gate.started || gate.failed {
                return Err(fail("unbound", "The selected window is not ready."));
            }
            gate.target
                .clone()
                .ok_or_else(|| fail("unbound", "No window is selected."))?
        };
        if !self.focused(&target).await? {
            self.revoked.store(true, Ordering::SeqCst);
            return Err(fail(
                "focus_lost",
                "Focus left the selected window. Start a new attempt when ready.",
            ));
        }
        live(&self.revoked)?;
        Ok(target)
    }
    async fn focus(&self) -> Reply<Value> {
        let target = self
            .gate
            .lock()
            .map_err(inaccessible)?
            .target
            .clone()
            .ok_or_else(|| fail("unbound", "No window is selected."))?;
        let focused = self.focused(&target).await?;
        let mut gate = self.gate.lock().map_err(inaccessible)?;
        if gate.failed || (gate.settling.is_some() && !focused) {
            self.revoked.store(true, Ordering::SeqCst);
            return Err(fail(
                "focus_lost",
                "Focus left the selected window during handoff.",
            ));
        }
        if focused {
            let since = gate.settling.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(75) {
                gate.started = true;
                return Ok(json!({"state":"ready"}));
            }
        }
        Ok(json!({"state":"awaiting_focus"}))
    }
}
impl Desktop {
    pub fn new(revoked: Arc<AtomicBool>) -> Reply<Self> {
        Ok(Self {
            runtime: Runtime::new().map_err(inaccessible)?,
            revoked,
            backend: None,
            snapshot: String::new(),
            controls: HashMap::new(),
            serial: 0,
            observed_root: None,
        })
    }
    fn connect(&mut self) -> Reply<Backend> {
        if let Some(b) = &self.backend {
            return Ok(b.clone());
        }
        let session=session().ok_or_else(|| fail("unavailable","Automatic fixing needs a GNOME desktop session on Wayland or Xorg (Ubuntu Desktop or Fedora Workstation)."))?;
        let connection = Arc::new(
            self.runtime
                .block_on(AccessibilityConnection::new())
                .map_err(inaccessible)?,
        );
        let b = Backend {
            connection,
            gate: Arc::new(Mutex::new(Gate::default())),
            revoked: self.revoked.clone(),
            session,
            destroyed: Arc::new(Mutex::new(HashSet::new())),
        };
        self.runtime
            .block_on(b.connection.register_event::<atspi::events::WindowEvents>())
            .map_err(inaccessible)?;
        self.runtime
            .block_on(
                b.connection
                    .register_event::<atspi::events::object::StateChangedEvent>(),
            )
            .map_err(inaccessible)?;
        let watch = b.clone();
        self.runtime.spawn(async move {
            let stream=watch.connection.event_stream(); tokio::pin!(stream);
            while let Some(event)=stream.next().await {
                let Ok(event)=event else { watch.revoked.store(true,Ordering::SeqCst); return };
                use atspi::EventProperties;
                let object=event.object_ref();
                let node=Node { bus:object.name_as_str().unwrap_or("").to_string(),path:object.path_as_str().to_string() };
                let destroyed=matches!(&event,atspi::Event::Window(atspi::WindowEvents::Destroy(_))) || matches!(&event,atspi::Event::Object(atspi::ObjectEvents::StateChanged(e)) if e.state==State::Defunct && e.enabled);
                if destroyed { if let Ok(mut dead)=watch.destroyed.lock() {dead.insert(node.clone());} }
                let (target,started)=match watch.gate.lock(){Ok(g)=>(g.target.clone(),g.started||g.settling.is_some()),Err(_)=>{watch.revoked.store(true,Ordering::SeqCst);return}};
                if let Some(target)=target {
                    if node==target.node && destroyed { watch.revoked.store(true,Ordering::SeqCst);return; }
                    if started && matches!(&event,atspi::Event::Window(atspi::WindowEvents::Deactivate(_))) {
                        if !matches!(watch.focused(&target).await,Ok(true)){watch.revoked.store(true,Ordering::SeqCst);return;}
                    }
                }
            }
            watch.revoked.store(true,Ordering::SeqCst);
        });
        self.backend = Some(b.clone());
        Ok(b)
    }
    async fn enabled() -> Reply<bool> {
        let c = zbus::Connection::session().await.map_err(inaccessible)?;
        let p = zbus::Proxy::new(&c, "org.a11y.Bus", "/org/a11y/status", "org.a11y.Status")
            .await
            .map_err(inaccessible)?;
        p.get_property("IsEnabled").await.map_err(inaccessible)
    }
    fn status(&mut self, setup: bool) -> Reply<Value> {
        let Some(session) = session() else {
            return Ok(protocol::status(
                "linux",
                false,
                "unavailable",
                "Use a GNOME graphical session on Ubuntu Desktop or Fedora Workstation.",
                false,
                "unsupported",
                &[],
            ));
        };
        if setup {
            self.runtime.block_on(async {
                let c = zbus::Connection::session().await.map_err(inaccessible)?;
                let p = zbus::Proxy::new(&c, "org.a11y.Bus", "/org/a11y/status", "org.a11y.Status")
                    .await
                    .map_err(inaccessible)?;
                p.set_property("IsEnabled", true)
                    .await
                    .map_err(inaccessible)?;
                // IsEnabled enables the bridge; never change ScreenReaderEnabled.
                Ok::<(), Value>(())
            })?;
        }
        match self.runtime.block_on(Self::enabled()) {
            Ok(false) => return Ok(protocol::status("linux",false,"required","Enable desktop accessibility, then check again. No screen reader is required.",true,&session,&[])),
            Err(_) => return Ok(protocol::status("linux",false,"unavailable","The desktop accessibility service is unavailable. Check that AT-SPI and your graphical session are running.",false,&session,&[])),
            _ => {}
        }
        match self.connect() {
            Ok(_) => Ok(protocol::status(
                "linux",
                true,
                "granted",
                "Select a window, then bring it forward when asked. Stop remains available.",
                false,
                &session,
                if session.ends_with("xorg") {
                    protocol::KEYS
                } else {
                    &[]
                },
            )),
            Err(_) => Ok(protocol::status(
                "linux",
                false,
                "unavailable",
                "AT-SPI is not responding. Check your desktop accessibility service.",
                false,
                &session,
                &[],
            )),
        }
    }
    fn bind(&mut self, id: &str) -> Reply<Value> {
        if self
            .backend
            .as_ref()
            .is_some_and(|b| b.gate.lock().is_ok_and(|g| g.target.is_some()))
        {
            return Err(fail("invalid", "A helper can bind only one attempt."));
        }
        if self.status(false)?["ready"] != true {
            return Err(fail("permissions", "Desktop accessibility is unavailable."));
        }
        let b = self.connect()?;
        let mut matches: Vec<_> = self
            .runtime
            .block_on(windows(&b))?
            .into_iter()
            .filter(|w| w.id() == id)
            .collect();
        if matches.len() != 1 {
            return Err(fail(
                "target_lost",
                "Refresh the picker: the selected window is missing or ambiguous.",
            ));
        }
        let mut target = matches.remove(0);
        if b.session.ends_with("xorg") {
            target.xid = correlate_x11(&target).ok().flatten();
            target.keys = target.xid.is_some() && x11_keyboard_ready().unwrap_or(false);
        }
        b.gate.lock().map_err(inaccessible)?.target = Some(target.clone());
        let watch = b.clone();
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if watch.revoked.load(Ordering::SeqCst) {
                    break;
                }
                let started = watch.gate.lock().is_ok_and(|g| g.started);
                if started
                    && !matches!(
                        tokio::time::timeout(Duration::from_millis(1500), watch.guard()).await,
                        Ok(Ok(_))
                    )
                {
                    watch.revoked.store(true, Ordering::SeqCst);
                    break;
                }
            }
        });
        // Wayland deliberately performs no activation or synthetic keyboard input.
        self.runtime.block_on(b.focus())
    }
    fn observe(&mut self) -> Reply<Value> {
        let b = self.connect()?;
        let mut target = self.runtime.block_on(b.guard())?;
        target.keys = target.xid.is_some() && x11_keyboard_ready().unwrap_or(false);
        let root = self
            .runtime
            .block_on(b.active_root(&target))?
            .ok_or_else(|| fail("focus_lost", "The selected window lost focus."))?;
        if root != target.node {
            target.xid = None;
        }
        self.serial += 1;
        self.snapshot = format!("o{}", self.serial);
        self.controls.clear();
        let (nodes, truncated) = self.runtime.block_on(collect(&b, &root))?;
        self.observed_root = Some(root);
        let mut controls = Vec::new();
        for node in nodes {
            if let Some(mut c) = self.runtime.block_on(read_control(&b, &target, &node))? {
                let reference = format!("e{}", controls.len());
                c["ref"] = json!(reference);
                self.controls.insert(reference, (node, c.clone()));
                controls.push(c);
            }
        }
        self.runtime.block_on(b.guard())?;
        let title = self
            .runtime
            .block_on(name(&b, self.observed_root.as_ref().unwrap()))?;
        Ok(
            json!({"id":self.snapshot,"title":title.chars().take(400).collect::<String>(),"controls":controls,"truncated":truncated}),
        )
    }
    fn act(&mut self, args: &Value) -> Reply<Value> {
        let previous = std::mem::take(&mut self.snapshot);
        let controls = std::mem::take(&mut self.controls);
        if previous.is_empty() || args["observationId"] != previous {
            return Err(fail("stale", "Inspect again before acting."));
        }
        let reference = args["action"]["ref"].as_str().unwrap_or("");
        let (node, old) = controls
            .get(reference)
            .ok_or_else(|| fail("stale", "The selected control is unavailable."))?;
        let b = self.connect()?;
        let mut target = self.runtime.block_on(b.guard())?;
        target.keys = target.xid.is_some() && x11_keyboard_ready().unwrap_or(false);
        let root = self
            .runtime
            .block_on(b.active_root(&target))?
            .ok_or_else(|| fail("focus_lost", "The selected window lost focus."))?;
        if self.observed_root.as_ref() != Some(&root) {
            return Err(fail(
                "stale",
                "The selected window's dialog changed. Inspect again.",
            ));
        }
        if root != target.node {
            target.xid = None;
        }
        let (tree, _) = self.runtime.block_on(collect(&b, &root))?;
        if tree.iter().filter(|n| *n == node).count() != 1 {
            return Err(fail(
                "stale",
                "The control is no longer uniquely inside the selected window.",
            ));
        }
        let mut current = self
            .runtime
            .block_on(read_control(&b, &target, node))?
            .ok_or_else(|| fail("protected", "The control is protected."))?;
        current["ref"] = json!(reference);
        if current != *old {
            return Err(fail("stale", "The control changed. Inspect again."));
        }
        let action = &args["action"];
        let title = self.runtime.block_on(name(&b, &root))?;
        protocol::validate_action(
            action,
            &current,
            &format!("{} {}", target.title, title),
            if b.session.ends_with("xorg") {
                protocol::KEYS
            } else {
                &[]
            },
        )?;
        self.runtime.block_on(b.guard())?;
        live(&self.revoked)?;
        self.runtime.block_on(async {
            let result: Reply<bool> = match action["kind"].as_str().unwrap_or("") {
                "text" => {
                    let p = proxy(&b, node, "org.a11y.atspi.EditableText").await?;
                    live(&b.revoked)?;
                    b.guard().await?;
                    p.call("SetTextContents", &(action["text"].as_str().unwrap_or(""),))
                        .await
                        .map_err(|_| protocol::uncertain("Text entry was not acknowledged."))
                }
                "activate" => {
                    let p = proxy(&b, node, "org.a11y.atspi.Action").await?;
                    let index = current["nativeAction"]
                        .as_i64()
                        .ok_or_else(|| fail("invalid", "No safe action is available."))?
                        as i32;
                    live(&b.revoked)?;
                    b.guard().await?;
                    p.call("DoAction", &(index,))
                        .await
                        .map_err(|_| protocol::uncertain("Activation was not acknowledged."))
                }
                "select" => {
                    let parent: ObjectRefOwned = accessible(&b, node)
                        .await?
                        .get_property("Parent")
                        .await
                        .map_err(inaccessible)?;
                    let parent = Node::from(parent);
                    let index: i32 = accessible(&b, node)
                        .await?
                        .call("GetIndexInParent", &())
                        .await
                        .map_err(inaccessible)?;
                    let p = proxy(&b, &parent, "org.a11y.atspi.Selection").await?;
                    live(&b.revoked)?;
                    b.guard().await?;
                    p.call("SelectChild", &(index,))
                        .await
                        .map_err(|_| protocol::uncertain("Selection was not acknowledged."))
                }
                "scroll" => {
                    let p = proxy(&b, node, "org.a11y.atspi.Value").await?;
                    let value: f64 = p.get_property("CurrentValue").await.map_err(inaccessible)?;
                    let min: f64 = p.get_property("MinimumValue").await.map_err(inaccessible)?;
                    let max: f64 = p.get_property("MaximumValue").await.map_err(inaccessible)?;
                    let increment: f64 = p
                        .get_property("MinimumIncrement")
                        .await
                        .map_err(inaccessible)?;
                    let step = increment.max((max - min) / 10.0);
                    let next = (value
                        + if action["direction"] == "up" {
                            -step
                        } else {
                            step
                        })
                    .clamp(min, max);
                    live(&b.revoked)?;
                    b.guard().await?;
                    p.set_property("CurrentValue", next)
                        .await
                        .map_err(|_| protocol::uncertain("Scroll was not acknowledged."))?;
                    Ok(true)
                }
                "keys" => {
                    let p = proxy(&b, node, "org.a11y.atspi.Component").await?;
                    let focused: bool = p.call("GrabFocus", &()).await.map_err(inaccessible)?;
                    if !focused || !states(&b, node).await?.contains(State::Focused) {
                        return Err(fail("focus_lost", "The control could not acquire focus."));
                    }
                    b.guard().await?;
                    live(&b.revoked)?;
                    x11_key(&target, action["key"].as_str().unwrap_or(""), &b.revoked)?;
                    Ok(true)
                }
                _ => Err(fail("invalid", "Unsupported action.")),
            };
            if result? {
                Ok(json!({"performed":true}))
            } else {
                Err(protocol::uncertain(
                    "The application did not acknowledge the requested operation.",
                ))
            }
        })
    }
}
async fn owned_dialog(b: &Backend, child: &Node, parent: &Node) -> Reply<bool> {
    if child.bus != parent.bus || !matches!(role(b, child).await?, Role::Dialog | Role::Window) {
        return Ok(false);
    }
    let relations: Vec<(atspi::RelationType, Vec<ObjectRefOwned>)> = accessible(b, child)
        .await?
        .call("GetRelationSet", &())
        .await
        .map_err(inaccessible)?;
    if relations.into_iter().any(|(relation, targets)| {
        matches!(
            relation,
            atspi::RelationType::SubwindowOf | atspi::RelationType::PopupFor
        ) && targets.into_iter().any(|o| Node::from(o) == *parent)
    }) {
        return Ok(true);
    }
    let mut current = child.clone();
    for _ in 0..32 {
        let next: ObjectRefOwned = accessible(b, &current)
            .await?
            .get_property("Parent")
            .await
            .map_err(inaccessible)?;
        let next = Node::from(next);
        if next == *parent {
            return Ok(true);
        }
        if next.bus != parent.bus || next == current || next.path == "/org/a11y/atspi/null" {
            return Ok(false);
        }
        current = next;
    }
    Ok(false)
}
async fn collect(b: &Backend, root: &Node) -> Reply<(Vec<Node>, bool)> {
    let mut queue = VecDeque::from([root.clone()]);
    let mut seen = HashSet::new();
    let mut nodes = Vec::new();
    while let Some(n) = queue.pop_front() {
        live(&b.revoked)?;
        if nodes.len() >= 500 {
            return Ok((nodes, true));
        }
        if n.bus != root.bus || !seen.insert(n.clone()) {
            continue;
        }
        let r = role(b, &n).await?;
        if matches!(r, Role::PasswordText | Role::Terminal) {
            continue;
        }
        let s = states(b, &n).await?;
        if s.contains(State::Defunct) || !s.contains(State::Showing) {
            continue;
        }
        let label = name(b, &n).await?;
        if protocol::protected(&label) {
            continue;
        }
        nodes.push(n.clone());
        queue.extend(children(b, &n).await?);
    }
    Ok((nodes, false))
}
async fn read_control(b: &Backend, t: &Target, n: &Node) -> Reply<Option<Value>> {
    if b.destroyed.lock().map_err(inaccessible)?.contains(n) {
        return Ok(None);
    }
    let p = accessible(b, n).await?;
    let r: Role = p.call("GetRole", &()).await.map_err(inaccessible)?;
    // Never request text/value on password or protected controls.
    if matches!(r, Role::PasswordText | Role::Terminal) {
        return Ok(None);
    }
    let label: String = p.get_property("Name").await.map_err(inaccessible)?;
    let id: String = p.get_property("AccessibleId").await.unwrap_or_default();
    if protocol::protected(&format!("{label} {id}")) {
        return Ok(None);
    }
    let attributes: HashMap<String, String> =
        p.call("GetAttributes", &()).await.map_err(inaccessible)?;
    if attributes.iter().any(|(key, value)| {
        ["text-input-type", "type", "input-type"].contains(&key.as_str())
            && value.eq_ignore_ascii_case("password")
    }) {
        return Ok(None);
    }
    let s: StateSet = p.call("GetState", &()).await.map_err(inaccessible)?;
    if !s.contains(State::Showing) || s.contains(State::Defunct) {
        return Ok(None);
    }
    let interfaces: atspi::InterfaceSet =
        p.call("GetInterfaces", &()).await.map_err(inaccessible)?;
    let editable =
        s.contains(State::Editable) && interfaces.contains(atspi::Interface::EditableText);
    let enabled = s.contains(State::Enabled) && s.contains(State::Sensitive);
    let mut actions = Vec::new();
    let mut native_action = None;
    if interfaces.contains(atspi::Interface::Action) {
        let a = proxy(b, n, "org.a11y.atspi.Action").await?;
        let list: Vec<atspi::Action> = a.call("GetActions", &()).await.map_err(inaccessible)?;
        for i in 0..list.len().min(32) {
            // GetActions contains localized labels. GetName is the stable
            // protocol action name, independent of the user's desktop language.
            let canonical: String = a
                .call("GetName", &(i as i32,))
                .await
                .map_err(inaccessible)?;
            if [
                "click", "press", "activate", "toggle", "expand", "collapse", "open", "jump",
            ]
            .contains(&canonical.to_lowercase().as_str())
                && protocol::safe_control(&canonical)
            {
                native_action = Some(i);
                actions.push("activate");
                break;
            }
        }
    }
    if editable {
        actions.push("text");
    }
    if s.contains(State::Selectable) {
        let parent: ObjectRefOwned = p.get_property("Parent").await.map_err(inaccessible)?;
        let parent = Node::from(parent);
        if parent.bus == n.bus {
            let interfaces: atspi::InterfaceSet = accessible(b, &parent)
                .await?
                .call("GetInterfaces", &())
                .await
                .map_err(inaccessible)?;
            if interfaces.contains(atspi::Interface::Selection) {
                actions.push("select");
            }
        }
    }
    if r == Role::ScrollBar && interfaces.contains(atspi::Interface::Value) {
        actions.push("scroll");
    }
    let keys = if t.keys
        && t.xid.is_some()
        && b.session.ends_with("xorg")
        && s.contains(State::Focusable)
        && interfaces.contains(atspi::Interface::Component)
    {
        protocol::KEYS
    } else {
        &[]
    };
    if !keys.is_empty() {
        actions.push("keys");
    }
    let mut c = json!({"ref":"","name":label.chars().take(400).collect::<String>(),"role":format!("{r:?}"),"automationId":id.chars().take(400).collect::<String>(),"enabled":enabled,"editable":editable,"actions":actions,"allowedKeys":keys,"nativeAction":native_action});
    if interfaces.contains(atspi::Interface::Text) {
        let p = proxy(b, n, "org.a11y.atspi.Text").await?;
        let count: i32 = p
            .get_property("CharacterCount")
            .await
            .map_err(inaccessible)?;
        let text: String = p
            .call("GetText", &(0i32, count.min(2000)))
            .await
            .map_err(inaccessible)?;
        c["value"] = json!(text);
        c["valueTruncated"] = json!(count > 2000);
    }
    if matches!(
        r,
        Role::CheckBox
            | Role::ToggleButton
            | Role::RadioButton
            | Role::CheckMenuItem
            | Role::RadioMenuItem
    ) {
        c["checked"] = json!(s.contains(State::Checked) || s.contains(State::Pressed));
    }
    if s.contains(State::Selectable) {
        c["selected"] = json!(s.contains(State::Selected));
    }
    if label.chars().count() > 400 || id.chars().count() > 400 || c["valueTruncated"] == true {
        c["actions"] = json!([]);
        c["allowedKeys"] = json!([]);
    }
    Ok(Some(c))
}
impl protocol::Controller for Desktop {
    fn execute(&mut self, r: &Value) -> Reply<Value> {
        live(&self.revoked)?;
        match r["op"].as_str().unwrap_or("") {
            "status" => self.status(false),
            "permissions" => self.status(true),
            "windows" => {
                if self.status(false)?["ready"] != true {
                    return Err(fail("permissions", "Desktop accessibility is not ready."));
                }
                let b = self.connect()?;
                let windows = self.runtime.block_on(windows(&b))?;
                Ok(json!(windows.iter().map(|w|json!({"id":w.id(),"title":w.title,"app":fs::read_link(format!("/proc/{}/exe",w.pid)).ok().and_then(|p|p.file_name().map(|s|s.to_string_lossy().to_string())).unwrap_or_else(||"Application".into())})).collect::<Vec<_>>()))
            }
            "bind" => self.bind(
                r["args"]["id"]
                    .as_str()
                    .ok_or_else(|| fail("invalid", "Choose a window."))?,
            ),
            "focus" => {
                let b = self.connect()?;
                self.runtime.block_on(b.focus())
            }
            "guard" => {
                let b = self.connect()?;
                self.runtime.block_on(b.guard())?;
                Ok(json!({}))
            }
            "observe" => self.observe(),
            "act" => self.act(&r["args"]),
            _ => Err(fail("invalid", "Unknown controller operation.")),
        }
    }
}

// X11 is used only for identity-checked application-local keys. Never on Wayland.
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{self, AtomEnum, ConnectionExt as _, Window},
        xtest::ConnectionExt as _,
    },
    rust_connection::RustConnection,
    CURRENT_TIME,
};
fn xconnect() -> Reply<(RustConnection, usize)> {
    let display = std::env::var("DISPLAY").unwrap_or_default();
    if !display.starts_with(':') && !display.starts_with("unix:") {
        return Err(fail("inaccessible","Keyboard control requires the local Xorg display. Semantic accessibility operations remain available."));
    }
    x11rb::connect(None).map_err(inaccessible)
}
fn atom(c: &RustConnection, n: &str) -> Reply<u32> {
    c.intern_atom(false, n.as_bytes())
        .map_err(inaccessible)?
        .reply()
        .map(|r| r.atom)
        .map_err(inaccessible)
}
fn property(c: &RustConnection, w: Window, n: &str) -> Reply<Vec<u32>> {
    Ok(
        c.get_property(false, w, atom(c, n)?, AtomEnum::ANY, 0, 4096)
            .map_err(inaccessible)?
            .reply()
            .map_err(inaccessible)?
            .value32()
            .map(|i| i.collect())
            .unwrap_or_default(),
    )
}
fn x11_active() -> Reply<u32> {
    let (c, s) = xconnect()?;
    property(&c, c.setup().roots[s].root, "_NET_ACTIVE_WINDOW")?
        .first()
        .copied()
        .ok_or_else(|| {
            fail(
                "inaccessible",
                "Xorg active-window tracking is unavailable.",
            )
        })
}
fn x11_keyboard_ready() -> Reply<bool> {
    use x11rb::protocol::xkb::{self, ConnectionExt as _};
    let (c, _) = xconnect()?;
    if !c
        .xkb_use_extension(1, 0)
        .map_err(inaccessible)?
        .reply()
        .map_err(inaccessible)?
        .supported
    {
        return Ok(false);
    }
    let state = c
        .xkb_get_state(u16::from(xkb::ID::USE_CORE_KBD))
        .map_err(inaccessible)?
        .reply()
        .map_err(inaccessible)?;
    // Core GetKeyboardMapping resolves group zero. Refuse alternate groups
    // rather than sending a different shortcut under an unknown active layout.
    Ok(u8::from(state.group) == 0)
}
fn correlate_x11(t: &Target) -> Reply<Option<u32>> {
    let (c, s) = xconnect()?;
    let mut matches = Vec::new();
    for w in property(&c, c.setup().roots[s].root, "_NET_CLIENT_LIST")? {
        if property(&c, w, "_NET_WM_PID")?.first() != Some(&t.pid) {
            continue;
        }
        let title = c
            .get_property(false, w, atom(&c, "_NET_WM_NAME")?, AtomEnum::ANY, 0, 4096)
            .map_err(inaccessible)?
            .reply()
            .map_err(inaccessible)?
            .value;
        if String::from_utf8_lossy(&title) == t.title {
            matches.push(w);
        }
    }
    Ok(if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    })
}
fn x11_key(t: &Target, key: &str, revoked: &AtomicBool) -> Reply<()> {
    let xid = t
        .xid
        .ok_or_else(|| fail("protected", "No proven Xorg window identity is available."))?;
    if !x11_keyboard_ready()?
        || !protocol::KEYS.contains(&key)
        || correlate_x11(t)? != Some(xid)
        || x11_active()? != xid
    {
        return Err(fail("focus_lost", "The Xorg target identity changed."));
    }
    let (c, s) = xconnect()?;
    let root = c.setup().roots[s].root;
    let pointer = c
        .query_pointer(root)
        .map_err(inaccessible)?
        .reply()
        .map_err(inaccessible)?;
    if u16::from(pointer.mask) & 0xfd != 0 {
        return Err(fail(
            "protected",
            "Release modifier keys before starting a repair.",
        ));
    }
    let (ctrl, sym) = match key {
        "ENTER" => (false, 0xff0d),
        "TAB" => (false, 0xff09),
        "ESC" => (false, 0xff1b),
        "SPACE" => (false, 0x20),
        "UP" => (false, 0xff52),
        "DOWN" => (false, 0xff54),
        "LEFT" => (false, 0xff51),
        "RIGHT" => (false, 0xff53),
        "HOME" => (false, 0xff50),
        "END" => (false, 0xff57),
        "PAGEUP" => (false, 0xff55),
        "PAGEDOWN" => (false, 0xff56),
        "BACKSPACE" => (false, 0xff08),
        "F5" => (false, 0xffc2),
        "CTRL+A" => (true, 0x61),
        "CTRL+F" => (true, 0x66),
        "CTRL+S" => (true, 0x73),
        "CTRL+R" => (true, 0x72),
        _ => return Err(fail("invalid", "Unsupported key.")),
    };
    let first = c.setup().min_keycode;
    let count = c.setup().max_keycode - first + 1;
    let mapping = c
        .get_keyboard_mapping(first, count)
        .map_err(inaccessible)?
        .reply()
        .map_err(inaccessible)?;
    let find = |sym: u32| {
        mapping
            .keysyms
            .chunks(mapping.keysyms_per_keycode as usize)
            .position(|m| m.first() == Some(&sym))
            .map(|i| first + i as u8)
            .ok_or_else(|| {
                fail(
                    "inaccessible",
                    "This keyboard layout does not expose the requested key.",
                )
            })
    };
    let code = find(sym)?;
    let control = if ctrl { Some(find(0xffe3)?) } else { None };
    live(revoked)?;
    if !x11_keyboard_ready()? || x11_active()? != xid {
        return Err(fail("focus_lost", "Focus changed before keyboard input."));
    }
    let result = (|| -> Reply<()> {
        if let Some(k) = control {
            c.xtest_fake_input(xproto::KEY_PRESS_EVENT, k, CURRENT_TIME, root, 0, 0, 0)
                .map_err(inaccessible)?
                .check()
                .map_err(inaccessible)?;
        }
        live(revoked)?;
        if x11_active()? != xid {
            return Err(protocol::uncertain("Focus changed during keyboard input."));
        }
        c.xtest_fake_input(xproto::KEY_PRESS_EVENT, code, CURRENT_TIME, root, 0, 0, 0)
            .map_err(inaccessible)?
            .check()
            .map_err(inaccessible)?;
        Ok(())
    })();
    // Always release keys, even when input was revoked between press and release.
    let release = c
        .xtest_fake_input(xproto::KEY_RELEASE_EVENT, code, CURRENT_TIME, root, 0, 0, 0)
        .map_err(|_| protocol::uncertain("Key release was not acknowledged."))?
        .check()
        .map_err(|_| protocol::uncertain("Key release was not acknowledged."));
    if let Some(k) = control {
        let _ = c.xtest_fake_input(xproto::KEY_RELEASE_EVENT, k, CURRENT_TIME, root, 0, 0, 0);
    }
    c.flush()
        .map_err(|_| protocol::uncertain("Key release was not acknowledged."))?;
    release?;
    result.map_err(|_| protocol::uncertain("Keyboard input was not fully acknowledged."))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_start_is_stable() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let pid = child.id();
        let first = process_identity(pid);
        let second = process_identity(pid);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(first.unwrap(), second.unwrap());
    }
    #[test]
    fn nonexistent_process_is_rejected() {
        assert!(process_identity(u32::MAX).is_err());
    }
}

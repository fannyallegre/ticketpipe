#[path = "ax.rs"]
mod ax;
use crate::protocol::{self, fail, live, Reply};
use ax::{Owned, Ref};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    ffi::{c_char, c_void},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[link(name = "AppKit", kind = "framework")]
extern "C" {}
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Ref;
    fn sel_registerName(name: *const c_char) -> Ref;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}
#[link(name = "proc")]
extern "C" {
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, size: i32) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
}
struct Pool(*mut c_void);
impl Pool {
    fn new() -> Self {
        unsafe { Self(objc_autoreleasePoolPush()) }
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        unsafe { objc_autoreleasePoolPop(self.0) }
    }
}
unsafe fn selector(name: &str) -> Ref {
    let name = std::ffi::CString::new(name).unwrap();
    sel_registerName(name.as_ptr())
}
unsafe fn message(obj: Ref, name: &str) -> Ref {
    let call: unsafe extern "C" fn(Ref, Ref) -> Ref =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    call(obj, selector(name))
}
unsafe fn integer(obj: Ref, name: &str) -> usize {
    let call: unsafe extern "C" fn(Ref, Ref) -> usize =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    call(obj, selector(name))
}
unsafe fn indexed(obj: Ref, index: usize) -> Ref {
    let call: unsafe extern "C" fn(Ref, Ref, usize) -> Ref =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    call(obj, selector("objectAtIndex:"), index)
}
unsafe fn workspace() -> Ref {
    message(objc_getClass(c"NSWorkspace".as_ptr()), "sharedWorkspace")
}
unsafe fn application(pid: i32) -> Ref {
    let call: unsafe extern "C" fn(Ref, Ref, i32) -> Ref =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    call(
        objc_getClass(c"NSRunningApplication".as_ptr()),
        selector("runningApplicationWithProcessIdentifier:"),
        pid,
    )
}
unsafe fn activate(pid: i32) {
    let app = application(pid);
    if !app.is_null() {
        let call: unsafe extern "C" fn(Ref, Ref, usize) -> u8 =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let _ = call(app, selector("activateWithOptions:"), 2);
    }
}
fn frontmost() -> i32 {
    let _pool = Pool::new();
    unsafe {
        integer(
            message(workspace(), "frontmostApplication"),
            "processIdentifier",
        ) as i32
    }
}
fn running() -> Vec<(i32, String)> {
    let _pool = Pool::new();
    unsafe {
        let apps = message(workspace(), "runningApplications");
        (0..integer(apps, "count").min(300))
            .filter_map(|i| {
                let app = indexed(apps, i);
                if integer(app, "activationPolicy") != 0 {
                    return None;
                }
                let pid = integer(app, "processIdentifier") as i32;
                let label = message(app, "localizedName");
                let label = Owned::take(ax::CFRetain(label))?
                    .text()
                    .unwrap_or_else(|| "Application".into());
                Some((pid, label))
            })
            .collect()
    }
}
#[repr(C)]
#[derive(Default)]
struct BsdInfo {
    flags: u32,
    status: u32,
    xstatus: u32,
    pid: u32,
    ppid: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    rfu: u32,
    comm: [u8; 16],
    name: [u8; 32],
    nfiles: u32,
    pgid: u32,
    jobc: u32,
    tdev: u32,
    tpgid: u32,
    nice: i32,
    start_sec: u64,
    start_usec: u64,
}
fn process_identity(pid: i32) -> Reply<String> {
    unsafe {
        let mut info = BsdInfo::default();
        let size = std::mem::size_of::<BsdInfo>();
        if proc_pidinfo(pid, 3, 0, &mut info as *mut _ as _, size as i32) != size as i32
            || info.pid != pid as u32
        {
            return Err(fail(
                "target_lost",
                "The selected application is unavailable.",
            ));
        }
        if info.uid != libc::geteuid() {
            return Err(fail(
                "elevated",
                "Applications running as another user cannot be controlled.",
            ));
        }
        let mut path = vec![0u8; 4096];
        if proc_pidpath(pid, path.as_mut_ptr() as _, 4096) <= 0 {
            return Err(fail(
                "target_lost",
                "The selected process cannot be identified.",
            ));
        }
        let end = path.iter().position(|b| *b == 0).unwrap_or(path.len());
        if protocol::protected(&String::from_utf8_lossy(&path[..end])) {
            return Err(fail("protected", "This application cannot be controlled."));
        }
        Ok(format!("{}:{}", info.start_sec, info.start_usec))
    }
}
fn app_element(pid: i32) -> Reply<Owned> {
    unsafe {
        let app = Owned::take(ax::AXUIElementCreateApplication(pid))
            .ok_or_else(|| fail("inaccessible", "The application is inaccessible."))?;
        ax::AXUIElementSetMessagingTimeout(app.0, 0.8);
        Ok(app)
    }
}
fn trusted() -> bool {
    unsafe { ax::AXIsProcessTrusted() != 0 }
}
fn allowed_keys() -> Vec<&'static str> {
    protocol::MAC_KEYS
        .iter()
        .copied()
        .filter(|key| {
            !key.starts_with("CMD+")
                || ax::command_key(key.chars().last().unwrap().to_ascii_lowercase()).is_some()
        })
        .collect()
}
fn is_window(e: &Owned) -> bool {
    matches!(
        e.label("AXRole").as_str(),
        "AXWindow" | "AXSheet" | "AXDialog"
    )
}
fn descendants(child: &Owned, parent: &Owned) -> bool {
    let mut current = Some(child.clone());
    for _ in 0..64 {
        let Some(e) = current else { return false };
        if e == *parent {
            return true;
        }
        current = e.attr("AXParent");
    }
    false
}
fn enabled(e: &Owned) -> bool {
    e.boolean("AXEnabled").unwrap_or(false)
}
#[derive(Clone)]
struct Target {
    pid: i32,
    start: String,
    window: Owned,
    app: Owned,
    title: String,
}
#[derive(Default)]
struct Gate {
    target: Option<Target>,
    started: bool,
    settling: Option<Instant>,
}
fn scoped(t: &Target) -> Reply<Owned> {
    if !trusted() {
        return Err(fail("permissions","Accessibility permission was revoked. Enable it in System Settings before starting a new attempt."));
    }
    if process_identity(t.pid)? != t.start {
        return Err(fail("target_lost", "The selected process was replaced."));
    }
    if frontmost() != t.pid {
        return Err(fail(
            "focus_lost",
            "Focus left the selected application. Start a new attempt when ready.",
        ));
    }
    let listed = t
        .app
        .attr("AXWindows")
        .ok_or_else(|| fail("inaccessible", "Application windows cannot be inspected."))?
        .array();
    if !listed.iter().any(|e| *e == t.window) {
        return Err(fail(
            "target_lost",
            "The selected window was closed or replaced.",
        ));
    }
    let focused = t.app.attr("AXFocusedWindow").ok_or_else(|| {
        fail(
            "inaccessible",
            "The application's focused window is unavailable.",
        )
    })?;
    if focused != t.window && !(is_window(&focused) && descendants(&focused, &t.window)) {
        return Err(fail(
            "focus_lost",
            "Focus moved to a different window or unrelated dialog.",
        ));
    }
    Ok(focused)
}
pub struct Desktop {
    revoked: Arc<AtomicBool>,
    gate: Arc<Mutex<Gate>>,
    choices: HashMap<String, Target>,
    controls: HashMap<String, (Owned, Value)>,
    snapshot: String,
    serial: u64,
    observed_root: Option<Owned>,
}
impl Desktop {
    pub fn new(revoked: Arc<AtomicBool>) -> Reply<Self> {
        let gate = Arc::new(Mutex::new(Gate::default()));
        let watch: Arc<Mutex<Gate>> = gate.clone();
        let flag = revoked.clone();
        std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                let _pool = Pool::new();
                let target = watch.lock().ok().and_then(|g| {
                    if g.started || g.settling.is_some() {
                        g.target.clone()
                    } else {
                        None
                    }
                });
                if let Some(t) = target {
                    if scoped(&t).is_err() {
                        flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Ok(Self {
            revoked,
            gate,
            choices: HashMap::new(),
            controls: HashMap::new(),
            snapshot: String::new(),
            serial: 0,
            observed_root: None,
        })
    }
    fn status(&self, prompt: bool) -> Value {
        if prompt {
            ax::request_permission();
        }
        let ready = trusted();
        protocol::status(
            "macos",
            ready,
            if ready { "granted" } else { "required" },
            if ready {
                "Select one application window. Stop remains available."
            } else {
                "Allow TicketPipe’s controller in System Settings → Privacy & Security → Accessibility, then check again. Permission never starts a repair."
            },
            !ready,
            "macos",
            &allowed_keys(),
        )
    }
    fn enumerate(&mut self) -> Reply<Value> {
        if !trusted() {
            return Err(fail(
                "permissions",
                "Set up Accessibility before selecting an application.",
            ));
        }
        let mut choices = HashMap::new();
        let mut result = Vec::new();
        for (pid, label) in running() {
            if protocol::protected(&label) {
                continue;
            }
            let Ok(start) = process_identity(pid) else {
                continue;
            };
            let app = app_element(pid)?;
            let Some(windows) = app.attr("AXWindows") else {
                continue;
            };
            for window in windows.array() {
                if !is_window(&window) || window.boolean("AXMinimized") == Some(true) {
                    continue;
                }
                let title = window.label("AXTitle");
                if title.is_empty() || protocol::protected(&title) {
                    continue;
                }
                // Opaque retained AX identity. No title/PID guessing when binding.
                let id = format!("{}:{}:{}", pid, start, choices.len());
                choices.insert(
                    id.clone(),
                    Target {
                        pid,
                        start: start.clone(),
                        window,
                        app: app.clone(),
                        title: title.clone(),
                    },
                );
                result.push(json!({"id":id,"app":label,"title":title}));
            }
        }
        self.choices = choices;
        Ok(json!(result))
    }
    fn target(&self) -> Reply<Target> {
        live(&self.revoked)?;
        self.gate
            .lock()
            .map_err(|_| fail("controller_failed", "The focus guard failed."))?
            .target
            .clone()
            .ok_or_else(|| fail("unbound", "No application is selected."))
    }
    fn guard(&self) -> Reply<Owned> {
        let target = self.target()?;
        if !self.gate.lock().unwrap().started {
            return Err(fail("unbound", "Bring the selected window forward first."));
        }
        match scoped(&target) {
            Ok(root) => {
                live(&self.revoked)?;
                Ok(root)
            }
            Err(error) => {
                self.revoked.store(true, Ordering::SeqCst);
                Err(error)
            }
        }
    }
    fn focus(&mut self) -> Reply<Value> {
        let t = self.target()?;
        if process_identity(t.pid)? != t.start {
            return Err(fail("target_lost", "The selected process was replaced."));
        }
        let current = scoped(&t);
        let mut gate = self.gate.lock().unwrap();
        if let Ok(_) = current {
            let since = gate.settling.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(75) {
                gate.started = true;
                return Ok(json!({"state":"ready"}));
            }
        } else if gate.settling.is_some() {
            self.revoked.store(true, Ordering::SeqCst);
            return Err(fail(
                "focus_lost",
                "Focus left the selected window during handoff.",
            ));
        }
        Ok(json!({"state":"awaiting_focus"}))
    }
    fn bind(&mut self, id: &str) -> Reply<Value> {
        if self.gate.lock().unwrap().target.is_some() {
            return Err(fail("invalid", "A helper can bind only one attempt."));
        }
        // The picker helper remains alive through binding: retain the actual AX
        // window object instead of resolving a title or enumeration index again.
        let t = self.choices.get(id).cloned().ok_or_else(|| {
            fail(
                "target_lost",
                "The selected window changed. Refresh the window picker.",
            )
        })?;
        if !trusted() {
            return Err(fail("permissions", "Accessibility permission is required."));
        }
        if process_identity(t.pid)? != t.start
            || !t
                .app
                .attr("AXWindows")
                .is_some_and(|list| list.array().contains(&t.window))
        {
            return Err(fail(
                "target_lost",
                "The selected window was closed or replaced.",
            ));
        }
        self.gate.lock().unwrap().target = Some(t.clone());
        let source = frontmost();
        t.window.set_bool("AXMain", true);
        t.window.action("AXRaise");
        unsafe { activate(t.pid) };
        // A bounded activation settling period preserves the Windows handoff fix.
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            live(&self.revoked)?;
            let foreground = frontmost();
            if foreground != source && foreground != t.pid && foreground != 0 {
                return Err(fail(
                    "focus_lost",
                    "Focus moved elsewhere while connecting.",
                ));
            }
            let result = self.focus()?;
            if result["state"] == "ready" {
                return Ok(result);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(json!({"state":"awaiting_focus"}))
    }
    fn observe(&mut self) -> Reply<Value> {
        let root = self.guard()?;
        let t = self.target()?;
        let (nodes, truncated) = collect(&root)?;
        self.serial += 1;
        self.snapshot = format!("o{}", self.serial);
        self.controls.clear();
        let mut controls = Vec::new();
        for e in nodes {
            if let Some(mut c) = read_control(&e) {
                let reference = format!("e{}", controls.len());
                c["ref"] = json!(reference);
                self.controls.insert(reference, (e, c.clone()));
                controls.push(c);
            }
        }
        self.guard()?;
        self.observed_root = Some(root);
        Ok(
            json!({"id":self.snapshot,"title":t.title.chars().take(400).collect::<String>(),"controls":controls,"truncated":truncated}),
        )
    }
    fn act(&mut self, args: &Value) -> Reply<Value> {
        let snapshot = std::mem::take(&mut self.snapshot);
        let controls = std::mem::take(&mut self.controls);
        if snapshot.is_empty() || args["observationId"] != snapshot {
            return Err(fail("stale", "Inspect again before acting."));
        }
        let root = self.guard()?;
        if self.observed_root.as_ref() != Some(&root) {
            return Err(fail(
                "stale",
                "The selected window's dialog changed. Inspect again.",
            ));
        }
        let action = &args["action"];
        let reference = action["ref"].as_str().unwrap_or("");
        let (old_element, old) = controls
            .get(reference)
            .ok_or_else(|| fail("stale", "The requested control is unavailable."))?;
        let (nodes, _) = collect(&root)?;
        let matching: Vec<_> = nodes.iter().filter(|e| *e == old_element).collect();
        if matching.len() != 1 {
            return Err(fail(
                "stale",
                "The control was replaced or left the selected window.",
            ));
        }
        let e = matching[0];
        let mut current = read_control(e)
            .ok_or_else(|| fail("protected", "The control is inaccessible or protected."))?;
        current["ref"] = json!(reference);
        if *old != current {
            return Err(fail("stale", "The control changed. Inspect again."));
        }
        let t = self.target()?;
        protocol::validate_action(
            action,
            &current,
            &format!(
                "{} {} {}",
                t.title,
                root.label("AXTitle"),
                root.label("AXDescription")
            ),
            protocol::MAC_KEYS,
        )?;
        self.guard()?;
        live(&self.revoked)?;
        let performed = match action["kind"].as_str().unwrap_or("") {
            "activate" => e.action(
                current["nativeAction"]
                    .as_str()
                    .ok_or_else(|| fail("invalid", "No supported action is available."))?,
            ),
            "text" => e.set(
                "AXValue",
                &Owned::string(action["text"].as_str().unwrap_or("")),
            ),
            "select" => e.set_bool("AXSelected", true),
            "scroll" => e.action(if action["direction"] == "up" {
                "AXScrollUpByPage"
            } else {
                "AXScrollDownByPage"
            }),
            "keys" => {
                if !e.set_bool("AXFocused", true) {
                    return Err(fail("focus_lost", "The control could not acquire focus."));
                }
                let focused = t.app.attr("AXFocusedUIElement").ok_or_else(|| {
                    fail("inaccessible", "The focused control cannot be checked.")
                })?;
                if focused != *e {
                    return Err(fail(
                        "focus_lost",
                        "The focused control does not match the requested control.",
                    ));
                }
                let flags = unsafe { ax::CGEventSourceFlagsState(1) };
                if flags & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)) != 0 {
                    return Err(fail(
                        "protected",
                        "Release modifier keys before starting a repair.",
                    ));
                }
                let (key, command) = keycode(action["key"].as_str().unwrap_or(""))?;
                self.guard()?;
                live(&self.revoked)?;
                ax::keyboard(t.pid, key, command, || {
                    self.guard().is_ok() && !self.revoked.load(Ordering::SeqCst)
                })
            }
            _ => false,
        };
        if performed {
            Ok(json!({"performed":true}))
        } else {
            Err(protocol::uncertain(
                "The application did not acknowledge the requested operation.",
            ))
        }
    }
}
fn collect(root: &Owned) -> Reply<(Vec<Owned>, bool)> {
    let mut queue = VecDeque::from([root.clone()]);
    let mut nodes = Vec::new();
    while let Some(e) = queue.pop_front() {
        if nodes.len() >= 500 {
            return Ok((nodes, true));
        }
        if nodes.contains(&e) {
            continue;
        }
        let role = e.label("AXRole");
        let subrole = e.label("AXSubrole");
        if protocol::protected(&format!(
            "{role} {subrole} {} {}",
            e.label("AXTitle"),
            e.label("AXDescription")
        )) {
            continue;
        }
        if e.boolean("AXHidden") == Some(true) {
            continue;
        }
        for attribute in ["AXChildren", "AXSheets"] {
            if let Some(children) = e.attr(attribute) {
                let children = children.array();
                if children.len() > 1500 {
                    return Err(fail(
                        "inaccessible",
                        "This application exposes too many ambiguous controls.",
                    ));
                }
                queue.extend(children);
            }
        }
        nodes.push(e);
    }
    Ok((nodes, false))
}
fn read_control(e: &Owned) -> Option<Value> {
    let role = e.label("AXRole");
    let subrole = e.label("AXSubrole");
    // Secure fields are filtered BEFORE AXValue is requested.
    if protocol::protected(&format!("{role} {subrole}")) {
        return None;
    }
    let mut name = e.label("AXTitle");
    if name.is_empty() {
        name = e.label("AXDescription");
    }
    let id = e.label("AXIdentifier");
    if protocol::protected(&format!("{name} {id}")) {
        return None;
    }
    let editable = matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox")
        && e.settable("AXValue");
    let actions = e.actions();
    let mut allowed = Vec::new();
    let activation = actions
        .iter()
        .find(|s| ["AXPress", "AXConfirm", "AXShowMenu"].contains(&s.as_str()));
    if activation.is_some() {
        allowed.push("activate");
    }
    if editable {
        allowed.push("text");
    }
    if e.settable("AXSelected") {
        allowed.push("select");
    }
    if actions.contains(&"AXScrollUpByPage".into())
        && actions.contains(&"AXScrollDownByPage".into())
    {
        allowed.push("scroll");
    }
    if e.settable("AXFocused") {
        allowed.push("keys");
    }
    let mut c = json!({"ref":"","name":name.chars().take(400).collect::<String>(),"role":role,"automationId":id.chars().take(400).collect::<String>(),"enabled":enabled(e),"editable":editable,"actions":allowed,"allowedKeys":if allowed.contains(&"keys"){allowed_keys()}else{vec![]},"nativeAction":activation});
    if matches!(
        role.as_str(),
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXStaticText"
    ) {
        if let Some(value) = e.attr("AXValue").and_then(|v| v.text()) {
            c["value"] = json!(value.chars().take(2000).collect::<String>());
            c["valueTruncated"] = json!(value.chars().count() > 2000);
        }
    }
    if matches!(role.as_str(), "AXCheckBox" | "AXRadioButton" | "AXSwitch") {
        if let Some(value) = e.attr("AXValue").and_then(|v| v.number()) {
            if value == 0 || value == 1 {
                c["checked"] = json!(value == 1);
            }
        }
    }
    if let Some(selected) = e.boolean("AXSelected") {
        c["selected"] = json!(selected);
    }
    if name.chars().count() > 400 || id.chars().count() > 400 || c["valueTruncated"] == true {
        c["actions"] = json!([]);
        c["allowedKeys"] = json!([]);
    }
    Some(c)
}
fn keycode(key: &str) -> Reply<(u16, bool)> {
    Ok(match key {
        "ENTER" => (36, false),
        "TAB" => (48, false),
        "ESC" => (53, false),
        "SPACE" => (49, false),
        "UP" => (126, false),
        "DOWN" => (125, false),
        "LEFT" => (123, false),
        "RIGHT" => (124, false),
        "HOME" => (115, false),
        "END" => (119, false),
        "PAGEUP" => (116, false),
        "PAGEDOWN" => (121, false),
        "BACKSPACE" => (51, false),
        "CMD+A" | "CMD+F" | "CMD+S" | "CMD+R" => (
            ax::command_key(key.chars().last().unwrap().to_ascii_lowercase()).ok_or_else(|| {
                fail(
                    "inaccessible",
                    "The active keyboard layout cannot safely resolve this Command shortcut.",
                )
            })?,
            true,
        ),
        _ => return Err(fail("invalid", "Unsupported macOS key combination.")),
    })
}
impl protocol::Controller for Desktop {
    fn execute(&mut self, r: &Value) -> Reply<Value> {
        let _pool = Pool::new();
        live(&self.revoked)?;
        match r["op"].as_str().unwrap_or("") {
            "status" => Ok(self.status(false)),
            "permissions" => Ok(self.status(true)),
            "windows" => self.enumerate(),
            "bind" => self.bind(r["args"]["id"].as_str().unwrap_or("")),
            "focus" => self.focus(),
            "guard" => {
                self.guard()?;
                Ok(json!({}))
            }
            "observe" => self.observe(),
            "act" => self.act(&r["args"]),
            _ => Err(fail("invalid", "Unknown controller operation.")),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_keys_exclude_control_shortcuts() {
        for key in protocol::MAC_KEYS.iter().filter(|k| !k.starts_with("CMD+")) {
            assert!(keycode(key).is_ok());
        }
        for key in ["CTRL+A", "CMD+Q", "CMD+SPACE", "CMD+TAB"] {
            assert!(keycode(key).is_err());
        }
    }
    #[test]
    fn process_layout_matches_sdk() {
        assert_eq!(std::mem::size_of::<BsdInfo>(), 136);
    }
}

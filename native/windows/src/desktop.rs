#![allow(non_upper_case_globals)]
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    mem::size_of,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Security::*,
        System::{Com::*, Threading::*},
        UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

type Reply<T> = std::result::Result<T, Value>;
fn fail(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message,"performed":false})
}
fn uia<T>(r: windows::core::Result<T>) -> Reply<T> {
    r.map_err(|_| {
        fail(
            "inaccessible",
            "The application did not provide accessible controls.",
        )
    })
}
fn title(hwnd: HWND) -> String {
    let mut b = [0u16; 1024];
    let n = unsafe { GetWindowTextW(hwnd, &mut b) };
    String::from_utf16_lossy(&b[..n.max(0) as usize])
}
fn pid(hwnd: HWND) -> u32 {
    let mut p = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut p));
    }
    p
}
fn process_info(hwnd: HWND) -> Reply<(u32, u64, String)> {
    unsafe {
        let p = pid(hwnd);
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, p)
            .map_err(|_| fail("unavailable", "The window process is unavailable."))?;
        let result = (|| {
            let mut token = HANDLE::default();
            uia(OpenProcessToken(h, TOKEN_QUERY, &mut token))?;
            let mut elevation = TOKEN_ELEVATION::default();
            let mut returned = 0;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as _),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            let _ = CloseHandle(token);
            uia(ok)?;
            if elevation.TokenIsElevated != 0 {
                return Err(fail(
                    "elevated",
                    "Administrator windows require your intervention.",
                ));
            }
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            uia(GetProcessTimes(
                h,
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            ))?;
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            uia(QueryFullProcessImageNameW(
                h,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            ))?;
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            let exe = path.rsplit('\\').next().unwrap_or(&path).to_string();
            let lower = exe.to_lowercase();
            if [
                "cmd.exe",
                "powershell.exe",
                "pwsh.exe",
                "windowsterminal.exe",
                "conhost.exe",
                "regedit.exe",
                "consent.exe",
                "credentialuibroker.exe",
                "chatgpt.exe",
                "codex.exe",
                "codex-computer-use.exe",
                "keepass.exe",
                "1password.exe",
                "bitwarden.exe",
                "sechealthui.exe",
            ]
            .contains(&lower.as_str())
            {
                return Err(fail(
                    "protected",
                    "Terminals, credentials and protected system windows cannot be controlled.",
                ));
            }
            Ok((
                p,
                ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
                exe,
            ))
        })();
        let _ = CloseHandle(h);
        result
    }
}
fn identity(hwnd: HWND) -> Reply<(String, String)> {
    let (p, c, app) = process_info(hwnd)?;
    Ok((format!("{}:{p}:{c}", hwnd.0 as usize), app))
}
fn allowed_title(value: &str) -> bool {
    let t = value.to_lowercase();
    !t.is_empty()
        && !t.contains("ticketpipe")
        && t != "program manager"
        && t != "windows shell experience host"
}

unsafe extern "system" fn enumerate(hwnd: HWND, data: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return true.into();
    }
    let name = title(hwnd);
    if !allowed_title(&name) {
        return true.into();
    }
    if let Ok((id, app)) = identity(hwnd) {
        let out = &mut *(data.0 as *mut Vec<Value>);
        out.push(json!({"id":id,"title":name,"app":app}));
    }
    true.into()
}

struct Saved {
    element: IUIAutomationElement,
    fingerprint: String,
    control: Value,
}
#[derive(Default)]
struct Guard {
    target: Option<(usize, String)>,
    failure: Option<Value>,
}
fn foreground_root() -> HWND {
    unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) }
}
fn check_scope(hwnd: HWND, expected: &str) -> Reply<HWND> {
    check_scope_at(hwnd, expected, foreground_root())
}
fn check_scope_at(hwnd: HWND, expected: &str, fg: HWND) -> Reply<HWND> {
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } || identity(hwnd)?.0 != expected {
        return Err(fail(
            "target_lost",
            "The selected window or its process changed.",
        ));
    }
    if fg != hwnd && !(unsafe { GetAncestor(fg, GA_ROOTOWNER) } == hwnd && pid(fg) == pid(hwnd)) {
        return Err(fail(
            "focus_lost",
            "Focus moved away from the selected application. Start a new attempt when ready.",
        ));
    }
    process_info(fg)?;
    Ok(fg)
}

#[derive(Clone, Copy)]
enum ActivationFocus {
    Source,
    Target,
    Other,
}
#[derive(Default)]
struct ActivationGate {
    selected_since: Option<Duration>,
}
impl ActivationGate {
    fn poll(&mut self, elapsed: Duration, focus: ActivationFocus) -> Reply<bool> {
        match focus {
            ActivationFocus::Other => return Err(fail("focus_lost", "Focus moved to another application while connecting. Start a new attempt when ready.")),
            ActivationFocus::Source if self.selected_since.is_some() => return Err(fail("focus_lost", "Focus moved away from the selected application. Start a new attempt when ready.")),
            _ => {}
        }
        if elapsed >= Duration::from_secs(1) {
            return Err(fail("activation_failed", "Windows did not finish activating the selected application. Select its window and try again."));
        }
        if let ActivationFocus::Target = focus {
            let since = *self.selected_since.get_or_insert(elapsed);
            return Ok(elapsed.saturating_sub(since) >= Duration::from_millis(75));
        }
        Ok(false)
    }
}
pub struct Desktop {
    automation: IUIAutomation,
    revoked: Arc<AtomicBool>,
    guard: Arc<Mutex<Guard>>,
    bound: Option<(HWND, String)>,
    observed_root: HWND,
    observation: String,
    controls: HashMap<String, Saved>,
    sequence: u64,
}
impl Desktop {
    pub fn new(revoked: Arc<AtomicBool>) -> Reply<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let automation =
            unsafe { uia(CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))? };
        let guard = Arc::new(Mutex::new(Guard::default()));
        let monitor = guard.clone();
        let flag = revoked.clone();
        // Revocation remains responsive even while a third-party UIA provider is blocked.
        std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                let target = monitor.lock().ok().and_then(|g| g.target.clone());
                if let Some((raw, expected)) = target {
                    if let Err(error) = check_scope(HWND(raw as _), &expected) {
                        if let Ok(mut g) = monitor.lock() {
                            g.failure = Some(error);
                        }
                        flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Ok(Self {
            automation,
            revoked,
            guard,
            bound: None,
            observed_root: HWND::default(),
            observation: String::new(),
            controls: HashMap::new(),
            sequence: 0,
        })
    }
    fn active(&self) -> Reply<HWND> {
        if self.revoked.load(Ordering::SeqCst) {
            return Err(self
                .guard
                .lock()
                .ok()
                .and_then(|g| g.failure.clone())
                .unwrap_or_else(|| fail("cancelled", "Automatic control was stopped.")));
        }
        let Some((hwnd, expected)) = &self.bound else {
            return Err(fail("unbound", "Choose an application window first."));
        };
        check_scope(*hwnd, expected)
    }
    fn wait_for_activation(&self, hwnd: HWND, expected: &str, source: HWND) -> Reply<()> {
        let started = Instant::now();
        let mut gate = ActivationGate::default();
        loop {
            if self.revoked.load(Ordering::SeqCst) {
                return Err(fail("cancelled", "Automatic control was stopped."));
            }
            // SetForegroundWindow can return before the target handles activation.
            // Wait only for this initial handoff; no UI input or refocusing occurs here.
            let foreground = foreground_root();
            let focus = match check_scope_at(hwnd, expected, foreground) {
                Ok(_) => ActivationFocus::Target,
                Err(error) if error["code"] == "focus_lost" => {
                    if foreground == source || foreground.0.is_null() {
                        ActivationFocus::Source
                    } else {
                        ActivationFocus::Other
                    }
                }
                Err(error) => return Err(error),
            };
            if gate.poll(started.elapsed(), focus)? {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    pub fn execute(&mut self, request: &Value) -> Reply<Value> {
        match request["op"].as_str().unwrap_or("") {
            "windows" => {
                let mut list: Vec<Value> = Vec::new();
                unsafe {
                    uia(EnumWindows(
                        Some(enumerate),
                        LPARAM(&mut list as *mut _ as isize),
                    ))?;
                }
                Ok(json!(list))
            }
            "bind" => {
                if self.bound.is_some() || self.revoked.load(Ordering::SeqCst) {
                    return Err(fail("cancelled", "A controller can bind only once."));
                }
                let id = request["args"]["id"]
                    .as_str()
                    .ok_or_else(|| fail("invalid", "Invalid window identity."))?;
                let raw = id
                    .split(':')
                    .next()
                    .and_then(|s| s.parse::<usize>().ok())
                    .ok_or_else(|| fail("invalid", "Invalid window identity."))?;
                let hwnd = HWND(raw as _);
                if identity(hwnd)?.0 != id
                    || !allowed_title(&title(hwnd))
                    || !unsafe { IsWindowVisible(hwnd).as_bool() }
                {
                    return Err(fail(
                        "target_lost",
                        "The selected window is no longer eligible.",
                    ));
                }
                self.bound = Some((hwnd, id.to_string()));
                let source = foreground_root();
                unsafe {
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                    let requested = SetForegroundWindow(hwnd).as_bool();
                    if !requested {
                        // UIA providers can focus their own window when the background
                        // web server has no foreground activation permission.
                        if let Ok(root) = self.automation.ElementFromHandle(hwnd) {
                            let _ = root.SetFocus();
                        }
                    }
                    if !requested && foreground_root() != hwnd {
                        let foreground = foreground_root();
                        if foreground != source
                            && !foreground.0.is_null()
                            && check_scope_at(hwnd, id, foreground).is_err()
                        {
                            return Err(fail("focus_lost", "Focus moved to another application while connecting. Start a new attempt when ready."));
                        }
                        // This is only the initial, explicit target selection. Never
                        // reacquire focus during an active attempt or inject a global key.
                        let current = GetCurrentThreadId();
                        let foreground = GetWindowThreadProcessId(GetForegroundWindow(), None);
                        if foreground != 0
                            && foreground != current
                            && AttachThreadInput(current, foreground, true).as_bool()
                        {
                            let _ = SetForegroundWindow(hwnd);
                            let _ = AttachThreadInput(current, foreground, false);
                        }
                    }
                }
                self.wait_for_activation(hwnd, id, source)?;
                self.active()?;
                if let Ok(mut g) = self.guard.lock() {
                    g.target = Some((raw, id.to_string()));
                }
                Ok(json!({}))
            }
            "observe" => self.observe(),
            "guard" => {
                self.active()?;
                Ok(json!({}))
            }
            "act" => self.act(&request["args"]),
            _ => Err(fail("invalid", "Unknown controller operation.")),
        }
    }
    fn observe(&mut self) -> Reply<Value> {
        let root_hwnd = self.active()?;
        let root = unsafe { uia(self.automation.ElementFromHandle(root_hwnd))? };
        let all = unsafe {
            uia(root.FindAll(
                TreeScope_Subtree,
                &uia(self.automation.CreateTrueCondition())?,
            ))?
        };
        let count = unsafe { uia(all.Length())? };
        let mut controls = Vec::new();
        self.controls.clear();
        let mut truncated = count > 500;
        for i in 0..count.min(500) {
            let Ok(element) = (unsafe { all.GetElement(i) }) else {
                truncated = true;
                continue;
            };
            match inspect(&element) {
                Ok((mut info, fingerprint)) => {
                    let reference = format!("e{}", controls.len());
                    info["ref"] = json!(reference);
                    controls.push(info.clone());
                    self.controls.insert(
                        reference,
                        Saved {
                            element,
                            fingerprint,
                            control: info,
                        },
                    );
                }
                Err(error) => {
                    if error["code"] == "inaccessible" {
                        truncated = true;
                    }
                }
            }
        }
        self.active()?;
        self.sequence += 1;
        self.observation = format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            self.sequence
        );
        self.observed_root = root_hwnd;
        Ok(
            json!({"id":self.observation,"title":title(root_hwnd),"controls":controls,"truncated":truncated}),
        )
    }
    fn act(&mut self, args: &Value) -> Reply<Value> {
        let observation = std::mem::take(&mut self.observation);
        if observation.is_empty() || args["observationId"].as_str() != Some(&observation) {
            return Err(fail(
                "stale",
                "The observation was already consumed. Observe again.",
            ));
        }
        let action = &args["action"];
        let reference = action["ref"].as_str().unwrap_or("");
        let saved = self
            .controls
            .remove(reference)
            .ok_or_else(|| fail("stale", "Unknown control reference."))?;
        self.controls.clear();
        let root_hwnd = self.active()?;
        if root_hwnd != self.observed_root {
            return Err(fail(
                "stale",
                "An application dialog changed. Observe again.",
            ));
        }
        // Resolve against the CURRENT subtree, not a cached rectangle or stale COM provider.
        let root = unsafe { uia(self.automation.ElementFromHandle(root_hwnd))? };
        let nodes = unsafe {
            uia(root.FindAll(
                TreeScope_Subtree,
                &uia(self.automation.CreateTrueCondition())?,
            ))?
        };
        let mut live = None;
        for i in 0..unsafe { uia(nodes.Length())? }.min(1000) {
            let el = unsafe { uia(nodes.GetElement(i))? };
            if unsafe { uia(self.automation.CompareElements(&saved.element, &el))? }.as_bool() {
                live = Some(el);
                break;
            }
        }
        let element = live.ok_or_else(|| fail("stale", "The requested control disappeared."))?;
        let (current, fingerprint) = inspect(&element)?;
        if fingerprint != saved.fingerprint || current["enabled"] != true {
            return Err(fail(
                "stale",
                "The requested control changed. Observe again.",
            ));
        }
        let kind = action["kind"].as_str().unwrap_or("");
        if !saved.control["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == kind))
        {
            return Err(fail(
                "protected",
                "This action is unavailable on this control.",
            ));
        }
        if hazardous(current["name"].as_str().unwrap_or(""))
            || hazardous(current["automationId"].as_str().unwrap_or(""))
            || hazardous(&title(root_hwnd))
        {
            return Err(fail(
                "protected",
                "This control requires your intervention.",
            ));
        }
        self.active()?;
        let operation = unsafe {
            match kind {
                "activate" => {
                    if let Ok(p) = element
                        .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    {
                        self.active()?;
                        p.Toggle()
                    } else if let Ok(p) = element
                        .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                            UIA_ExpandCollapsePatternId,
                        )
                    {
                        let expanded =
                            uia(p.CurrentExpandCollapseState())? == ExpandCollapseState_Expanded;
                        self.active()?;
                        if expanded {
                            p.Collapse()
                        } else {
                            p.Expand()
                        }
                    } else {
                        let p = uia(element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(
                            UIA_InvokePatternId,
                        ))?;
                        self.active()?;
                        p.Invoke()
                    }
                }
                "select" => {
                    let p = uia(
                        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                            UIA_SelectionItemPatternId,
                        ),
                    )?;
                    self.active()?;
                    p.Select()
                }
                "text" => {
                    let text = action["text"]
                        .as_str()
                        .ok_or_else(|| fail("invalid", "Missing text."))?;
                    if current["editable"] != true || text.len() > 8000 || command_text(text) {
                        return Err(fail(
                            "protected",
                            "This text entry requires your intervention.",
                        ));
                    }
                    let p = uia(element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId))?;
                    self.active()?;
                    p.SetValue(&BSTR::from(text))
                }
                "scroll" => {
                    let amount = match action["direction"].as_str() {
                        Some("up") => ScrollAmount_SmallDecrement,
                        Some("down") => ScrollAmount_SmallIncrement,
                        _ => return Err(fail("invalid", "Invalid scroll direction.")),
                    };
                    let p = uia(element
                        .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId))?;
                    self.active()?;
                    p.Scroll(ScrollAmount_NoAmount, amount)
                }
                "keys" => {
                    let key = action["key"].as_str().unwrap_or("");
                    if ["CTRL+A", "BACKSPACE"].contains(&key) && current["editable"] != true {
                        return Err(fail("protected", "This shortcut needs an editable field."));
                    }
                    let events = key_events(key)?;
                    uia(element.SetFocus())?;
                    let focused = uia(self.automation.GetFocusedElement())?;
                    if !uia(self.automation.CompareElements(&focused, &element))?.as_bool() {
                        return Err(fail(
                            "stale",
                            "The requested control did not receive focus.",
                        ));
                    }
                    let (focused_info, _) = inspect(&focused)?;
                    if hazardous(focused_info["name"].as_str().unwrap_or("")) {
                        return Err(fail("protected", "The focused field is protected."));
                    }
                    self.active()?;
                    if [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
                        .iter()
                        .any(|key| GetAsyncKeyState(key.0 as i32) < 0)
                    {
                        return Err(fail(
                            "input_busy",
                            "Release the keyboard modifiers before starting another attempt.",
                        ));
                    }
                    let n = SendInput(&events, size_of::<INPUT>() as i32);
                    if n != events.len() as u32 {
                        let releases: Vec<INPUT> = events
                            .iter()
                            .filter(|input| input.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP))
                            .copied()
                            .collect();
                        let _ = SendInput(&releases, size_of::<INPUT>() as i32);
                        return Err(
                            json!({"code":"input_failed","message":"Windows could not confirm all input events.","performed":null}),
                        );
                    }
                    Ok(())
                }
                _ => return Err(fail("invalid", "Unsupported action.")),
            }
        };
        operation.map_err(|_| json!({"code":"action_uncertain","message":"The app did not acknowledge the action; its effect is uncertain.","performed":null}))?;
        Ok(json!({"performed":true}))
    }
}

fn hazardous(text: &str) -> bool {
    let t = text.to_lowercase();
    [
        "delete",
        "erase",
        "uninstall",
        "shutdown",
        "shut down",
        "reboot",
        "discard",
        "factory reset",
        "password",
        "credential",
        "terminal",
        "console",
        "powershell",
        "command prompt",
        "administrator",
        "publish",
        "payment",
        "purchase",
        "security",
        "privacy",
        "permission",
        "sign in",
        "log in",
        "api key",
        "type a message",
        "supprimer",
        "effacer",
        "désinstaller",
        "contraseña",
        "eliminar",
        "borrar",
        "desinstalar",
    ]
    .iter()
    .any(|s| t.contains(s))
        || t.split(|c: char| !c.is_alphanumeric()).any(|word| {
            [
                "send", "pay", "buy", "install", "format", "run", "execute", "debug", "evaluate",
                "macro", "token", "envoyer", "enviar",
            ]
            .contains(&word)
        })
}
fn command_text(text: &str) -> bool {
    let t = text.to_lowercase();
    [
        "javascript:",
        "data:",
        "file:",
        "[redacted_",
        "powershell",
        ".exe",
        ".bat",
        ".cmd",
        ".ps1",
        ".vbs",
        "pwsh",
        "invoke-expression",
        "start-process",
        "shell:",
        "ms-settings:",
        "<script",
        "eval(",
        "exec(",
        "subprocess.",
        "process.",
    ]
    .iter()
    .any(|s| t.contains(s))
        || t.lines().any(|l| {
            [
                "curl ",
                "wget ",
                "rm ",
                "del ",
                "reg ",
                "schtasks ",
                "shutdown ",
                "npm ",
                "npx ",
                "bun ",
                "python ",
                "node ",
            ]
            .iter()
            .any(|s| l.trim_start().starts_with(s))
        })
}
fn role(id: UIA_CONTROLTYPE_ID) -> String {
    match id {
        UIA_ButtonControlTypeId => "button",
        UIA_CheckBoxControlTypeId => "checkbox",
        UIA_ComboBoxControlTypeId => "combobox",
        UIA_EditControlTypeId => "edit",
        UIA_TextControlTypeId => "text",
        UIA_ListItemControlTypeId => "listitem",
        UIA_MenuItemControlTypeId => "menuitem",
        UIA_RadioButtonControlTypeId => "radio",
        UIA_WindowControlTypeId => "window",
        UIA_DocumentControlTypeId => "document",
        UIA_PaneControlTypeId => "pane",
        UIA_TabItemControlTypeId => "tab",
        UIA_ScrollBarControlTypeId => "scrollbar",
        _ => return format!("control-{}", id.0),
    }
    .to_string()
}
fn inspect(element: &IUIAutomationElement) -> Reply<(Value, String)> {
    unsafe {
        if uia(element.CurrentIsPassword())?.as_bool()
            || uia(element.CurrentIsOffscreen())?.as_bool()
        {
            return Err(fail("protected", "Protected or hidden control."));
        }
        let name = uia(element.CurrentName())?.to_string();
        let automation_id = uia(element.CurrentAutomationId())?.to_string();
        let control_role = role(uia(element.CurrentControlType())?);
        let enabled = uia(element.CurrentIsEnabled())?.as_bool();
        let mut info = json!({"name":name.chars().take(400).collect::<String>(),"role":control_role,"automationId":automation_id,"enabled":enabled,"editable":false,"actions":[]});
        let mut actions = Vec::new();
        let mut full_value = String::new();
        if element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .is_ok()
            || element
                .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )
                .is_ok()
        {
            actions.push("activate");
        }
        if let Ok(p) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            full_value = uia(p.CurrentValue())?.to_string();
            info["value"] = json!(full_value.chars().take(2000).collect::<String>());
            info["valueTruncated"] = json!(full_value.chars().count() > 2000);
            let editable = ["edit", "combobox", "document"].contains(&control_role.as_str())
                && !uia(p.CurrentIsReadOnly())?.as_bool();
            info["editable"] = json!(editable);
            if editable {
                actions.push("text");
            }
        }
        if let Ok(p) =
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        {
            let state = uia(p.CurrentToggleState())?;
            if state != ToggleState_Indeterminate {
                info["checked"] = json!(state == ToggleState_On);
            }
            actions.push("activate");
        }
        if let Ok(p) = element
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        {
            info["selected"] = json!(uia(p.CurrentIsSelected())?.as_bool());
            actions.push("select");
        }
        if element
            .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
            .is_ok()
        {
            actions.push("scroll");
        }
        if uia(element.CurrentIsKeyboardFocusable())?.as_bool() || control_role == "window" {
            actions.push("keys");
        }
        actions.sort();
        actions.dedup();
        info["actions"] = json!(actions);
        let fingerprint =
            json!({"control":info,"fullName":name,"fullValue":full_value}).to_string();
        Ok((info, fingerprint))
    }
}
fn key_events(key: &str) -> Reply<Vec<INPUT>> {
    let (ctrl, code): (bool, VIRTUAL_KEY) = match key {
        "ENTER" => (false, VK_RETURN),
        "TAB" => (false, VK_TAB),
        "ESC" => (false, VK_ESCAPE),
        "SPACE" => (false, VK_SPACE),
        "UP" => (false, VK_UP),
        "DOWN" => (false, VK_DOWN),
        "LEFT" => (false, VK_LEFT),
        "RIGHT" => (false, VK_RIGHT),
        "HOME" => (false, VK_HOME),
        "END" => (false, VK_END),
        "PAGEUP" => (false, VK_PRIOR),
        "PAGEDOWN" => (false, VK_NEXT),
        "BACKSPACE" => (false, VK_BACK),
        "F5" => (false, VK_F5),
        "CTRL+A" => (true, VIRTUAL_KEY(0x41)),
        "CTRL+F" => (true, VIRTUAL_KEY(0x46)),
        "CTRL+S" => (true, VIRTUAL_KEY(0x53)),
        "CTRL+R" => (true, VIRTUAL_KEY(0x52)),
        _ => return Err(fail("protected", "This key combination is not allowed.")),
    };
    let event = |vk, up| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                ..Default::default()
            },
        },
    };
    let mut out = Vec::new();
    if ctrl {
        out.push(event(VK_CONTROL, false));
    }
    out.push(event(code, false));
    out.push(event(code, true));
    if ctrl {
        out.push(event(VK_CONTROL, true));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn waits_for_asynchronous_initial_activation() {
        let mut gate = ActivationGate::default();
        assert!(!gate.poll(Duration::ZERO, ActivationFocus::Source).unwrap());
        assert!(!gate
            .poll(Duration::from_millis(7), ActivationFocus::Target)
            .unwrap());
        assert!(!gate
            .poll(Duration::from_millis(50), ActivationFocus::Target)
            .unwrap());
        assert!(gate
            .poll(Duration::from_millis(82), ActivationFocus::Target)
            .unwrap());
    }
    #[test]
    fn activation_wait_is_bounded() {
        let mut gate = ActivationGate::default();
        assert!(!gate
            .poll(Duration::from_millis(999), ActivationFocus::Source)
            .unwrap());
        assert_eq!(
            gate.poll(Duration::from_secs(1), ActivationFocus::Source)
                .unwrap_err()["code"],
            "activation_failed"
        );
    }
    #[test]
    fn startup_never_ignores_an_unrelated_window() {
        let mut gate = ActivationGate::default();
        assert_eq!(
            gate.poll(Duration::from_millis(7), ActivationFocus::Other)
                .unwrap_err()["code"],
            "focus_lost"
        );
    }
    #[test]
    fn startup_never_reacquires_a_target_after_focus_loss() {
        let mut gate = ActivationGate::default();
        assert!(!gate.poll(Duration::ZERO, ActivationFocus::Target).unwrap());
        assert_eq!(
            gate.poll(Duration::from_millis(7), ActivationFocus::Source)
                .unwrap_err()["code"],
            "focus_lost"
        );
    }
    #[test]
    fn refuses_commands_and_masked_values() {
        for s in [
            "javascript:alert(1)",
            "powershell -c x",
            "[REDACTED_PASSWORD]",
            "node script.js",
        ] {
            assert!(command_text(s));
        }
        assert!(!command_text("Everyday setting"));
    }
    #[test]
    fn refuses_global_keys() {
        for k in ["WIN+R", "ALT+F4", "CTRL+ALT+DELETE", "DELETE"] {
            assert!(key_events(k).is_err());
        }
        assert!(key_events("CTRL+F").is_ok());
    }
    #[test]
    fn protected_controls() {
        assert!(hazardous("Delete account"));
        assert!(hazardous("Password"));
        assert!(!hazardous("All tasks"));
    }
}

//! Private, versioned JSON-lines transport. Cancellation bypasses a blocked provider.
#![allow(dead_code)] // Backend-specific policies and allowlists share this module.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};
pub type Reply<T> = Result<T, Value>;
pub const VERSION: u64 = 1;
pub const KEYS: &[&str] = &[
    "ENTER",
    "TAB",
    "ESC",
    "SPACE",
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "HOME",
    "END",
    "PAGEUP",
    "PAGEDOWN",
    "CTRL+A",
    "CTRL+F",
    "CTRL+S",
    "CTRL+R",
    "F5",
    "BACKSPACE",
];
pub const MAC_KEYS: &[&str] = &[
    "ENTER",
    "TAB",
    "ESC",
    "SPACE",
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "HOME",
    "END",
    "PAGEUP",
    "PAGEDOWN",
    "CMD+A",
    "CMD+F",
    "CMD+S",
    "CMD+R",
    "BACKSPACE",
];
pub fn fail(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message,"performed":false})
}
pub fn uncertain(message: &str) -> Value {
    json!({"code":"controller_failed","message":message,"performed":null})
}
pub fn live(revoked: &AtomicBool) -> Reply<()> {
    if revoked.load(Ordering::SeqCst) {
        Err(fail(
            "cancelled",
            "Automatic control was revoked. Start a new attempt.",
        ))
    } else {
        Ok(())
    }
}
pub fn status(
    platform: &str,
    ready: bool,
    permissions: &str,
    reason: &str,
    setup: bool,
    session: &str,
    keys: &[&str],
) -> Value {
    json!({"protocol":VERSION,"platform":platform,"ready":ready,"permissions":permissions,"reason":reason,"setup":setup,"session":session,"supportedActions":if keys.is_empty(){vec!["activate","text","select","scroll"]}else{vec!["activate","text","select","scroll","keys"]},"allowedKeys":keys})
}
pub fn protected(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "password",
        "secure",
        "credential",
        "terminal",
        "console",
        "powershell",
        "command prompt",
        "1password",
        "bitwarden",
        "keepass",
        "codex",
        "chatgpt",
        "ticketpipe",
        "administrator",
        "authentication",
        "keychain",
        "seahorse",
        "ptyxis",
        "konsole",
        "xterm",
        "alacritty",
        "kitty",
        "wezterm",
        "iterm",
        "ghostty",
    ]
    .iter()
    .any(|s| lower.contains(s))
}
pub fn safe_control(value: &str) -> bool {
    let lower = value.to_lowercase();
    !protected(value)
        && ![
            "delete",
            "erase",
            "format",
            "uninstall",
            "shutdown",
            "shut down",
            "reboot",
            "discard",
            "remove account",
            "reset all",
            "factory reset",
            "send",
            "publish",
            "payment",
            "purchase",
            "buy",
            "install",
            "run",
            "restart computer",
            "execute",
            "debug",
            "evaluate",
            "macro",
            "security",
            "privacy",
            "permission",
            "sign in",
            "log in",
            "api key",
            "token",
            "type a message",
            "supprimer",
            "effacer",
            "désinstaller",
            "envoyer",
            "administrateur",
            "contraseña",
            "eliminar",
            "borrar",
            "desinstalar",
            "enviar",
        ]
        .iter()
        .any(|s| {
            lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == *s)
                || (s.contains(' ') && lower.contains(s))
        })
}
pub fn safe_text(value: &str) -> bool {
    let lower = value.to_lowercase();
    value.len() <= 8000
        && value.chars().count() <= 2000
        && !value.contains('\0')
        && ![
            "javascript:",
            "data:",
            "file:",
            "[redacted_",
            "<script",
            ".exe",
            ".bat",
            ".cmd",
            ".ps1",
            ".vbs",
            "powershell",
            "pwsh",
            "invoke-expression",
            "start-process",
            "shell:",
            "ms-settings:",
            "eval(",
            "exec(",
            "subprocess.",
            "process.",
            "#!/",
        ]
        .iter()
        .any(|s| lower.contains(s))
        && !lower.lines().any(|line| {
            [
                "curl", "wget", "rm", "del", "reg", "schtasks", "shutdown", "npm", "npx", "bun",
                "python", "node", "sudo", "sh", "bash",
            ]
            .contains(&line.split_whitespace().next().unwrap_or(""))
        })
}
pub fn validate_action(action: &Value, control: &Value, title: &str, keys: &[&str]) -> Reply<()> {
    let kind = action["kind"].as_str().unwrap_or("");
    if control["enabled"] != true
        || !control["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == kind))
        || !safe_control(&format!(
            "{} {} {}",
            control["name"].as_str().unwrap_or(""),
            control["automationId"].as_str().unwrap_or(""),
            title
        ))
    {
        return Err(fail(
            "protected",
            "This control does not support a safe repair action.",
        ));
    }
    match kind {
        "activate" | "select" => {}
        "text" if control["editable"] == true && action["text"].as_str().is_some_and(safe_text) => {
        }
        "keys"
            if action["key"].as_str().is_some_and(|key| {
                keys.contains(&key)
                    && control["allowedKeys"]
                        .as_array()
                        .is_some_and(|allowed| allowed.iter().any(|v| v == key))
                    && (!["BACKSPACE", "CTRL+A", "CMD+A"].contains(&key)
                        || control["editable"] == true)
            }) => {}
        "scroll" if matches!(action["direction"].as_str(), Some("up" | "down")) => {}
        _ => return Err(fail("invalid", "Unsupported or protected action.")),
    }
    Ok(())
}
pub trait Controller {
    fn execute(&mut self, request: &Value) -> Reply<Value>;
}
pub fn serve<D: Controller + 'static>(
    create: impl FnOnce(Arc<AtomicBool>) -> Reply<D> + Send + 'static,
) {
    let revoked = Arc::new(AtomicBool::new(false));
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let (tx, rx) = mpsc::channel::<Value>();
    let flag = revoked.clone();
    let out = output.clone();
    std::thread::spawn(move || {
        let mut desktop = create(flag.clone());
        for request in rx {
            let result = if matches!(request["op"].as_str(), Some("status" | "permissions"))
                && request["args"]["protocol"].as_u64() != Some(VERSION)
            {
                Err(fail("incompatible", "Incompatible controller protocol."))
            } else if flag.load(Ordering::SeqCst) {
                Err(fail("cancelled", "Control was revoked."))
            } else {
                desktop
                    .as_mut()
                    .map_err(|e| e.clone())
                    .and_then(|d| d.execute(&request))
            };
            let reply = match result {
                Ok(value) => json!({"id":request["id"],"ok":true,"result":value}),
                Err(error) => json!({"id":request["id"],"ok":false,"error":error}),
            };
            if let Ok(mut writer) = out.lock() {
                let _ = writeln!(writer, "{}", reply);
                let _ = writer.flush();
            }
        }
    });
    // Bound the allocation as well as the accepted frame length.
    let mut reader = std::io::stdin().lock();
    loop {
        let mut bytes = Vec::new();
        if (&mut reader)
            .take(65538)
            .read_until(b'\n', &mut bytes)
            .is_err()
            || bytes.is_empty()
            || bytes.len() > 65536
            || !bytes.ends_with(b"\n")
        {
            break;
        }
        let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        if !request["id"].is_u64() || !request["op"].is_string() {
            break;
        }
        if request["op"] == "cancel" {
            revoked.store(true, Ordering::SeqCst);
            if let Ok(mut writer) = output.lock() {
                let _ = writeln!(
                    writer,
                    "{}",
                    json!({"id":request["id"],"ok":true,"result":{}})
                );
                let _ = writer.flush();
            }
        } else if tx.send(request).is_err() {
            break;
        }
    }
    revoked.store(true, Ordering::SeqCst);
    std::process::exit(0);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policies_reject_protected_and_scripts() {
        for s in [
            "Password",
            "Terminal",
            "Delete document",
            "Send message",
            "Security",
        ] {
            assert!(!safe_control(s));
        }
        for s in [
            "sudo reboot",
            "javascript:alert(1)",
            "curl https://example.com",
            "[REDACTED_KEY]",
        ] {
            assert!(!safe_text(s));
        }
        assert!(safe_text("oranges"));
    }
    #[test]
    fn keys_require_advertised_capability() {
        let c = json!({"enabled":true,"actions":["keys"],"allowedKeys":[],"name":"Search","editable":true});
        assert!(
            validate_action(&json!({"kind":"keys","key":"CTRL+A"}), &c, "Document", KEYS).is_err()
        );
    }
}

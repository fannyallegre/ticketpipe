#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
mod desktop;
#[path = "../../common/protocol.rs"]
mod protocol;
#[cfg(windows)]
impl protocol::Controller for desktop::Desktop {
    fn execute(&mut self, request: &serde_json::Value) -> protocol::Reply<serde_json::Value> {
        match request["op"].as_str() {
            Some("status" | "permissions") => Ok(protocol::status(
                "windows",
                true,
                "granted",
                "Select one application window. Stop remains available.",
                false,
                "windows",
                protocol::KEYS,
            )),
            Some("focus") => {
                self.execute(&serde_json::json!({"op":"guard"}))?;
                Ok(serde_json::json!({"state":"ready"}))
            }
            _ => {
                let result = self.execute(request)?;
                if request["op"] == "bind" {
                    Ok(serde_json::json!({"state":"ready"}))
                } else {
                    Ok(result)
                }
            }
        }
    }
}
#[cfg(windows)]
fn main() {
    protocol::serve(desktop::Desktop::new);
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Build this controller on Windows.");
}

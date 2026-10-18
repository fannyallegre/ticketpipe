mod desktop;
#[path = "../../common/protocol.rs"]
mod protocol;
fn main() {
    protocol::serve(desktop::Desktop::new);
}

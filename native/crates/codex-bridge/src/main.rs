use bridge_protocol::BRIDGE_PROTOCOL_VERSION;
use bridge_protocol::OFFICIAL_CODEX_VERSION;
use bridge_protocol::OFFICIAL_SOURCE_COMMIT;

fn main() {
    if std::env::args().any(|argument| argument == "--version") {
        println!(
            "codex-bridge 0.0.0 (protocol {BRIDGE_PROTOCOL_VERSION}, codex {OFFICIAL_CODEX_VERSION}, source {OFFICIAL_SOURCE_COMMIT})"
        );
        return;
    }

    eprintln!("codex-bridge runtime is not implemented in the 0.0.0 skeleton");
    std::process::exit(64);
}

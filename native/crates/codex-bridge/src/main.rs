use std::io;
use std::process::ExitCode;

use bridge_protocol::BRIDGE_PROTOCOL_VERSION;
use bridge_protocol::OFFICIAL_CODEX_VERSION;
use bridge_protocol::OFFICIAL_SOURCE_COMMIT;

mod api;
mod official;
mod remote_compaction_v2;
mod runtime;

const BUILD_TARGET: &str = env!("CODEX_BRIDGE_BUILD_TARGET");
const BUILD_SOURCE_COMMIT: &str = env!("CODEX_BRIDGE_BUILD_SOURCE_COMMIT");
const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let mut arguments = std::env::args();
    let _executable = arguments.next();

    match (arguments.next().as_deref(), arguments.next()) {
        (Some("--version"), None) => {
            println!(
                "codex-bridge {PACKAGE_VERSION} (protocol {BRIDGE_PROTOCOL_VERSION}, codex {OFFICIAL_CODEX_VERSION}, source {OFFICIAL_SOURCE_COMMIT}, target {BUILD_TARGET}, build {BUILD_SOURCE_COMMIT})"
            );
            ExitCode::SUCCESS
        }
        (Some("serve"), None) => match serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("codex-bridge terminated: {error}");
                ExitCode::from(74)
            }
        },
        _ => {
            eprintln!("usage: codex-bridge --version | codex-bridge serve");
            ExitCode::from(64)
        }
    }
}

fn serve() -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(runtime::serve(
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        runtime::BuildIdentity {
            target: BUILD_TARGET.to_owned(),
            source_commit: BUILD_SOURCE_COMMIT.to_owned(),
        },
    ))
}

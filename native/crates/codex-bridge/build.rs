use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=PI_CODEX_ADAPTOR_SOURCE_COMMIT");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");

    let target = env::var("TARGET").expect("Cargo must provide TARGET to the build script");
    let source_commit = env::var("PI_CODEX_ADAPTOR_SOURCE_COMMIT")
        .or_else(|_| env::var("GITHUB_SHA"))
        .unwrap_or_else(|_| "development".to_owned());

    assert!(
        source_commit == "development"
            || (source_commit.len() == 40
                && source_commit
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))),
        "project source commit must be a 40-character Git object id"
    );

    println!("cargo:rustc-env=CODEX_BRIDGE_BUILD_TARGET={target}");
    println!("cargo:rustc-env=CODEX_BRIDGE_BUILD_SOURCE_COMMIT={source_commit}");
}

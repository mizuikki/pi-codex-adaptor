# Official OpenAI Codex Baseline

Production source is pinned to one immutable OpenAI Codex release:

| Field | Value |
| --- | --- |
| Version | `0.144.3` |
| Tag | `rust-v0.144.3` |
| Annotated tag object | `13307a9036baccd2c51b685d1457a4b89b5b2f3b` |
| Peeled source commit | `78ad6e6bfd1d3b6a209acd3ef82172a96b25179c` |
| Cargo workspace version | `0.144.3` |
| Rust toolchain | `1.95.0` with `clippy`, `rustfmt`, and `rust-src` |
| Upstream license | Apache-2.0 |

The human-readable tag identifies the release; synchronization and builds use the peeled commit.
No build, Cargo, npm, or generation configuration may reference a developer's local Codex checkout.

Conformance uses `@openai/codex@0.144.3` and `@openai/codex-sdk@0.144.3` only in isolated development
and CI jobs. Their expected npm integrity values are recorded in `UPSTREAM_CODEX.toml`. They are not
production dependencies and do not run inside Pi.

The vendor selection contains 257 files from the recorded production closure. Its allowlist, source
hashes, license inventory, patch list, and deterministic tree hash are pinned by
`UPSTREAM_CODEX.toml`. Offline verification checks the committed tree; replay verification fetches
and peels the immutable official tag without reading a local checkout.

The stable app-server schema is a conformance-only oracle. The repository records canonical SHA-256
checksums for the complete generated JSON bundles and commits only the allowlisted initialization,
response-item, thread, turn, and item TypeScript subset under
[`fixtures/app-server-schema`](../fixtures/app-server-schema/manifest.json). The schema check runs the
pinned CLI with an empty temporary `CODEX_HOME`, verifies those checksums and subset files, and then
deletes the complete generated output. No app-server process or account API enters production.

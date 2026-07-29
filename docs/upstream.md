# Upstream Baseline

The native bridge is derived from the official OpenAI Codex source pinned in
[`UPSTREAM_CODEX.toml`](../UPSTREAM_CODEX.toml):

| Field | Value |
| --- | --- |
| Version | `0.146.0` |
| Tag | `rust-v0.146.0` |
| Peeled commit | `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` |
| Repository | `https://github.com/openai/codex` |
| Rust toolchain | `1.95.0` |

The authoritative upstream contracts are the typed Compact client at
[`codex-api/src/endpoint/compact.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/codex-api/src/endpoint/compact.rs),
the Responses stream parser and retry error model in the same source tree, and the official Remote
Compaction V2 implementation at the pinned commit. The implementation record is
[`docs/evidence/remote-compaction-conformance-2026-07-27.md`](./evidence/remote-compaction-conformance-2026-07-27.md).

The adaptor follows these upstream rules:

- compact input and provider requests use typed native request builders;
- Remote V2 requires one completed compaction item while tolerating unrelated output;
- retry classification and retry delay remain native-owned;
- the classic endpoint keeps the official provider retry configuration;
- cancellation interrupts both streaming and retry backoff;
- opaque response items cross the native/adaptor boundary as structured data and are never decrypted.

The repository vendors a selected file-level closure rather than the complete Codex core. Every
vendor change updates the allowlist, source and vendor hashes, vendor tree hash, license inventory,
SBOM, and replayable patch list. `bun run check:upstream` verifies the peeled source and those
manifests without inferring provenance from filenames.

The paired Pi fork is a separate private baseline. It preserves Pi session format version `3` and
extension ABI version `1`, and adds only the independently versioned provider checkpoint transaction
needed by this adaptor. Pi product versions are not compatibility identifiers.

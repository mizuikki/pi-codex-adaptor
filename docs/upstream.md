# Upstream Synchronization

`UPSTREAM_CODEX.toml` is the authoritative upstream identity. Synchronization fetches the annotated
release tag into an isolated temporary repository, verifies its tag object and peeled commit, copies
only recorded files, verifies every source and vendor hash, and reproduces the stored vendor tree
hash. It never reads a developer checkout.

The explicit 257-file allowlist and per-file hashes are stored in
`native/upstream/openai-codex-files.json`. The license inventory is stored in
`native/upstream/openai-codex-licenses.json`, and the lockfile-reachable dependency graph is stored in
`native/upstream/openai-codex-sbom.json`. The selected production closure contains the official
Responses/Compact/Models/Images/Search clients, transports, protocol types, P0 tool builder modules,
and exact update-plan/apply-patch/shell/hosted-web/view-image core spec files, plus the official
apply-patch parser modules. Complete core, app-server, login, and
exec-server crates are excluded. The image-generation namespace description is selected without the
extension runtime that depends on complete core and exec-server.

`bun scripts/sync-codex-upstream.ts --verify` performs an offline tree, allowlist, license, baseline,
and SBOM identity check. `--verify-source` additionally fetches the immutable tag and verifies every
recorded source hash without modifying the vendor tree or manifests. `--sync` reconstructs the tree
from that clean source. `--initialize` is accepted only for an empty pending manifest and exists
solely to produce the first reviewed allowlist and inventories.

Recorded patches are applied with `git apply --check` after exact source extraction and before vendor
hash verification. The current request-deserialization patch is limited to derive metadata needed by
the shared typed SSE/WebSocket request path.

RemoteCompactionV2 history installation is a project-owned narrow adapter because the official
session implementation depends on complete core orchestration. It preserves the official 64k retained
user-message token budget, official token truncation helpers, compaction trigger, exactly-one-output
rule, and opaque `ResponseItem` handling; Pi remains the session owner. Bridge protocol v4 carries
Pi's stable session id as transient context so native code can derive the Remote V2 session, window,
and turn request metadata without importing the complete official session implementation.

The locked Pi compatibility floor is the `0.80.6` package graph recorded in `package.json` and
`bun.lock`. Public SDK and extension-runner checks were also inspected against the exact local host
commit `01aade936f90d64cc5ab5fbfb3269ea3a72e3c7a`; that commit is a post-tag host and must not be
reported as the upstream `v0.80.10` tag (`8dc78834cde4e329284cf505f9e3f99763df5529`). The
provider-hook, public session-tree, append-boundary, and response-item conversion assertions are
maintained in the adaptor's integration and contract tests; the local-host command and result are
recorded in `docs/automatic-compaction-verification.md`. No Pi source or Codex vendor file is
modified by this feature.

An upstream baseline change is always a dedicated pull request. It must update source identity, Rust
toolchain, official conformance packages, Cargo dependency set, schemas, fixtures, licenses,
conformance results, and binary size measurements together. Dependency automation must not update any
part of this coupled set independently.

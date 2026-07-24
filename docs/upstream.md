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
rule, and opaque `ResponseItem` handling; Pi remains the session owner. Bridge protocol v5 carries
Pi's stable session id as transient context so native code can derive the Remote V2 session, window,
and turn request metadata without importing the complete official session implementation.

The `0.81.1` Pi package graph recorded in `package.json` and `bun.lock` is a public development
baseline only. It is not a compatible runtime host for portable compaction. The paired Pi fork must
advertise `ExtensionAPI.providerPayloadCompactionApiVersion === 1`; the adaptor fails closed when that
marker is absent. The recorded host is [`mizuikki/pi`](https://github.com/mizuikki/pi) commit
`44a2567c5d3c183e7af4375b195d15df468181c3`, with no tag and
`providerPayloadCompactionApiVersion === 1`; its immutable identity is also recorded in
`docs/compatibility.md`. `bun run test:pi-fork` archives that clean checked-out commit, packs the four
consumed Pi workspaces, installs the assembled adaptor tarball into a separate consumer, and validates
the package and focused cross-repository behavior without a workspace link. Provider-hook, public
session-tree, append-boundary, auxiliary request attribution, and response-item conversion assertions
are maintained in the adaptor's focused integration and contract tests. No Pi source or Codex vendor
file is modified by this feature.

An upstream baseline change is always a dedicated pull request. It must update source identity, Rust
toolchain, official conformance packages, Cargo dependency set, schemas, fixtures, licenses,
conformance results, and binary size measurements together. Dependency automation must not update any
part of this coupled set independently.

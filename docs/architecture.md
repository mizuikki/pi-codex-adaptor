# Architecture

The repository is one Pi package with a TypeScript extension and a Rust sidecar. Dependencies flow
in one direction:

```text
src/extension.ts
├── integration/pi ─────────> application ─────────> domain
├── ui/terminal ────────────> application view models
└── infrastructure/codex-bridge ──> native/codex-bridge
                                           |
                                           v
                              selected vendored Codex modules
```

The composition root wires one `CodexRuntime`, configuration service, activation policy, capability
resolver, tool-profile coordinator, request guard, compaction coordinator, and diagnostics exporter.
Domain and application code do not import Pi, terminal UI, filesystem, HTTP, or native process
implementations. Pi-specific types stay in `src/integration/pi` and UI code.

## Native boundary

TypeScript communicates with Rust only through the bounded protocol version 6. The bridge methods are
`responses.create`, `responses.compact`, `models.resolve`, `tools.resolve`, `tools.execute`, and
`diagnostics.read`. Native code owns Responses request construction, SSE/WebSocket parsing, compact
endpoint calls, retry classification, backoff, cancellation, PTY/session handling, and patch
execution. TypeScript validates only adaptor-owned envelopes and checkpoint data.

The native bridge is built from the pinned official Codex source closure. The official version, tag,
peeled commit, vendor tree hash, target, and source commit are immutable handshake fields. Vendor
changes require the allowlist, source hashes, tree hash, license inventory, SBOM, and replayable patch
list to change together.

## Capability resolution

`ResolveEffectiveCapabilities` is the application authority for one model, provider, configuration
fingerprint, and verified bridge handshake. It selects `remote_v2` or `compact_endpoint` before a
compaction operation begins. Activation also requires the Pi extension ABI markers,
`providerPayloadCompactionApiVersion: 1`, `providerCheckpointCommitApiVersion: 1`, and
`compactionFailureResultApiVersion: 1`, plus the native Remote Compaction capability. A missing
stacked capability fails before provider registration.

The same snapshot drives provider requests, tool activation, compaction, settings validation, status,
and diagnostics. TypeScript does not reconstruct official model metadata or tool schemas.

## Pi integration

Provider registration is process-stable, while execution is session-affine. The router selects one
session lease by Pi session ID and rejects missing, stale, or ambiguous routes locally. The tool
profile captures Pi's active core tools, suppresses them while Codex is active, preserves additive
external tools, and restores the captured selection on deactivation or shutdown.

The provider request guard records one live session/model/connection/request identity and one Pi
provider commit token. The `before_provider_payload` hook may return one sealed payload and either the
existing textual proposal or one provider checkpoint proposal. Pi appends and verifies a custom entry
before dispatch. A stale, forged, reused, cancelled, or indeterminate transaction blocks dispatch.

## Canonical history and checkpoints

Pi's ordinary session entries remain the canonical provider-neutral history. A remote checkpoint is an
extension-owned cache of one covered active-branch prefix, stored in a context-invisible `CustomEntry`.
Pi does not parse Codex identity fields or opaque response items and does not add a session entry type
or session-format version.

For an exact checkpoint identity, the adaptor selects the latest valid version-one entry on the active
branch and builds:

```text
checkpoint.output + canonical projection of entries after coveredEntryId
```

Checkpoint metadata and all context-invisible entries are excluded from the suffix. Identity mismatch
uses the canonical payload and emits one bounded warning. Removing the adaptor leaves canonical Pi
history available. Older adaptor schemas are inert; no reader, writer, migration, or fallback branch
exists in production code.

## Compaction state machine

Manual and overflow `session_before_compact` handlers call the native remote operation once and return
one provider-checkpoint result. Threshold preparation returns a handled cancellation so the inline
provider hook remains authoritative. The hook replays an exact checkpoint when the suffix is clean or
below threshold, and otherwise performs one remote operation and returns a sealed payload plus one
proposal. Native retry completes before the proposal exists. Pi commits before provider dispatch and
settles overflow lifecycle before its existing one-time turn retry.

After a verified checkpoint, the Pi usage epoch is unknown until a later valid assistant usage. The
adaptor restores or clears the epoch by active-branch custom entry ID on session start, model/provider
changes, reload, fork, and tree selection. This is state about a boundary, not opaque data parsing.

## Privacy and verification

Credentials, prompts, account data, opaque output, headers, and absolute paths are bounded or redacted
before logs, diagnostics, fixtures, snapshots, and errors. The package verifier checks native artifact
manifests and package allowlists. The fork verifier reads the Pi manifest, verifies every SDK tarball
SHA-256, installs all four SDK tarballs directly into positive consumers, and probes the real Pi loader
with poison packages in isolated temporary `pi` and `project` directories.

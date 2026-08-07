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

TypeScript communicates with Rust only through the bounded protocol version 8. The bridge methods are
`responses.create`, `responses.compact`, `responses.estimate_context`, `models.resolve`,
`tools.resolve`, `tools.execute`, and `diagnostics.read`. Native code owns Responses request
construction, model-visible context estimation, SSE/WebSocket parsing, compact
endpoint calls, retry classification, backoff, cancellation, PTY/session handling, and patch
execution. TypeScript validates only adaptor-owned envelopes and checkpoint data.

Configuration schema v3 supplies independent approval and filesystem access policies. Pi snapshots
both values after model-argument allowlisting, Rust resolves and classifies explicit paths, and Pi
owns any `on-request` decision. Rust re-resolves approved patch and image targets before side effects.
The path checks are structured-tool guardrails, not an OS sandbox, and do not inspect shell text.

Before any Responses or compact request leaves the bridge, and before standalone `web.run` prepares
its search input, native code applies the selected model's truncation policy to every function/custom
tool result and shares one content budget across the latest contiguous result batch. Managed command
execution also clamps caller-requested output to the same model policy. Canonical Pi history remains
unchanged. The compact fitter compares UTF-8-byte and UTF-16-density estimates, rewrites only the
eligible trailing output batch when both overflow, and leaves ambiguous bounded requests to provider
accounting. Local `compaction_context_limit_exceeded` and upstream `context_window_exceeded` remain
distinct.

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
and diagnostics. Pi's filtered tool registry is included in the snapshot fingerprint. Native
resolution intersects that host policy with the official tool profile so model-visible,
dispatch-only, and local tools remain coherent, including an empty `--no-tools` profile. Missing
tools are host-disabled; a visible same-name tool with foreign provenance remains an ownership
conflict. Pi's selected-model input modalities further narrow the host policy: a model without image
input cannot receive `view_image` or `image_gen.imagegen`, while an image declaration still cannot
override official model metadata. TypeScript does not reconstruct official model metadata or tool
schemas.

## Pi integration

Provider registration is process-stable, while execution is session-affine. The router selects one
session lease by Pi session ID and rejects missing, stale, or ambiguous routes locally. The tool
profile captures Pi's active core tools, suppresses them while Codex is active, preserves additive
external tools, and restores the captured selection on deactivation or shutdown.

The provider request guard records one live session/model/connection/request identity and one Pi
provider commit token. The `before_provider_payload` hook may return one sealed payload and either the
existing textual proposal or one provider checkpoint proposal. Pi appends and verifies a custom entry
before dispatch. The guard also latches the adaptor handler's first failure. For the expected
tokenless checkpoint-threshold sentinel, the hook returns the unchanged unapproved payload to avoid a
misleading extension diagnostic, then the guard rethrows the sentinel before provider dispatch. Other
hook failures still escape directly, and the guard rethrows them before dispatch if Pi swallows them.
A stale, forged, reused, cancelled, indeterminate, or failed transaction blocks dispatch.

## Canonical history and checkpoints

Pi's ordinary session entries remain the canonical provider-neutral history. A remote checkpoint is an
extension-owned cache of one covered active-branch prefix, stored in a context-invisible `CustomEntry`.
Pi does not parse Codex identity fields or opaque response items and does not add a session entry type
or session-format version.

The paired Pi host at the protected SDK tag `pi-extension-sdk-v1.3.1` adds a trusted navigation
projection to verified provider-checkpoint custom entries. Pi owns the default Session Tree filter,
reload/resume/fork persistence, and HTML redaction. The adaptor registers an optional renderer for
the existing custom entry and projects only a fixed `Codex checkpoint` label plus the host-owned
`navigation.tokensBefore` value. It never reads opaque entry data. The same safe marker is available
after reconstruction wherever the optional renderer is supported; missing UI registration is a no-op.
Navigation metadata is not provider payload and is never included in model context. The adaptor also
owns the inline automatic-compaction status and bounded provider-inline completion/failure notices,
while Pi retains ownership of textual, manual, and overflow compaction lifecycle feedback. Exact
checkpoint replay remains silent.

For an exact checkpoint identity, the adaptor selects the latest valid version-one entry on the active
branch that is fully covered by the requested replay or compaction boundary and builds:

```text
checkpoint.output + canonical projection of entries after coveredEntryId
```

Checkpoint metadata and all context-invisible entries are excluded from the suffix. Identity mismatch
uses the canonical payload and emits one bounded warning. Removing the adaptor leaves canonical Pi
history available. Older adaptor schemas are inert; no reader, writer, migration, or fallback branch
exists in production code.

## Compaction state machine

Manual and overflow `session_before_compact` handlers reuse an eligible exact checkpoint plus only the
canonical suffix inside the prefix being replaced, call the native remote operation once, and return
one provider-checkpoint result. Threshold preparation returns a handled cancellation so the inline
provider hook remains authoritative. The hook replays an exact checkpoint when the suffix is clean or
below threshold, and otherwise performs one remote operation and returns a sealed payload plus one
proposal. Native retry completes before the proposal exists. Pi commits before provider dispatch and
settles overflow lifecycle before its existing one-time turn retry.

After a verified checkpoint, the Pi usage epoch is unknown until a later valid assistant usage. The
adaptor restores or clears the epoch by active-branch custom entry ID on session start, model/provider
changes, reload, fork, and tree selection. This is state about a boundary, not opaque data parsing.

Before every ordinary provider dispatch, the adaptor asks native Rust to estimate the exact request
instructions and replay input. A successful server usage total is reused only when the prior request
input is an exact prefix and the instructions digest matches in the same session,
provider/model/authentication identity, branch, and checkpoint generation. The native estimate then
adds only items after the latest model-generated boundary, following the pinned official Codex
accounting rule. Missing or stale alignment estimates the instructions plus complete replay. Reaching
either the effective automatic threshold or the model's hard context window enters the same
commit-before-dispatch checkpoint transaction. A provider-authoritative
`context_window_exceeded` bridge error is exposed to Pi as its stable overflow sentinel so Pi's
existing lifecycle performs at most one compact-and-retry attempt. The native Responses transport
also recognizes the same structured context error when a proxy incorrectly returns it as a 200 JSON
body instead of an SSE failure event. JSON inspection accumulates at most a 64 KiB prefix across
arbitrary transport chunks and replays non-error bodies without collecting the remaining stream.

Checkpoint replay and context estimation run even when Pi cannot prepare an inline checkpoint token
for the current leaf. Existing checkpoints are still rewritten before dispatch. If an
uncheckpointed request reaches the threshold without a token, a local provider preflight emits the
same Pi overflow sentinel before any native provider request; Pi's bounded overflow lifecycle then
creates the commit token and performs the single checkpoint-and-retry sequence. Uncheckpointed
epochs use the conservative maximum of aligned server usage and the full bounded estimate, while an
aligned post-checkpoint epoch trusts its current-generation server baseline instead of repeatedly
compacting an opaque replacement from the coarse full estimate.

## Privacy and verification

Credentials, prompts, account data, opaque output, headers, and absolute paths are bounded or redacted
before logs, diagnostics, fixtures, snapshots, and errors. The package verifier checks native artifact
manifests and package allowlists. The fork verifier reads the Pi manifest, verifies every SDK tarball
SHA-256, installs all four SDK tarballs directly into positive consumers, and probes the real Pi loader
with poison packages in isolated temporary `pi` and `project` directories.

# Architecture

The repository is a single npm package with a TypeScript extension and a Rust sidecar. Dependencies
flow in one direction:

```text
src/extension.ts
├── integration/pi ─────────> application ─────────> domain
├── ui/terminal ────────────> application view models
└── infrastructure/codex-bridge ──> native/codex-bridge
                                           |
                                           v
                              vendored OpenAI Codex modules
```

`src/extension.ts` is the composition root. Application ports describe approvals, bridge transport,
configuration persistence, and Pi-facing view models. Infrastructure implements those ports. Domain
and application modules do not instantiate network, filesystem, terminal, or child-process clients.

The TypeScript/native boundary is a bounded, versioned JSONL protocol. OpenAI wire types and tool
specifications have one native source of truth. TypeScript validates only adaptor-owned envelopes and
does not maintain a second Responses schema.

`ResolveEffectiveCapabilities` is the application-owned authority for one selected model, provider,
verified bridge identity, and configuration fingerprint. Provider requests, Pi tool activation,
compaction, settings, validation, status, and diagnostics consume the same cached snapshot. Native
`models.resolve` owns model metadata and native `tools.resolve` owns exact model-visible and dispatch
tool schemas; TypeScript does not reconstruct either result.

The Pi integration owns a reversible Codex tool-profile controller. It captures the active Pi core
selection on entry, suppresses those core routes while the provider is active, preserves additive
external tools, and restores the captured subset on deactivation or shutdown. A shared readiness
state and additive-tool selection policy are passed to both Responses and compaction assembly, so a
pending, unavailable, or ownership-conflicted profile cannot dispatch a partial or hybrid surface.

Pi provider registration has process identity but provider execution has session identity. The Pi
integration installs process-stable dispatchers for both supported API ids and routes each request by
Pi's non-empty stream `sessionId` to exactly one weak session lease. The selected lease retains the
session-local activation, tool profile, capability resolver, compaction state, fallback choice, and
native runtime. Missing or ambiguous attribution fails locally, and lifecycle cleanup is token
scoped so one session cannot remove another session's binding. The router is the only intentional
`globalThis` state and owns none of the session-local services.

Automatic compaction is a provider-hook operation, not a Pi turn operation. After the selected
dispatcher constructs a request, its extension-local `CodexProviderRequestGuard` opens one
single-use `AsyncLocalStorage` record around the awaited public `onPayload` chain. The registered
`before_provider_request` handler reads that record, verifies the routed and hook-context session
ids, projects `buildContextEntries()` through Pi's exported `sessionEntryToContextMessages()`, and
structurally matches the resulting input to the exact provider payload. It replays the latest
provider-bound opaque checkpoint or performs one native compact call before returning the rewritten
payload. The live tail is cloned from the hook payload, so in-flight provider items that Pi has not
persisted are not reconstructed from session entries.

Automatic checkpoints are Pi custom entries. `appendEntry` advances Pi's active branch before it
reports persistence errors, so the adaptor verifies the new leaf and only then installs its in-memory
snapshot. An indeterminate append poisons replay for that session instance until reload or
replacement. Manual compaction remains Pi-owned: Pi writes the real `CompactionEntry`, while the
adaptor supplies version `2` provider-bound details and restores them on reload. Neither path performs
client-side decryption; the pinned native typed projection limits the retained opaque item.

Activation is also the manual and overflow failure-ownership boundary. Once the selected provider
activates Codex compaction, every setup, native, status, or output-validation failure returns terminal
cancellation to Pi, clears the session coordinator, and writes no compaction state. The handler does
not throw into Pi's session-unattributed default summarizer. Explicit abort, native abort, threshold
cancellation, and coordinator contention remain non-error cancellation paths; inactive providers
remain Pi-owned.

Provider failure ownership is split across three layers. Native bridge code classifies transport and
provider failures and exposes a bounded, redacted `retryable` bit on protocol v4 `BridgeError`.
`src/integration/pi` maps only a trusted `BridgeRemoteError.retryable` fact into Pi's string-only
assistant error surface using a fixed non-sensitive marker; it does not retry, reconnect, or issue a
second `createResponse` call. For normal agent turns, Pi alone decides whether to remove the failed
assistant message and restart the turn under its existing retry settings. Auxiliary compaction-summary
and branch-summary requests may use the same stream mapping, but their host-owned workflows handle
failure without entering the AgentSession agent-turn retry loop.

When `remote_v2` is selected, the host sends the same Pi session id with a compact request and each
later Responses request from that session. Compaction also declares its `auto` or `manual` trigger.
The native bridge derives the request-scoped Codex session, thread, window, beta-feature, and turn
metadata for both SSE and WebSocket transport. This context is transient transport state: it neither
changes Pi's opaque checkpoint format nor creates bridge-owned durable session state.

Pi owns the persistent approval policy and maps one validated snapshot to one explicit authorization
value on each native request. The integration layer never infers bypass from UI availability and does
not cache authorization across calls. Native code owns the explicit allowlist, strict decoding,
workspace and provider validation, cancellation checks, approval state, and side-effect commit points.
Bypass removes only the interactive approval wait; it does not provide an OS sandbox.

## Module ownership

| Module | Owns | Must not own |
| --- | --- | --- |
| `src/domain` | Configuration and capability semantics, value objects, terminal states, redaction policy | Pi, TUI, HTTP, filesystem |
| `src/application` | Use cases and ports | Concrete UI or process implementations |
| `src/integration/pi` | Pi lifecycle, session-affine provider routing, request approval, activation, reversible tool profiles, opaque checkpoint replay, message and tool binding | Rust internals, handwritten OpenAI schemas, or process-global native runtime state |
| `src/infrastructure/codex-bridge` | Sidecar discovery, lifecycle, JSONL codec, cancellation | HTTP details or Pi UI |
| `src/infrastructure/diagnostics` | Confirmed redacted diagnostic-file export | Provider transport or Pi UI |
| `src/ui/terminal` | `/codex`, settings view models, inline renderers | Provider transport details |
| `native/crates/codex-bridge` | Official clients and native tool execution | Pi types or settings UI |
| `native/official` | Generated build wrappers for the allowlisted official source closure | Product behavior or Pi types |
| `native/vendor/openai-codex` | Unmodified pinned upstream files | Project business logic |

Shared code must have a clear owner. The project does not use a general-purpose `utils` layer.

## Dependency boundary check

`bun run check:architecture` scans `src/domain` and `src/application` for forbidden imports.
Those layers may not import Pi packages, terminal UI modules, filesystem or HTTP clients, native
process APIs, or infrastructure implementations. Domain may import only domain modules. Application
may import only application and domain modules. The check is part of `bun run check`.

## Packaged sidecar integrity

Before a non-development packaged `codex-bridge` is spawned, `src/infrastructure/codex-bridge/binary.ts`
reads the target-scoped `native-artifact.json`, validates schema, target, executable name, project
source commit, official baseline, vendor tree hash, and bridge protocol version, then streams the
executable through SHA-256 and compares size and digest. The verified project source commit is passed
into handshake verification. Missing or tampered manifests and binaries fail closed with a safe
`BridgeLoaderError` before process execution. Explicit development or test executable overrides
require `allowDevelopmentBuild: true` and cannot silently skip production verification of packaged
artifacts.

## Privacy redaction

`src/domain/redaction.ts` owns the reusable redaction policy for logs and safe error surfaces. It
replaces tokens, authorization headers, user content fields, absolute user paths, and opaque
compaction payloads with fixed placeholders and never re-emits the original values.

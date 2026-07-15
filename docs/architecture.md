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

## Module ownership

| Module | Owns | Must not own |
| --- | --- | --- |
| `src/domain` | Configuration and capability semantics, value objects, terminal states, redaction policy | Pi, TUI, HTTP, filesystem |
| `src/application` | Use cases and ports | Concrete UI or process implementations |
| `src/integration/pi` | Pi lifecycle, activation, message and tool binding | Rust internals or handwritten OpenAI schemas |
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

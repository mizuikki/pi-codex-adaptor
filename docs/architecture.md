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
| `src/domain` | Configuration and capability semantics, value objects, terminal states | Pi, TUI, HTTP, filesystem |
| `src/application` | Use cases and ports | Concrete UI or process implementations |
| `src/integration/pi` | Pi lifecycle, activation, message and tool binding | Rust internals or handwritten OpenAI schemas |
| `src/infrastructure/codex-bridge` | Sidecar discovery, lifecycle, JSONL codec, cancellation | HTTP details or Pi UI |
| `src/ui/terminal` | `/codex`, settings view models, inline renderers | Provider transport details |
| `native/crates/codex-bridge` | Official clients and native tool execution | Pi types or settings UI |
| `native/vendor/openai-codex` | Unmodified pinned upstream files | Project business logic |

Shared code must have a clear owner. The project does not use a general-purpose `utils` layer.

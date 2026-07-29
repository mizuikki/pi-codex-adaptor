# ADR 0006: Official Compaction Paths

- Status: Superseded by [0020](./0020-extension-owned-remote-compaction-clean-slate.md)
- Date: 2026-07-14

## Context

Codex `0.146.0` supports RemoteCompactionV2 by provider capability and a typed CompactClient fallback.
Compaction output contains canonical response items that the application must not reinterpret.

## Historical Decision

The earlier decision selected the official Remote Compaction implementation by capability and kept
manual and automatic paths on the same native operation. It did not define the current extension-owned
checkpoint transaction.

Preserve canonical output items as opaque protocol data and feed them back without application-layer
parsing, reconstruction, or arbitrary trimming.

## Consequences

- The operation selection and opaque-output privacy rules remain valid.
- Checkpoint persistence, identity continuity, and retry ownership are defined by ADR 0020.

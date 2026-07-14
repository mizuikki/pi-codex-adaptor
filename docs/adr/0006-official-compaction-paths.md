# ADR 0006: Official Compaction Paths

- Status: Accepted
- Date: 2026-07-14

## Context

Codex `0.144.3` supports RemoteCompactionV2 by provider capability and a typed CompactClient fallback.
Compaction output contains canonical response items that the application must not reinterpret.

## Decision

Expose only `off` and `auto`. In `auto`, use the current model's metadata threshold unless a validated
positive override is provided. Select the official RemoteCompactionV2 algorithm when supported and
the official CompactClient otherwise. Manual compaction uses the same resolved path.

Preserve canonical output items as opaque protocol data and feed them back without application-layer
parsing, reconstruction, or arbitrary trimming.

## Consequences

- There is no separate compaction model, reasoning setting, or protocol-version mode.
- Provider capability and model metadata errors are explicit capability or configuration failures.
- Fixtures and diagnostics must never expose opaque compaction payload contents.

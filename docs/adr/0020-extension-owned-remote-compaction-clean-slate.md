# ADR 0020: Extension-Owned Remote Compaction Clean Slate

- Status: Accepted
- Date: 2026-07-27
- Supersedes: [0006](./0006-official-compaction-paths.md), [0015](./0015-inline-automatic-compaction-and-opaque-replay.md), and [0017](./0017-portable-primary-compaction-checkpoints.md)

## Context

Pi's session history is provider-neutral and its generic context projection must remain stable. The
official Codex Remote Compaction result is opaque provider-bound state, so it cannot become a portable
Pi summary or a provider-specific session entry. The old adaptor also had multiple compaction request
and persistence meanings.

## Decision

Use one official `responses.compact` operation for every activated Codex compaction. Select Remote V2
or the official compact endpoint before the request. Native Rust owns stream parsing, retry, backoff,
cancellation, and WebSocket-to-SSE fallback. TypeScript issues one runtime call and performs no retry.

Persist the validated result as one version-one `CustomEntry` with custom type
`pi-codex-adaptor.remote-compaction`. The entry covers an active-branch prefix and is ignored by Pi's
generic projection. Exact identity may replay `output` plus the canonical suffix after
`coveredEntryId`. Any identity or branch mismatch uses canonical Pi history, warns once without
sensitive values, and does not promise destination fit. A new session is the recovery action when
canonical history cannot fit.

Add only the independently versioned Pi provider-checkpoint transaction. Pi verifies token, session,
model, branch, parent, custom type, data, readback, cancellation, and sealed payload before dispatch.
No Pi session schema, migration, `CompactionEntry`, or generic projection branch changes.

Old adaptor-specific checkpoint schemas remain inert. They are not parsed, written, migrated, replayed,
or used as usage boundaries. Installation and upgrade acceptance starts a new session.

## Consequences

- Canonical Pi history survives adaptor removal, ordinary model switching, and ordinary Pi loading.
- Exact Codex identity gets bounded opaque continuity without client-side decryption.
- Identity changes are explicit continuity boundaries instead of hidden textual migration.
- Repeated unchanged threshold preparation creates no remote calls or custom entries.
- Manual and overflow success have an explicit provider-checkpoint lifecycle result.
- The bridge protocol is version 6 because the removed legacy operation and capability are breaking.

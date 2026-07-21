# ADR 0015: Inline Automatic Compaction and Opaque Replay

- Status: Accepted
- Date: 2026-07-20

## Context

Pi's automatic compaction event is post-run and Pi's `ctx.compact()` path owns a new compaction
operation. Calling it from `turn_end` aborts the active run and cannot compact the exact provider
payload that crossed the threshold during a tool loop. OpenAI's compact operation returns an opaque
typed `ResponseItem` whose encrypted content is not client-decryptable. Pi remains the owner of
sessions and real `CompactionEntry` persistence.

## Decision

Automatic compaction runs inline in the active Codex provider's public `before_provider_request` hook.
The extension-local request guard binds the exact awaited provider payload to one routed session and
one immutable request snapshot. The handler projects Pi's public `buildContextEntries()` through
`sessionEntryToContextMessages()`, locates the latest active-branch checkpoint, and structurally
matches the provider input. If usage is known to be over threshold and uncheckpointed input remains,
it performs one native compact request, verifies freshness, appends one version `1` opaque custom
checkpoint through public `appendEntry`, verifies the new leaf, and returns the compact output plus the
exact cloned live tail to the same provider run.

Manual Pi compaction remains Pi-owned. It uses fixed shim text and real Pi `CompactionEntry` details
version `2`; legacy detail version `1` is recognized as `legacy_identity_missing` and never enters a
provider request. Automatic checkpoint version `1` and manual version `2` both use strict structured
JSON, discriminated `jwt_account | credential` bindings, deep cloning, exact non-empty canonical
`compaction.encrypted_content`, and fail-closed parsing. Only the official JWT account claim is stable
across credential refresh. No client-side decryption or plaintext summary conversion occurs.

The pinned bridge's typed native boundary is the losslessness limit. Canonical aliases normalize and
unknown SSE fields dropped by native deserialization are not claimed as retained. Bridge protocol v4
carries the transient Pi session context required by Remote V2 for the compact request and later
Responses requests; native derives the Codex session, window, and turn metadata from it. Pi router
`1`, config schema `2`, native vendor state, and release metadata remain unchanged.

## Consequences

- A mid-tool-loop threshold can continue through the existing provider call without an abort, hidden
  prompt, synthetic continuation, or extra tool execution.
- A repeated active-branch request reuses the last verified opaque checkpoint instead of compacting the
  same input again. Mismatched, malformed, reordered, ambiguous, stale, or forked state fails closed.
- An indeterminate public append poisons adaptor replay for the extension instance. Pi's in-memory
  partial mutation is recorded as an ownership boundary; no rollback is claimed.
- Process-global state remains limited to weak provider router leases. Credentials, approvals,
  checkpoints, coordinators, and runtime records remain extension-instance local.

## Rejected alternatives

- Scheduling `ctx.compact()` from `turn_end` or queuing a hidden continuation would abort or alter Pi's
  existing run semantics.
- Reimplementing Pi context selection or reconstructing provider tails from plaintext messages would
  make branch and in-flight item matching ambiguous.
- Decrypting or replacing the opaque item with prose would destroy the provider contract.
- Modifying Pi or the pinned native vendor would violate the ownership and baseline constraints for
  this feature.

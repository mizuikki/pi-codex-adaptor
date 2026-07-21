# ADR 0016: Activated Compaction Failure Ownership

- Status: Accepted
- Date: 2026-07-21

## Context

Pi emits `session_before_compact` before both manual and overflow compaction. When an extension
handler throws, Pi reports the extension error but treats the absent result as permission to run its
default textual summarizer. Pi 0.80.6 does not attach `sessionId` to that auxiliary request. The
adaptor's process provider router therefore rejects it because no session lease can be selected
safely. Adding only a session id would still leave auxiliary-request provenance, approval, abort, and
replay semantics undefined.

An activated Codex provider has already selected native opaque compaction semantics. A Pi-generated
text summary is not an equivalent representation of a Remote Compaction V2 output window and would
change persistence and replay behavior after the adaptor claimed the event.

## Decision

After activation identifies a compaction event as Codex-owned, the Pi integration owns that attempt
through either one validated native result or terminal cancellation. Authentication, connection,
configuration, tool-profile, capability, identity, native transport, status, and output-validation
failures are converted to Pi's existing `{ cancel: true }` result. The handler clears its coordinator
state, writes no checkpoint or compaction snapshot, and does not throw into Pi's default summarizer.

Interactive failures emit exactly this fixed error notification:

```text
OpenAI Codex compaction failed; the session context was left unchanged.
```

The notification contains no exception data and is not a correctness prerequisite. Notification
failure and Pi's headless no-op UI still result in terminal cancellation. Threshold events, explicit
abort, native abort, and same-session contention remain non-error cancellations without a
notification. Inactive providers remain Pi-owned and return no extension result. Successful opaque
compaction and Pi-owned `CompactionEntry` persistence are unchanged.

The session-affine provider router remains strict. Missing, blank, stale, unknown, or ambiguous
session attribution is never repaired by registration order, a last-active lease, model data, request
shape, or process-global current-session state.

When a newer Pi host supplies a matching non-empty session id, an explicit `compaction_summary` or
`branch_summary` origin, and the request-scoped abort signal, the adaptor approves the unchanged
auxiliary payload without session-context segmentation or automatic checkpoint replay. Events with
partial, unknown, or mismatched attribution fail closed. Legacy events without attribution retain the
normal agent-request path for compatibility with the locked Pi version.

## Consequences

- Manual callers receive Pi's existing `Compaction cancelled` outcome after a provider failure, and
  overflow recovery ends without invoking a second summarization stream.
- A failed attempt leaves the Pi branch, leaf, entries, adaptor store, replay state, and coordinator
  free of a new compaction result.
- Dynamic provider errors, credentials, URLs, prompts, session identifiers, paths, response bodies,
  and opaque output do not reach the UI or persisted diagnostics.
- The adaptor does not retry, synthesize a prompt, implement Responses in TypeScript, or promise that
  the next request will fit the context window.
- The locked Pi version still cannot issue attributed auxiliary requests. Newer hosts may opt in only
  when they carry trusted session attribution, explicit request provenance, and the exact abort signal
  for compaction, turn-prefix, and branch summaries.

## Rejected alternatives

- Routing an unattributed request to the only or latest lease cannot establish session ownership.
- Adding only `sessionId` does not establish whether a synthetic request may pass the provider request
  guard or how it participates in replay and cancellation.
- Falling back from opaque Remote V2 output to plaintext silently changes the selected provider
  contract.
- Throwing after notification reproduces Pi's swallowed-extension-error fallback behavior.
- Retrying or implementing a second summarizer in TypeScript duplicates native and Pi ownership.

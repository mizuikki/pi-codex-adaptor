# Pi Integration

Pi lifecycle, provider activation, message conversion, approval binding, and tool result routing
belong here.

The Codex tool-profile controller owns the Pi host boundary for core-tool isolation. On activation it
captures the currently active Pi core subset, suppresses all seven Pi core names, and installs only
the registered native managed tools resolved for the selected capability snapshot. Additive external
tools retain their current order. Pending, unavailable, and ownership-conflicted states keep Pi core
tools suppressed; deactivation and shutdown restore only the captured core subset while preserving
current additive changes.

Responses and compaction share the same additive-tool selection policy and require matching healthy
profile readiness before native dispatch. Pi prompt rebuilding remains authoritative: registered
Codex tools provide short host snippets, and a healthy profile appends structured model-invocable
skill locations with the resolved shell loader without replacing Pi's assembled prompt.

Provider registration is process stable while execution remains session local. Each extension
instance binds its two local dispatchers to a weak lease on `session_start`; the global API functions
select exactly one lease from Pi's stream `sessionId`. Shutdown releases the lease before disposing
its profile, capability, compaction, activation, and runtime state. Missing, stale, or ambiguous
routes fail locally without provider side effects. Session identifiers are transient map keys and
must never appear in errors, diagnostics, logs, or persisted data.

Activated compaction uses one ownership decision for both manual and overflow events:

| Outcome | Pi handler result | Notification | Persistence |
| --- | --- | --- | --- |
| Provider inactive | `undefined` | none | Pi owns its normal path |
| Threshold, explicit abort, native abort, or contention | `{ cancel: true }` | none | none |
| Validated native opaque output | `{ compaction: ... }` | none | Pi writes the real `CompactionEntry` |
| Setup, dispatch, status, or output failure | `{ cancel: true }` | fixed redacted error | none |

Once activation claims the event, failure is terminal cancellation and cannot fall through to Pi's
session-unattributed default summarizer. The process router remains strict. A Pi auxiliary request path
must provide trusted session attribution, explicit request provenance, the request-scoped abort signal,
and matching approval semantics. Newer hosts with that contract are accepted without automatic
checkpoint replay; the locked legacy host remains fail-closed.

Provider stream failures map through `toPiProviderErrorMessage`. A protocol-decoded
`BridgeRemoteError` with `retryable: true` becomes the fixed redacted text
`OpenAI provider service unavailable` so Pi's public classifier can apply its host-owned agent-turn
retry policy. Non-retryable bridge, connection, configuration, capability, and abort errors keep
their existing safe messages. The adaptor never retains upstream error details for that mapping and
never implements a local retry loop; auxiliary compaction and branch-summary callers receive the same
safe mapping but keep their own host-owned failure handling.

Message projection accepts a complete contiguous Pi message sequence, not one session entry at a
time. `responseItemsFromMessages()` first pairs tool calls and results and inserts the following
request-local error output for any unresolved call:

```text
Tool result was not recorded. The tool may have partially executed; inspect state before retrying.
```

The normal Responses request, manual compaction input, automatic checkpoint replay, and standalone
web conversation context are the four current consumers. New consumers must provide a complete
sequence or define an explicit opaque-checkpoint boundary before projection. The normalizer never
mutates Pi messages or session JSONL, never replays a tool, and treats interrupted tool side effects
as unknown. Complete histories pass through without synthetic outputs.

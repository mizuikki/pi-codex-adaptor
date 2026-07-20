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

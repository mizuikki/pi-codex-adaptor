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

# ADR 0013: Codex Agent Tool-Profile Isolation

- Status: Accepted
- Date: 2026-07-19

## Context

Pi and the adaptor both provide coding-agent tools, but their names are mostly different. Exact-name
deduplication therefore leaves semantic duplicates such as Pi `bash` beside Codex `shell_command`,
with different schemas, approvals, workspace checks, and execution paths. A hybrid surface makes the
official Codex core contract non-authoritative. Capability failures also cannot restore Pi core tools
while the activated Codex dispatcher remains selected.

## Decision

The Pi integration maintains one reversible Codex tool profile. When provider activation is active,
all seven Pi core names (`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`) are suppressed by
canonical name. The native resolver supplies the official Codex core tools and the adaptor's managed
dispatch definitions; currently active orthogonal external tools remain additive. A pending,
unavailable, or managed-ownership-conflicted profile keeps Pi core and unresolved managed tools out
of the active set and requires healthy readiness before Responses or compaction dispatch.

On first entry, the controller captures the active Pi core subset and baseline order. On deactivation
or shutdown it restores only captured core names that are still registered, walks the baseline to
preserve additive ordering, and retains current additive changes. Registration remains intact so the
transition is reversible without replacing Pi's definitions. Responses and compaction use one shared
additive selection policy, and prompt continuity is appended through Pi's lifecycle events.

## Consequences

- Native Codex core schemas and execution paths are authoritative while the provider is active.
- Third-party, SDK, and MCP-style tools remain available when they do not occupy a Pi core or managed
  name.
- Configuration and capability failures are visible as an unavailable Codex profile rather than a
  misleading Pi/Codex hybrid.
- Model selection changes can rebuild Pi's prompt and active-tool status, but no new user setting is
  required.
- Ownership validation depends on Pi's post-bind `sourceInfo.path`; conflicting managed names fail
  the full profile closed without exposing source paths.

# Remaining Official Capability Gaps

This list tracks Codex `0.144.3` capabilities outside the first stable release. A checked item means
implementation and conformance are both complete. A similar Pi feature is not automatically
equivalent to the official contract.

## P1

- [ ] `request_user_input`: structured model questions, turn suspension, cancellation, headless
  rejection, and output injection.
- [ ] `request_permissions`: model-requested filesystem or network permission subsets governed by Pi
  policy and explicit scope.
- [ ] MCP tools and resources: delegate to Pi without starting a second MCP runtime while preserving
  names, pagination, structured content, images, and errors.
- [ ] Dynamic function and namespace tools: per-turn registration, conflict checks, cancellation,
  image results, and isolation.
- [ ] `tool_search`: deferred tool discovery and next-request exposure using official discovery
  contracts or a versioned Pi port.
- [ ] Code Mode `exec` and `wait`: official code-mode protocol, nested tool dispatch, cancellation,
  timeout, and mode transitions.
- [ ] Collaboration and sub-agents: adopt, delegate to Pi, or exclude through a dedicated ADR before
  exposing any collaboration schema.

## P2

- [ ] Token-budget tools: `get_context_remaining` and `new_context`.
- [ ] Plugin discovery and installation tools.
- [ ] Skills provider tools: `skills.list` and `skills.read`.
- [ ] Memory add, list, read, and search tools.
- [ ] Persistent goal tools: `create_goal`, `get_goal`, and `update_goal`.
- [ ] Clock and interruptible sleep tools.
- [ ] Deferred remote-environment waiting.
- [ ] CSV agent spawning and job-result reporting, after collaboration is resolved.

## Explicit exclusions

Account usage, rate-limit windows, reset-credit operations, complete Codex CLI/app-server lifecycle,
unselected provider/API routes, and internal test-only tools are not product gaps.

Each P1 decision requires an ADR selecting `adopt`, `delegate-to-Pi`, or `exclude`. Adopted and
delegated capabilities require official specs, bridge/application behavior, UI states, contract tests,
and differential conformance before this list changes.

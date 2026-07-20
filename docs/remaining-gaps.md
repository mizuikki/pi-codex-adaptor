# Remaining Official Capability Gaps

This list tracks Codex `0.144.3` capabilities outside the first stable release. A checked item means
implementation and conformance are both complete. A similar Pi feature is not automatically
equivalent to the official contract.

The core shell surface is complete for this baseline: shell-command models retain bounded commands
and receive the exact pinned managed-session contracts when background sessions are enabled. This is
covered by protocol-v3 resolver, execution, Pi lifecycle, and bundled-catalog reachability tests and
is therefore not tracked as a remaining gap.

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

## Public-host residuals

The inline automatic compaction contract is implemented within the public Pi hook surface, but three
host-owned limits remain explicit rather than being treated as product guarantees:

- Pi swallows a later `before_provider_request` hook exception without exposing whether the callback
  chain had an error. The guard rejects replacement or effective mutation of an approved request, but
  cannot detect a swallowed exception that leaves the same approved object unchanged.
- Protocol `3` cancellation is cooperative. A local abort after a compact or Responses invocation
  does not prove whether the remote server accepted a frame.
- Bare `AgentSession.dispose()` does not emit `session_shutdown`. In-flight records check their signal
  and clean up in `finally`; a stale weak router lease may remain ambiguous until public release or
  eventual weak pruning.

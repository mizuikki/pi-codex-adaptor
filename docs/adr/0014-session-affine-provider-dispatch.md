# ADR 0014: Session-Affine Provider Dispatch

- Status: Accepted
- Date: 2026-07-20

## Context

Pi owns a process-global API registry with one stream implementation per API id, while each adaptor
extension instance owns session-local activation, tool-profile, compaction, capability, and native
runtime state. Nested workflow sessions load the adaptor again. A later child registration could
therefore replace the main API implementation with a closure over the child's state, causing a main
request to fail against the child's inactive tool profile.

Pi supplies the owning session identifier in `SimpleStreamOptions.sessionId`. Its extension loader
evaluates extension graphs without a reliable module cache, so ordinary module identity cannot
coordinate independently loaded adaptor instances. The public `registerProvider` API is provider
scoped; registering one provider for `openai-responses` does not intercept unrelated configured
providers that use the same Pi API.

## Decision

The Pi integration installs one versioned process router in a `Symbol.for()` slot on `globalThis`.
Every adaptor instance registers the router's stable functions for `openai-responses` and
`openai-codex-responses` under `openai-codex` and every configured activated provider id, then
creates a weak session lease around its own dispatchers. The lease is bound from Pi's
`session_start` context and explicitly released before session-owned shutdown. Unselected provider
requests remain on Pi's direct native stream and do not create an adaptor request record.

Each provider request is routed only by a validated, non-empty `options.sessionId`. Exactly one live
lease must match. Missing, stale, released, or ambiguous attribution returns a local streamed error
without invoking a session dispatcher, the native bridge, or Pi's native fallback. Registration
order, model data, request content, and a most-recently-active heuristic never select a session.

The router stores weak references so a child disposed without `session_shutdown` does not remain
strongly retained. Lookup pruning and token-scoped finalization provide leak safety; explicit release
is the deterministic lifecycle path. Old release and finalization operations remove only their own
token and cannot remove a replacement binding.

## Consequences

- Repeated adaptor registration from main and nested sessions is harmless for requests carrying
  distinct session identifiers.
- Each selected session retains its own activation and direct Pi-native fallback decision.
- Missing or duplicate live identity fails closed instead of risking cross-session request, tool,
  credential, approval, or runtime state.
- The process router owns no configuration, tool profile, compaction store, native runtime, Pi
  context, UI state, or model state.
- Session identifiers remain transient in-memory lookup keys and are excluded from route errors and
  diagnostics.
- Another unrelated extension can still replace Pi's global API implementation; this decision makes
  repeated registration safe only among adaptor instances that share the router contract.

# ADR 0019: Upstream Provider Error Visibility

## Context

The bridge previously replaced every upstream API failure with a fixed message. This hid the status
and provider diagnostic from Pi users, including for compaction, where the adaptor also used a
side-channel notification and returned ordinary cancellation. Pi's extension SDK v1 could not
represent a terminal extension compaction failure in the normal `compaction_end` lifecycle.

## Decision

Native Rust extracts one bounded diagnostic from known official `ApiError` variants before it builds
the existing protocol-v5 `BridgeError`. The message contains only a status/body or variant message,
is capped to a 4,000-character detail budget, and never serializes headers, credentials, request
data, opaque values, URLs from transport metadata, or a full debug representation. Error category,
code, retryability, and provider-contract-mismatch handling remain unchanged.

The Pi integration forwards only decoded `BridgeRemoteError` detail. Retryable normal errors use
`OpenAI provider service unavailable: <detail>` so Pi retains its retry classifier. Other trusted
bridge messages are forwarded directly; arbitrary local exceptions retain fixed fallbacks.

Pi's feature-specific compaction-failure-result API v1 adds `{ cancel: true, errorMessage }` to `SessionBeforeCompactResult`. `AgentSession`
validates that the result is bounded and mutually exclusive with a compaction result, then routes it
through its existing manual, automatic, or overflow `compaction_end` error flow before ordinary
cancellation handling. This blocks the default compactor and creates no compaction entry.

## Consequences

- Bridge protocol v5 remains structurally unchanged.
- The common extension SDK remains version 1. Hosts without compaction-failure-result API v1 fail
  closed before adaptor registration; the provider-payload API remains version 1.
- Pi owns compaction formatting, event delivery, and UI rendering. The adaptor no longer calls
  `ctx.ui.notify()` for compaction failure.
- A normal failed assistant message may persist the displayed provider diagnostic in Pi session
  history. Compaction errors remain transient events.
- Logs, diagnostics exports, fixtures, static local errors, credentials, headers, request payloads,
  and opaque compaction data remain outside the exposed diagnostic channel.

## Rejected alternatives

- Deleting only the fixed compaction notification would not restore detail lost by native mapping.
- Throwing from the existing hook is swallowed by Pi's extension runner and can invoke the default
  compactor.
- Passing a full transport error could reveal URL, header, request, or unbounded debug data.
- TypeScript must not inspect HTTP error objects or implement a retry loop.

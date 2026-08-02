# Bridge Protocol v7

The TypeScript host and Rust sidecar communicate over one bounded newline-delimited JSON channel.
Protocol version `7` is a breaking identity: a v6 client or server is rejected during initialization
before provider registration.

## Frames

Every frame is one JSON object followed by a newline and is at most 16 MiB before the terminator.
Request IDs are non-empty and at most 256 bytes. The first client frame is:

```json
{"type":"initialize","requestId":"init-1","protocolVersion":7,"client":{"name":"pi-codex-adaptor","version":"0.0.0"}}
```

The server returns a handshake containing protocol identity, official Codex version/tag/source
commit, build target and source commit, vendor tree SHA-256, frame/event limits, and the compiled
capability list. The bridge closes on a mismatched protocol or immutable official identity.

Client frames include `request`, `cancel`, `acknowledge`, `approval_decision`, `session_write`,
`session_resize`, `session_terminate`, and `shutdown`. Server frames include `event`, `result`,
`error`, `approval_request`, and `backpressure`. Stream event production pauses after 256
unacknowledged events and resumes after acknowledgement.

## Operations

The only request methods are:

| Method | Owner | Contract |
| --- | --- | --- |
| `responses.create` | native bridge | typed Responses request and event stream |
| `responses.compact` | native bridge | official Remote Compaction operation |
| `models.resolve` | native bridge | pinned Codex model metadata |
| `tools.resolve` | native bridge | official model-visible and dispatch tool surface |
| `tools.execute` | native bridge | approved native, image, search, and session tools |
| `diagnostics.read` | native bridge | redacted identity and capability snapshot |

`responses.compact` receives a provider connection, typed compaction input, selected implementation
(`remote_v2` or `compact_endpoint`), transport mode, WebSocket capability, an optional compatibility
timeout override, and optional Remote V2 session context. The implementation is selected before the
call and never changes after a failure.

## Remote Compaction

Remote V2 appends the official compaction trigger to the typed request, uses the pinned Codex session
metadata, and accepts unrelated stream output. Native code requires exactly one `compaction` output
item and a completed terminal event, then returns the official opaque output plus normalized usage when
available. The response output is not decrypted or rewritten in TypeScript.

The initial request plus `min(maxRetries, 2)` stream retries are owned by native Rust. Retryable stream
open and mid-stream errors are classified by the native provider contract. An upstream retry delay
takes precedence; otherwise native code uses 200 ms exponential backoff with 0.9-1.1 jitter.
Cancellation interrupts a stream and backoff. In automatic transport mode, the bridge switches once
from WebSocket to SSE after the WebSocket path is exhausted or rejected. Each retry clones the same
typed request and occurs before any Pi payload or session mutation.

The classic endpoint uses the pinned `CompactClient` and provider `RetryConfig`; TypeScript does not
wrap it in another retry loop. Its completed result is the endpoint's output array without invented
usage fields. Both implementations are validated again by the adaptor checkpoint schema.

When `requestTimeoutMs` is omitted, Remote V2 has no compaction-specific total deadline and uses the
provider connection's ordinary stream idle and WebSocket connection timeouts. The classic endpoint
uses four times the provider stream idle timeout, matching the pinned official client. An explicit
`requestTimeoutMs` remains a 1-600,000 ms compatibility override for either implementation.
Expiration is a bounded retryable provider error; cancellation remains the distinct aborted
lifecycle. Malformed output, incomplete terminal streams after native retry exhaustion,
authentication failures, and capability failures create no checkpoint.

## Errors, approval, and filesystem scope

Errors contain only a category, bounded code/message, and retryability. Provider diagnostics are
bounded before they cross the bridge. Request content, credentials, account data, local paths, and
opaque output are never serialized into diagnostics or protocol errors.

`tools.execute` carries host-owned `approvalPolicy` (`on-request | never`) and
`filesystemAccessPolicy` (`workspace | unrestricted`). Model arguments cannot override either field.
`session_write` carries only `approvalPolicy`. Native command, patch, filesystem, network, and
non-empty session-write operations pause under `on-request`; `never` suppresses prompts but does not
broaden filesystem scope. Approval decisions are advertised in the stable order `decline`, `cancel`,
`allow_once`; session-scoped authorization is not part of the bridge contract.

## Fixtures and verification

The canonical active fixtures are
[`client-v7.jsonl`](../fixtures/bridge-protocol/client-v7.jsonl) and
[`server-v7.jsonl`](../fixtures/bridge-protocol/server-v7.jsonl). Rust and TypeScript contract tests
decode them, validate the v7 handshake, approval order, event backpressure, cancellation, and result
envelopes. The v6 fixtures remain only as negative mixed-version startup cases; they are never active
consumer fixtures and contain no removed operation or capability.

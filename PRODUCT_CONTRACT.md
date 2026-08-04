# Product Contract

## Baseline

The native implementation is pinned to OpenAI Codex `0.146.0`, tag `rust-v0.146.0`, peeled source
commit `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`, and Rust `1.95.0`. The TypeScript/native JSONL
bridge is protocol version `8`. A handshake mismatch is fatal before provider registration.

The paired Pi fork remains session format version `3`, common extension ABI version `1`, and
provider payload compaction API version `1`. Remote checkpoint persistence uses the additive
`providerCheckpointCommitApiVersion: 1` capability. Pi product versions do not define compatibility.

## Ownership

Pi owns sessions, canonical history, model selection, provider registration, tool profile lifecycle,
approval UI, persistence, and generic context projection. The adaptor owns Codex identity binding,
checkpoint validation, replay selection, and threshold decisions. The native bridge owns Responses
wire behavior, SSE/WebSocket transport, Remote Compaction, cancellation, and retry.

TypeScript does not implement Responses wire formats, SSE, WebSocket, retry timers, compaction wire
behavior, PTY handling, or patch execution. The only TypeScript/native operations are the versioned
bridge methods listed in [`docs/bridge-protocol.md`](./docs/bridge-protocol.md).

## Compaction

Every manual, threshold, overflow, and provider-inline Codex compaction uses exactly one
`responses.compact` operation per native attempt. `remote_v2` is selected when negotiated;
`compact_endpoint` is selected otherwise. A failed operation never changes implementation, creates a
second request in TypeScript, or commits partial state. Non-Codex providers and inactive adaptor
routes remain on canonical Pi behavior.

Activated Codex sessions support plain `/compact`; custom `/compact` instructions are rejected before
any remote request because the pinned official operation has no instruction parameter.

Remote V2 accepts unrelated stream output, requires exactly one `compaction` item and a completed
terminal event, retries retryable open or mid-stream failures in native code, and performs at most
one WebSocket-to-SSE fallback. The retry budget is the initial attempt plus
`min(connection.maxRetries, 2)` stream retries for each transport path. Server delay wins over the
pinned 200 ms exponential backoff with 0.9-1.1 jitter. Cancellation interrupts the stream or delay.
The official compact endpoint retains its pinned `CompactClient` retry policy and output contract.

## Checkpoint contract

The single new extension checkpoint schema is:

```json
{
  "kind": "pi-codex-adaptor.remote-compaction",
  "version": 1,
  "sessionFingerprint": "<opaque fingerprint>",
  "providerId": "<provider id>",
  "api": "<api>",
  "baseUrl": "<normalized base URL>",
  "modelId": "<model id>",
  "authenticationBinding": { "kind": "credential", "fingerprint": "<fingerprint>" },
  "checkpointId": "<correlation id>",
  "coveredEntryId": "<canonical branch entry id>",
  "implementation": "remote_v2",
  "output": [{ "type": "compaction", "encrypted_content": "<opaque output>" }],
  "tokensBefore": 12345
}
```

The actual output may include the other supported structured response items returned by the official
operation, but it must contain exactly one compaction item and remain within the bounded schema.
Pi appends one context-invisible `CustomEntry`, reads it back, and verifies its parent, ID, custom
type, data, active branch, and commit token before dispatching the sealed rewritten payload. An
indeterminate append blocks dispatch and is never retried.

For an exact identity, replay is:

```text
validated checkpoint output + Pi canonical model projection after coveredEntryId
```

The selected checkpoint, historical checkpoint entries, and all other context-invisible entries are
excluded from the suffix. No opaque content is decrypted or converted to text. On a verified commit,
Pi records the custom entry ID as a context-usage epoch boundary. Usage is unknown until a later
successful assistant response supplies valid non-zero usage; the boundary is restored from the active
branch and cleared on identity mismatch without Pi parsing checkpoint data.

The threshold state machine is derived from the active branch on every request:

| State | Behavior |
| --- | --- |
| canonical | canonical Pi payload; compact once when effective tokens exceed the threshold |
| replay clean | matching checkpoint and no canonical suffix; replay without a request |
| replay below threshold | matching checkpoint plus suffix within threshold; replay without a request |
| recompact | matching checkpoint plus an over-threshold suffix; one request and one proposal |
| mismatch | no opaque replay; one warning per session and exact identity; canonical payload |
| stale | no append and no dispatch |

Repeated preparation of an unchanged covered prefix produces zero compact calls and zero custom
entries. A growing suffix remains canonical until its first over-threshold preparation.

## Continuity

Opaque continuity is guaranteed only for the exact session fingerprint, provider, API, normalized base
URL, model, authentication binding, checkpoint ID, and covered active-branch entry. Provider, model,
authentication, or adaptor changes use canonical Pi history and never replay opaque output. The UI
emits one bounded, non-sensitive warning per selected identity. There is no portable migration,
automatic textual compaction, hidden compatibility flag, or fallback summary request. Starting a new
session is the supported recovery when canonical history does not fit the destination.

Old adaptor-specific checkpoint entries, automatic checkpoint kinds, and prior compaction details are
not read, written, migrated, or used as usage boundaries. They remain ordinary inert Pi custom entries
and are outside adaptor continuity guarantees. Ordinary Pi sessions and textual `CompactionEntry`
records remain readable through Pi without adaptor parsing. Install or upgrade acceptance starts a
new session.

## Pi host contract

The fork adds only an independently versioned optional capability:

```ts
providerCheckpointCommitApiVersion: 1;
setProviderCheckpointUsageBoundary?(entryId?: string): boolean;
```

The additive `providerCheckpoint` proposal and manual result are mutually exclusive with the existing
textual compaction proposal. Existing textual proposal behavior is unchanged. Pi's session schema,
`SessionEntry`, `CompactionEntry`, session migrations, and generic context projection do not gain
provider-specific branches.

## Protocol and configuration

Protocol v8 is bounded JSONL with request IDs, cancellation, acknowledgement/backpressure, approval,
and terminal results. It contains `responses.create`, `responses.compact`, `responses.estimate_context`,
`models.resolve`, `tools.resolve`, `tools.execute`, and `diagnostics.read`; context estimation is a
native pure operation over the exact request instructions and typed replay input. Capabilities include
`remote_compaction_v2`, `compact_endpoint`, and `context_estimation`.

The supported configuration is exact schema version `3` in
`~/.pi/agent/pi-codex-adaptor.json`. `security.approvalPolicy` is `on-request | never`, independently
from `security.filesystemAccessPolicy` as `workspace | unrestricted`. Defaults are
`on-request + workspace`; `never + unrestricted` is the explicit dangerous full-access combination.
Schema v2 is rejected and never migrated automatically. Compaction is `off` or `auto`, with a
model-derived or positive configured threshold below the model context window. The package is private
and is not published.

## Privacy and non-goals

Credentials enter native code only in bounded request-scoped connections. Prompts, messages, headers,
opaque output, account data, and absolute user paths do not enter diagnostics, fixtures, snapshots, or
errors. Native commands run with the user's permissions. Filesystem access policy governs only paths
explicitly handled by structured tools; neither policy axis is an OS sandbox.

The product does not add account usage, rate-limit windows, reset-credit handling, app-server agent
lifecycle, release publication, or registry installation automation.

# Bridge Protocol

Protocol version 2 is a bounded newline-delimited JSON channel between the TypeScript host and the
single native `codex-bridge` process. Each line contains exactly one object and is limited to
16 MiB, excluding the line terminator. The bridge advertises a maximum of 256 unacknowledged stream
events and reports paused and resumed backpressure states.

The host must initialize the connection before sending other frames. Initialization carries only
non-secret client identity. The handshake returns protocol,
official Codex, native target, project source, vendor tree, frame limit, and compiled capability
identity. A protocol or official baseline mismatch is fatal and must not be downgraded.

Every operation uses a request ID. IDs remain unique for a connection, and the bridge closes a
connection before retaining more than 65,536 IDs. Stream events also carry a monotonically
increasing sequence number. The host acknowledges consumed sequences, and the bridge stops producing
events when the advertised pending-event capacity is reached. Cancellation targets an existing
request ID. External I/O awaits race the request token, while mutating operations honor explicit
commit points. Shutdown bounds request joins and aborts tasks that do not finish after cancellation.
Approval IDs are opaque, server-generated values; approval waits race cancellation and always remove
their approval-map entry. A late or unknown `approval_decision` for an expired id completes as a
no-op and must not fail the bridge connection. Native sessions use separate write, resize, and
terminate frames but still return results through their request IDs.

OpenAI request, event, and result objects are opaque payloads at this boundary. Their typed ownership
stays in the pinned native modules. Unknown stream events are retained as opaque values and never
treated as successful termination. Only a `result` or `error` frame terminates an operation.

`responses.create` accepts the typed official request plus `transportMode: "auto" | "sse"` and a
provider WebSocket capability. Native code forces streaming, uses the official WebSocket client when
auto mode permits it, falls back to the official SSE client after a WebSocket connect failure, and
emits only the official client's validated events. `responses.compact` accepts the typed request,
`implementation: "remote_v2" | "compact_endpoint"`, the configured transport mode, and a provider
WebSocket capability. `remote_v2` appends the official compaction trigger, consumes the official
stream, requires exactly one official `compaction` output item followed by completion, and returns
that item unchanged. The compact-endpoint fallback returns canonical `ResponseItem` output unchanged.
The timeout defaults to 120 seconds and is bounded at 600 seconds. The bridge deserializes the
complete request into official field types before network I/O. The Pi integration stores returned
items in versioned compaction-entry details, restores them on session reload, substitutes them for
Pi's display-only summary on the next request, and passes them back without parsing or trimming.
Account rate-limit events are consumed and discarded at the native boundary.

`models.resolve` accepts an exact `{ "modelId": string }` and is credential-free and network-free. It
uses the pinned Codex model metadata closure, applying exact slug, longest-prefix, one-namespace
suffix, and official unknown-model fallback rules. It returns the canonical model record together
with its resolved compaction threshold, shell surface, and complete Codex provider capability
contract.

`tools.resolve` accepts validated official model metadata and explicit host capability inputs. It
returns model-visible and dispatch-only official tool JSON, plus shell/web resolution and reason.
Unified Exec keeps `shell_command` dispatch-only, and Responses Lite never receives a hosted web
tool. This method resolves contracts only; unsupported native executors are not advertised as bridge
capabilities.

`tools.execute` accepts the official shell surfaces with a command, canonical workspace roots, and
working directory. TypeScript constructs params from an adaptor-owned allowlist; model arguments are
never spread wholesale, and the test-only `testBaseUrl` override may only be supplied by host runtime
options. Native execution host-resolves only real supported shells from fixed system installation
directories, rejects workspace-relative or attacker-created executables such as
`./bash` or `/tmp/bash`, and emits an approval request that discloses the resolved shell plus
command before spawning through the official process adapter; a path outside every supplied root is
rejected before approval. Approval details use
workspace-relative path representations when a path is inside a supplied root, while command and file
summaries remain inspectable. Approval requests advertise only `decline`, `cancel`, and `allow_once`,
in that order, because Pi has no session-scoped approval policy surface. An unadvertised
`allow_session` decision is rejected with a protocol error and does not authorize execution; the
approval remains pending until a valid advertised decision arrives. Shell spawning applies official login-shell semantics (`-lc` / `-c`, PowerShell profile
rules) and truncates final tool output with the official token-budget helpers, defaulting to 10_000
tokens and reporting `original_token_count` when truncated. Unified Exec can yield a numeric session
identifier, accepts subsequent `write_stdin` polls, supports pipe and PTY processes, and drains
bounded output while the process remains in the native session table. Non-empty `write_stdin` input
waits for a command approval that includes the session id and a bounded inspectable input preview
before any process stdin write; empty polls remain non-mutating and do not re-prompt. Cancelling a
`write_stdin` poll terminates the process and removes the session deterministically. Non-empty
`session_write` control frames use the same approval-before-side-effect path as `write_stdin`
(session id plus bounded input preview; decline/cancel/non-echoing guarantees) and only mutate
process stdin after an advertised decision; empty session writes remain non-mutating and do not
re-prompt. Session resize and terminate control frames are correlated independently, and shutdown
terminates every remaining process tree. Output is streamed as acknowledged events and capped at one
MiB between polls.

`apply_patch` accepts the official freeform patch grammar, rejects absolute and parent-traversal
paths, verifies every source and move destination against canonical Pi-supplied workspace roots,
and waits for patch approval before invoking the pinned official parser and context matcher.
Cancellation is honored before approval and at an atomic commit point immediately before the
blocking filesystem apply begins. Once that apply starts, the request waits for completion and
reports the actual terminal outcome instead of claiming `aborted` while mutation continues. Tool
results list only workspace-relative affected paths; parser or filesystem failures do not expose
absolute paths across the bridge.

`view_image` resolves relative paths against the validated tool workdir (never the bridge process
CWD), canonicalizes the result under a Pi-supplied workspace root, waits for a filesystem approval
whose details prefer a workspace-relative path, bounds source and result sizes, and decodes or
resizes through the official image adapter. The returned data URL is converted to Pi
image content at the integration boundary and is not copied into diagnostics or tool details.

`image_gen.imagegen` keeps the official namespace and model-facing description. Native execution
uses the typed Images client with the pinned `gpt-image-2` defaults. Referenced files are canonical,
workspace-scoped, filesystem-approved, aggregate-size-bounded, and decoded through the official
image adapter; recent conversation images are selected by Pi and bounded to five. Every Images API call also waits for an
explicit network approval, and decline or cancel prevents server contact. Generated bytes are
base64-validated and size-limited before Pi receives image content, and are omitted from tool details
and diagnostics.

`web.run` keeps the official namespace and extension schema. It validates the official command union,
uses the typed Search client with the canonical conversation tail, waits for network approval, and
returns bounded official search output. Hosted `web_search` remains a Responses tool and is never
executed a second time through the Search client.

Credentials may appear only in request-scoped provider connections on stdin. The connection carries a
provider id, validated API root, ordinary provider headers, bearer-or-header-only authentication,
and an optional ChatGPT account id. Neither the connection nor its fields are persisted. Client
message and connection types deliberately omit debug formatting. Codec errors never include the
rejected frame, parser snippets, or credential-bearing fragments; invalid JSON and schema mismatches
map to stable `invalid_frame` protocol messages. Protocol fixtures contain no credentials, user
paths, account data, prompts, or compaction payloads.

The canonical v2 examples are [client-v2.jsonl](../fixtures/bridge-protocol/client-v2.jsonl) and
[server-v2.jsonl](../fixtures/bridge-protocol/server-v2.jsonl). Rust contract tests decode every
recorded frame and enforce size, one-frame, unknown-field, opaque-event, advertised approval order,
`allow_session` rejection, and safe malformed-frame behavior.

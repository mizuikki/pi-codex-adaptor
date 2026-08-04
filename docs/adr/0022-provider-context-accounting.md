# ADR 0022: Provider Replay Context Accounting

- Status: Accepted
- Date: 2026-08-04

## Context

Pi reports context usage for canonical messages, while the adaptor can dispatch a different replay
made from an opaque provider checkpoint plus a canonical suffix. After a large tool-output batch,
the canonical usage value can therefore remain below the automatic threshold even though the exact
provider replay exceeds the model window. The native bridge already preserved the provider's
`context_window_exceeded` code, but the Pi-facing wording did not enter Pi's bounded overflow
recovery lifecycle.

The pinned official Codex baseline does not trust one stale canonical estimate. It uses the last
server-reported total for an aligned history and adds a coarse model-visible estimate of items after
the latest model-generated item. When history is replaced by compaction, it recomputes the complete
active history.

Some provider proxies return the same context failure as an HTTP 200 JSON body rather than the
Responses SSE `response.failed` event. Without native normalization, that shape appears to Pi as a
generic stream failure and bypasses overflow recovery.

## Decision

Adopt bridge protocol v8 with the pure `responses.estimate_context` operation. Native Rust owns typed
`ResponseItem` estimation and model limits. TypeScript owns only session-affine alignment: a server
usage baseline is eligible when its exact prior input prefix, request-instructions digest,
provider/model/authentication identity, branch, and checkpoint generation all match the pending
replay. Ambiguous alignment falls back to an estimate of the request instructions plus complete
replay.

Check both the effective automatic threshold and hard model window before each activated ordinary
dispatch. A checkpoint replacement invalidates the accounting generation before dispatch; successful
ordinary response usage can establish the next baseline only for the still-current generation.
Older overlapping completions cannot overwrite newer state.

Provider replay and accounting do not depend on an inline checkpoint token. Pi may be unable to
prepare that token while a tool result is the active leaf. In that case the adaptor still rewrites an
existing checkpoint replay. If an uncheckpointed request has reached the threshold, the adaptor
returns Pi's context-overflow sentinel before provider dispatch; Pi then appends its bounded retry
state, prepares the checkpoint token, commits one provider checkpoint, and retries once. Before the
first checkpoint, the decision uses the conservative maximum of aligned server usage and the full
bounded estimate. After a checkpoint, an aligned current-generation server baseline remains
authoritative so the opaque replacement is not repeatedly compacted from a coarse full estimate.

Normalize both official SSE context failures and bounded, chunk-independent 200-JSON proxy failures to the native
`context_window_exceeded` code, then map only that trusted `BridgeRemoteError` to Pi's
`context_length_exceeded` sentinel. Pi retains ownership of the single compact-and-retry lifecycle;
the adaptor does not add another retry loop.

## Consequences

- Oversized checkpoint replay is compacted before an ordinary provider request even when Pi's
  canonical usage is stale or low.
- Checkpoint, navigation, model, provider, authentication, reload, session, and shutdown changes do
  not reuse incompatible server usage.
- Context estimation remains coarse and preserves the provider-authoritative ambiguous-Unicode
  decision in ADR 0021. Provider rejection remains the bounded fallback.
- Complete `codex-core`, its session/tool loop, and its persistence lifecycle remain outside the
  product closure. No Pi SDK, dynamic-workflow, checkpoint-schema, or pinned-vendor source change is
  introduced.

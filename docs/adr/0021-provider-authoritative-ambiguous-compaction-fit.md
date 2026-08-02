# ADR 0021: Provider-Authoritative Ambiguous Compaction Fit

- Status: Accepted
- Date: 2026-08-02

## Context

The native compact preflight estimated the complete JSON request as UTF-8 bytes divided by four and
treated that approximation as an exact model token count. Multilingual session content can occupy
several UTF-8 bytes per Unicode scalar, so the local estimate can exceed the effective model window
even when the upstream compact route accepts the same bounded request. The local rejection also used
the same error code and message as an upstream context-window rejection.

Removing preflight entirely would lose the useful no-dispatch boundary for plainly oversized
requests. Adding a tokenizer would introduce a model-coupled dependency without guaranteeing parity
with provider-side accounting, while passing Pi usage through the bridge would make stale turn-level
state part of the native compact contract.

## Decision

Serialize the complete compact request once and calculate two estimates with the same fixed overhead:

- the existing conservative estimate, `ceil(UTF-8 bytes / 4)`;
- a host-compatible text-density estimate, `ceil(UTF-16 code units / 4)`.

If either estimate fits the effective model window, treat the request as locally admissible and let
the provider compact route remain authoritative. If both exceed the limit, rewrite only the existing
contiguous trailing eligible tool outputs from newest to oldest and recalculate. Reject locally only
when both estimates remain over the limit.

Keep the bridge frame limit, per-output bounds, latest-output-batch budget, request shape, retry policy,
and provider dispatch ordering unchanged. Give local rejection the stable
`compaction_context_limit_exceeded` code and a fixed bounded message. Preserve the upstream
`context_window_exceeded` classification and bounded provider diagnostic.

## Consequences

- Multilingual requests are no longer rejected solely because the byte heuristic disagrees with a
  host-compatible text-density estimate.
- Clearly oversized ASCII-heavy requests still fail before a provider connection opens.
- CJK text, emoji, and uncommon scripts can make the UTF-16 estimate optimistic. This is an
  intentional handoff to the provider, not a tokenizer-equivalence claim; all such requests remain
  bounded by the frame and output policies.
- Local and upstream context failures are distinguishable without exposing request content.
- No bridge protocol, checkpoint schema, Pi SDK, or pinned vendor change is required.

## Rejected Alternatives

- Remove all local context fitting.
- Add a model tokenizer to the adaptor.
- Pass Pi's current context usage through a new bridge field.
- Rewrite arbitrary historical outputs beyond the contiguous trailing eligible batch.

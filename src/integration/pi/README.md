# Pi Integration

This layer owns Pi lifecycle wiring, provider activation, request attribution, message conversion,
approval binding, tool-profile isolation, and extension-owned Remote Compaction checkpoints.

Provider registration is process stable, but each dispatch is selected by the current Pi session ID.
Missing, stale, or ambiguous routes fail locally. The tool-profile coordinator suppresses Pi's core
tools while an activated Codex profile is healthy, preserves additive external tools, and restores
the captured selection on deactivation or shutdown.

The provider request guard supplies one live session/model/connection record and one Pi commit token.
The `before_provider_payload` hook may return a sealed payload and one provider checkpoint proposal.
Pi appends and reads back the context-invisible custom entry before provider dispatch. Stale, forged,
reused, cancelled, or indeterminate transactions block dispatch and are never retried. The guard
retains the adaptor handler's first failure and rethrows it before dispatch if Pi swallows the hook
exception; only existing trusted provider-error classes expose their bounded detail.

## Compaction

All Codex compaction triggers use the native `responses.compact` operation once per native attempt.
Manual and overflow handlers reuse the newest exact checkpoint fully contained in the prefix being
replaced, append only that prefix's canonical suffix, and return the provider-checkpoint result.
Threshold preparation returns a handled cancellation so the inline provider hook is the sole
threshold authority. The hook replays an exact matching checkpoint plus the canonical suffix, or
performs one remote operation when the suffix first exceeds the effective threshold.

Native compact preflight compares UTF-8-byte and UTF-16-density estimates of the complete request.
Both must overflow before eligible trailing outputs are rewritten or the request is rejected locally.
Estimator disagreement is provider-authoritative; local and upstream context failures use distinct
bounded codes.

Plain `/compact` is supported. Custom `/compact` instructions are rejected before dispatch because the
official remote operation does not accept them.

Checkpoints use only the v1 custom type
`pi-codex-adaptor.remote-compaction`. Pi's ordinary session schema and model projection remain
unchanged. The adaptor validates identity, branch coverage, output shape, and request freshness; Pi
owns append/readback and the usage-boundary entry ID. Older adaptor checkpoint data is inert and has
no reader or migration path.

Provider/model/authentication changes never replay opaque output. The adaptor keeps canonical Pi
history, emits one non-sensitive warning, and does not promise that the destination model can fit it.
Starting a new session is the supported recovery when it cannot.

Provider stream failures use the native bridge retry classification and Pi's existing provider error
mapping. The TypeScript integration has no compaction retry loop, timer, sleep, or second native
request.

`responseItemsFromMessages()` projects complete canonical message sequences and pairs tool calls with
their recorded results. Missing results receive one request-local error output; Pi session JSONL is
never mutated and tools are never replayed.

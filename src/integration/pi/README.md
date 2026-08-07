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
retains the adaptor handler's first failure. A tokenless checkpoint-threshold sentinel returns the
unchanged unapproved hook payload, avoiding a misleading extension diagnostic, and is rethrown by the
guard before dispatch. Other hook failures still escape directly and retain the same guard fallback
if Pi swallows them; only existing trusted provider-error classes expose their bounded detail.

## Compaction

All Codex compaction triggers use the native `responses.compact` operation once per native attempt.
Manual and overflow handlers reuse the newest exact checkpoint fully contained in the prefix being
replaced, append only that prefix's canonical suffix, and return the provider-checkpoint result.
Threshold preparation returns a handled cancellation so the inline provider hook is the sole
threshold authority. The hook replays an exact matching checkpoint plus the canonical suffix, or
performs one remote operation when the suffix first exceeds the effective threshold.

### Compaction UI boundary

Pi's textual compaction and its manual/overflow compaction lifecycle remain Pi-native. The adaptor
does not add a second Codex completion notification for those paths. Automatic compaction from
`before_provider_payload` is a separate adaptor-owned UI path: after a new remote request is known to
be eligible, it sets one Codex status and distinguishes the initial `threshold` phase from
`recompact`. Exact checkpoint replay does not start that status, make a remote request, or emit a
compaction notification.

The remote response is not the completion boundary. The adaptor clears the inline status and emits
one bounded success notice only after Pi reports a verified
`session_provider_checkpoint` transaction for the `provider_inline` trigger. Remote failure or
cancellation clears the status and emits outcome-only feedback; an indeterminate checkpoint commit
clears it without claiming success. Manual and overflow transaction events clear any stale adaptor
status but keep completion feedback owned by Pi. Missing status or notification methods are treated
as optional presentation capabilities and cannot block provider dispatch or checkpoint persistence.

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

The paired Pi host at the protected SDK tag `pi-extension-sdk-v1.3.1` gives a transaction-verified
checkpoint a host-owned `navigation.role = "provider_checkpoint"` projection and trusted
`tokensBefore` label. That makes the boundary visible and selectable in the default Session Tree while
keeping the checkpoint data opaque, context-invisible, and redacted from HTML export. The adaptor
optionally registers a renderer for this existing custom entry. The renderer uses the fixed
`Codex checkpoint` label and only the host-owned navigation role and `tokensBefore` metadata; it never
reads checkpoint data. The same safe marker is therefore available when supported entries are
reconstructed or reviewed in the Session Tree. Renderer registration is presentation-only, while
the adaptor continues to use the checkpoint entry ID and `session_tree` lifecycle to restore or clear
the active branch usage boundary.

Provider/model/authentication changes never replay opaque output. The adaptor keeps canonical Pi
history, emits one non-sensitive warning, and does not promise that the destination model can fit it.
Starting a new session is the supported recovery when it cannot.

Provider stream failures use the native bridge retry classification and Pi's existing provider error
mapping. The TypeScript integration has no compaction retry loop, timer, sleep, or second native
request.

`responseItemsFromMessages()` projects complete canonical message sequences and pairs tool calls with
their recorded results. Missing results receive one request-local error output; Pi session JSONL is
never mutated and tools are never replayed.

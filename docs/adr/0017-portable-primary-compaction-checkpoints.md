# ADR 0017: Portable-Primary Compaction Checkpoints

- Status: Accepted
- Date: 2026-07-24
- Supersedes: [0015](./0015-inline-automatic-compaction-and-opaque-replay.md)

## Context

The earlier inline automatic compaction design persisted a hidden opaque custom checkpoint and
treated OpenAI's compact output as the primary durable boundary. That design could not safely carry
compacted context across model, provider, account, or session identity changes because the opaque
window is provider-bound state, not a portable semantic summary. It also left manual and automatic
compaction on different durable contracts and forced the adaptor to reject ordinary Pi compaction
entries instead of treating them as valid portable context.

Pi now provides the paired pre-dispatch payload-hook transaction and retained-tail checkpoint model
needed to commit a real Pi `CompactionEntry` before provider dispatch while keeping provider payload
rewrites on a coding-agent-consumable public surface.

## Decision

Every new adaptor-owned compaction persists a real Pi `CompactionEntry` whose primary durable context
is:

- the Pi summary text, and
- the Pi-materialized `retainedTail`.

Adaptor-specific details use version `3` and store:

- `portable.summarySha256` for exact summary-boundary validation, and
- an optional opaque accelerator only when the returned compact output validates and matches the same
  normalized prefix as the portable summary request.

Automatic compaction now runs through the paired `before_provider_payload` transaction. The adaptor
prepares one normalized prefix and one token-bound retained tail, runs native portable summary and
opaque compact requests against that same prefix, rewrites the active provider payload, and returns
one proposal. Pi validates the token-bound leaf and retained-tail snapshot, appends the committed
entry, emits the committed event, and only then allows provider dispatch.

Manual and overflow compaction remain Pi-owned commit paths. They now require a portable summary
before returning a compaction result. Opaque compact is optional acceleration on the same durable
entry, not a separate checkpoint system.

Legacy automatic custom checkpoints and legacy manual opaque details remain readable:

- a matching identity may still replay them exactly;
- an identity change or opaque miss must migrate them from Pi's full canonical path into a new v3
  portable checkpoint before dispatch; and
- malformed claimed adaptor state fails closed rather than falling back to unsafe replay.

## Consequences

- Ordinary Pi compaction is a valid portable boundary instead of a blocked foreign checkpoint.
- Cross-model continuation is now correct by default because every new adaptor-owned compaction has a
  portable summary boundary.
- Opaque state remains a private accelerator that improves matching Codex requests but is never used
  as the sole durable context.
- Manual, overflow, automatic inline, reload, and migration paths now share one persisted v3
  contract instead of two unrelated checkpoint systems.
- Exact-identity replay, digest validation, retained-tail validation, and token-bound freshness
  checks become the security boundary for opaque reuse.

## Rejected alternatives

- Keeping the hidden opaque custom entry as the primary automatic checkpoint would preserve
  cross-model portability failures.
- Converting opaque output to prose in the adaptor would break the provider contract and invent a
  lossy client-side summary.
- Adding a user-facing switch between portable and opaque behavior would make correctness optional
  when portable summary is the required baseline.
- Running migration by probing storage backends directly would violate Pi's storage ownership and
  fork/reload semantics.

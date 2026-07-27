# Remote Compaction Verification

All values in this harness are synthetic. It does not persist credentials, user prompts, account
data, or real opaque output.

## Focused checks

The clean-slate application and Pi transaction checks are:

```sh
bun test tests/unit/compaction-checkpoint.test.ts
bun test tests/unit/codex-provider-request-guard.test.ts tests/unit/provider-session-router.test.ts
bun test tests/smoke/extension.test.ts tests/smoke/tool-surface.test.ts
npx vitest --run test/compaction-extensions.test.ts test/suite/agent-session-compaction.test.ts
cargo test --manifest-path native/Cargo.toml -p codex-bridge remote_v2
```

They cover strict v1 checkpoint parsing, inert legacy-shaped data, exactly one compaction item,
identity-bound warnings, coordinator release, canonical suffix projection, provider proposal sealing,
manual provider-checkpoint results, forged live-token rejection, append/readback ordering, and native
Remote V2 retry, delay, cancellation, output, and WebSocket fallback behavior.

The full verification command is:

```sh
bun run check
cargo test --manifest-path native/Cargo.toml --workspace
bun run test:pi-fork -- --pi-dir /absolute/path/to/pi --pi-ref <immutable-commit-or-tag>
```

## Behavioral gates

- every logical compaction calls `runtime.compact()` once at most;
- an unchanged covered prefix produces zero compact calls and zero custom entries on repeated
  preparations;
- a below-threshold suffix replays without a call, while the first over-threshold suffix produces one
  call and one proposal;
- exact identity replays opaque output plus the canonical suffix;
- provider, model, base URL, authentication, branch, session, or token mismatch never replays opaque
  output;
- append/readback indeterminacy blocks provider dispatch without a second append or retry;
- manual and overflow lifecycle success is explicit provider-checkpoint success, not cancellation or a
  textual compaction;
- context usage is unknown after commit and becomes valid only after a later assistant usage;
- native retry and backoff mutate no Pi payload and create no checkpoint on cancellation;
- ordinary Pi sessions and ordinary textual compactions remain readable without adaptor parsing;
- v5/v6 startup mismatch fails before provider registration;
- diagnostics contain no credentials, prompts, account data, opaque output, or local paths.

## Pi fork artifact harness

The paired fork verifier consumes the exact local SDK manifest, validates its commit and all four
tarball SHA-256 entries, creates isolated `<temp>/pi` and `<temp>/project` directories, installs every
SDK tarball directly into positive consumers, and runs the actual Pi loader with poison packages. The
positive local install path uses `pi install -l <absolute-source-path>` and cleanup uses
`pi remove <absolute-source-path> -l`; no registry installation or publication is part of this
product.

Tarball names are not provenance. The final evidence records the resolved immutable Pi ref and the
manifest digests rather than local paths or user values.

## Performance gate

Run the deterministic synthetic benchmark and compare the recorded baseline:

```sh
bun scripts/benchmark-compaction.ts
```

The input is a generated 10,000-entry, approximately 50 MiB JSONL branch. The benchmark records p50
and p95 canonical projection, checkpoint scan, suffix projection, and provider-hook preparation. A
change fails the gate when p95 grows by more than 20% or 50 ms, whichever allowance is larger.

The current run is recorded in
[`docs/evidence/compaction-benchmark-2026-07-27.md`](./evidence/compaction-benchmark-2026-07-27.md).

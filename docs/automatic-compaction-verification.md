# Automatic Compaction Verification

This record describes the public-API harness used for inline automatic compaction. Values in the
harness are synthetic; it does not persist credentials, prompts from a user session, or real opaque
provider output.

## Locked dependency graph

The adaptor's `package.json` and `bun.lock` pin the Pi packages to `0.81.1`. Run from the repository:

```sh
bun test tests/integration/automatic-compaction-continuation.test.ts
bun test tests/integration/compaction-failure-ownership.test.ts
bun test tests/unit/compaction.test.ts tests/unit/codex-compaction-replay.test.ts
bun test tests/unit/codex-provider-request-guard.test.ts tests/unit/provider-session-router.test.ts
bun run check:architecture
```

The integration harness uses public `SessionManager` methods, public `ExtensionAPI.appendEntry`,
`before_provider_request`, the real adaptor compaction registration, and the real provider dispatcher
composition. It asserts inline rewrite, same-run completion, active-branch custom-entry parentage,
pre-abort behavior, partial append persistence, file reload, and replay poison state. For Remote V2,
it also asserts that automatic compaction carries the routed session id and `auto` trigger and that the
following Responses request carries the same session id.

The failure-ownership harness uses public Pi `AgentSession`, `SessionManager`, extension-factory, and
UI surfaces. It forces native compaction rejection for both manual and overflow entry points and
installs a sentinel fallback stream. A characterization first proves that Pi invokes that stream and
persists a textual compaction after a legacy handler exception is swallowed. The fixed-path
assertions require zero fallback calls, no new Pi
`CompactionEntry`, an unchanged branch and leaf, no adaptor store snapshot, an idle coordinator, no
route-unavailable error, one fixed interactive notification, and identical terminal behavior with
Pi's headless no-op UI.

The focused failure regression is:

```sh
bun test tests/unit/compaction.test.ts tests/unit/provider-session-router.test.ts
bun test tests/integration/compaction-failure-ownership.test.ts
bun test tests/integration/automatic-compaction-continuation.test.ts
```

## Synchronized local host

The synchronized Pi `0.81.1` local fork is verified in an isolated consumer. The harness archives the
selected commit, installs and builds its dependencies without lifecycle scripts, packs the `tui`, `ai`,
`agent`, and `coding-agent` workspaces, installs those tarballs into a temporary adaptor copy, confirms
that all four package imports resolve inside that copy, and runs loader plus focused request and
compaction suites. It does not reuse this checkout's `node_modules` or `bun.lock` resolutions.

```sh
SYNC_PI_DIR=/path/to/pi
SYNC_PI_COMMIT=ae166c1366239363ccc1cab1906f8a5b4e07c6f0
bun run test:pi-fork -- --pi-dir "$SYNC_PI_DIR" --pi-ref "$SYNC_PI_COMMIT"
```

The recorded synchronized commit is `ae166c1366239363ccc1cab1906f8a5b4e07c6f0`. The harness prints
that resolved commit and the SHA-256 of every packed Pi workspace tarball as the compatibility proof.
The Pi `0.81.1` attribution contract supplies the same non-empty session id, explicit `agent`,
`compaction_summary`, or `branch_summary` origin, and request-scoped abort signal to the provider hook.
The adaptor accepts authenticated auxiliary requests unchanged and only applies automatic checkpoint
replay to normal agent requests.

## Historical 0.80.6 host inspection

The earlier local-host observation used commit `01aade936f90d64cc5ab5fbfb3269ea3a72e3c7a`; the
upstream `v0.80.10` tag then resolved to `8dc78834cde4e329284cf505f9e3f99763df5529`. This historical
host was post-tag and lacked the complete auxiliary request attribution contract. Its focused runner
checks and separate extension-order failures are not evidence for the locked `0.81.1` graph.

## Observable residuals

The harness does not claim atomic `appendEntry` rollback, remote acceptance semantics after a local
abort, deterministic lease release from bare `AgentSession.dispose()`, or visibility into Pi-swallowed
later hook exceptions. These are public-host limitations documented in the product ADR.

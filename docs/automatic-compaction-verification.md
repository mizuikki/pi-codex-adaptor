# Automatic Compaction Verification

This record describes the public-API harness used for inline automatic compaction. Values in the
harness are synthetic; it does not persist credentials, prompts from a user session, or real opaque
provider output.

## Locked dependency graph

The adaptor's `package.json` and `bun.lock` pin the Pi packages to `0.80.6`. Run from the repository:

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

## Exact local host

The local host verification target was checked with:

```sh
PI_HOST_CHECKOUT=/path/to/pi
git -C "$PI_HOST_CHECKOUT" rev-parse HEAD
git -C "$PI_HOST_CHECKOUT" rev-parse v0.80.10
(cd "$PI_HOST_CHECKOUT" && bun test packages/coding-agent/test/extensions-runner.test.ts)
```

The recorded local host commit is
`01aade936f90d64cc5ab5fbfb3269ea3a72e3c7a`; the upstream tag resolves to
`8dc78834cde4e329284cf505f9e3f99763df5529`. The host commit is not the tag. The host runner tests
verify public hook sequencing and swallowed-hook-error behavior; the focused host ownership tests
passed, while the complete host runner file currently has four unrelated extension-order assertions
failing at this post-tag commit. The adaptor integration test runs against the locked dependency
graph because the package imports the pinned `0.80.6` dependency surface. Results from these two
environments are reported separately.

## Observable residuals

The harness does not claim atomic `appendEntry` rollback, remote acceptance semantics after a local
abort, deterministic lease release from bare `AgentSession.dispose()`, or visibility into Pi-swallowed
later hook exceptions. These are public-host limitations documented in the product ADR.

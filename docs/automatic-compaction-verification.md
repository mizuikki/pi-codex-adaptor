# Automatic Compaction Verification

This record describes the public-API harness used for inline automatic compaction. Values in the
harness are synthetic; it does not persist credentials, prompts from a user session, or real opaque
provider output.

## Locked dependency graph

The adaptor's `package.json` and `bun.lock` retain sibling Pi file development dependencies and
wildcard runtime peers. An upstream public Pi host is not a compatible runtime host for this feature:
the paired Pi fork must expose `extensionSdkApiVersion === 1` and
`providerPayloadCompactionApiVersion === 1` to extension factories. Run from the repository:

```sh
bun test tests/integration/automatic-compaction-continuation.test.ts
bun test tests/integration/compaction-failure-ownership.test.ts
bun test tests/unit/compaction.test.ts tests/unit/codex-compaction-replay.test.ts
bun test tests/unit/codex-provider-request-guard.test.ts tests/unit/provider-session-router.test.ts
bun run check:architecture
```

The integration harness uses public `SessionManager` methods, the paired
`before_provider_payload` contract, the real adaptor compaction registration, and the real provider
dispatcher composition. It asserts inline rewrite, same-run completion, pre-dispatch commit ordering,
active-branch real compaction-entry parentage, token-bound retained-tail validation, pre-abort
behavior, partial append persistence, file reload, portable-only fallback, and replay poison state.
For Remote V2, it also asserts that the following Responses request carries the routed session id when
the rewritten request still begins with a matched opaque prefix.

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

## Fork-pinned host

The paired Pi fork is verified in a clean consumer through `scripts/local-fork-fixture.mjs`. Its
`prepare` command delegates SDK packing to `pack-local-sdk.mjs`; the harness then uses `install-sdk`
and `create-consumer` with the resulting manifest. The manifest records the exact commit, private SDK
versions, capability levels, relative tarball paths, and SHA-256 values. The harness validates that
manifest before installation, creates `<temp>/pi` plus `<temp>/project`, and installs all four SDK
tarballs directly in the positive consumer. It does not reuse the checkout's `node_modules` or the
adaptor's `bun.lock` resolutions.

```sh
PI_EXTENSION_SDK_DIR=<clean-pi-sdk-checkout>
PI_EXTENSION_SDK_REF=<immutable-sdk-tag-or-commit>
bun run test:pi-fork -- --pi-dir "$PI_EXTENSION_SDK_DIR" --pi-ref "$PI_EXTENSION_SDK_REF"
```

The delivery record must contain the resolved commit and the manifest SHA-256 values for all four SDK
tarballs. Tarball names are not provenance.

The paired attribution contract supplies the same non-empty session id, explicit `agent`,
`compaction_summary`, or `branch_summary` origin, and request-scoped abort signal to the provider
hook. The adaptor accepts authenticated auxiliary requests unchanged and only applies automatic
checkpoint replay to normal agent requests.

## Upstream-host rejection

An upstream host lacks the private extension SDK and paired transaction markers. Tarball and loader
smoke tests require a clear incompatibility error from that host. This is intentional: package
version equality is not evidence that a host contains the required runtime contracts.

## Observable residuals

The harness does not claim atomic `appendEntry` rollback, remote acceptance semantics after a local
abort, deterministic lease release from bare `AgentSession.dispose()`, or visibility into Pi-swallowed
later hook exceptions. These are public-host limitations documented in the product ADR.

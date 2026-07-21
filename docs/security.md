# Security Design

Pi packages execute with the user's full permissions. This project therefore treats source
provenance, explicit authorization, and diagnostic redaction as product requirements. `prompt` is the
safe default. `bypass` is an explicit Pi-owned per-request authorization mode, not an OS sandbox:
native commands run with the user's permissions, and workspace roots do not sandbox shell behavior.

## Approval policy

The exact configuration v2 shape requires `security.approvalPolicy` with one of `prompt` or `bypass`.
Pi loads one validated snapshot at the beginning of each registered native tool call and maps it to
one required bridge authorization value. The snapshot is not cached on the bridge and a configuration
change cannot switch the policy halfway through an active operation.

The preauthorization allowlist is fixed: `exec_command`, `shell_command`, non-empty `write_stdin`,
non-empty `session_write`, `apply_patch`, `view_image`, `image_gen.imagegen`, and `web.run`. Empty
stdin/session writes remain non-mutating polls. Bypass emits no approval request or decision frame and
does not allocate approval state, while native validation, workspace containment, cancellation, and
atomic patch commit checks remain mandatory. Preauthorization for an unsupported tool is rejected.

- TypeScript builds `tools.execute` params from an adaptor-owned allowlist. Model tool arguments are
  never spread into the bridge request. Provider connections are attached only to Responses,
  Search, and image-generation requests; shell, PTY, patch, plan, and local image operations stay
  credential-free.
- While Codex is active, Pi's seven core execution routes are absent from the active profile. This
  prevents a model from bypassing native shell, patch, and file-operation controls through Pi's
  alternate core tools; inactive providers restore the previously active Pi core selection.
- Official shell tool schemas still expose the `shell` parameter, but native execution host-resolves
  only real supported shells from fixed system installation directories, rejects
  workspace-relative or attacker-created executables such as `./bash` or `/tmp/bash`, rejects
  arbitrary programs such as Python or Node, and discloses the resolved shell plus command in the
  approval summary and details before spawning.
- In prompt mode, commands, patches, filesystem reads, network actions, non-empty Unified Exec
  `write_stdin` writes, and non-empty `session_write` control frames wait for Pi approval and
  workspace policy decisions before native execution. Empty `write_stdin` polls and empty session
  writes remain non-mutating and do not re-prompt. Session write approvals include the session id
  and a bounded input preview for inspection; that preview must not appear in diagnostics. Approval
  requests advertise only `decline`, `cancel`, and `allow_once` in that order; unadvertised
  `allow_session` is rejected and never authorizes execution. Approval waits race request
  cancellation, use opaque server-generated IDs, dispose the Pi approval UI fail-closed, remove
  native approval-map entries on every cancel or drop path, and never authorize a late decision for
  an expired approval id. A late or unknown approval decision caused by cancellation completes as a
  no-op and must not fail the entire bridge connection. `image_gen.imagegen` requires network
  approval before any Images API call in addition to referenced-file approval.
- In bypass mode, the same operations run only after validation and the same cancellation/commit
  checks, but the bridge returns directly from authorization without an approval frame or map entry.
  Referenced images still have aggregate raw and encoded memory limits.
- `apply_patch` defines an atomic commit point immediately before the blocking filesystem apply.
  Cancellation before that point prevents mutation. After the apply begins, the request waits for
  the real terminal outcome rather than reporting `aborted` while files continue to change.
- `view_image` resolves relative paths against the validated tool workdir rather than the bridge
  process CWD, then enforces workspace-root containment before approval and file reads.
- Approval details prefer workspace-relative paths when a representation under a supplied root is
  sufficient, while retaining inspectable command and file summaries.
- Credentials are delivered through bounded stdin request frames, never argv or persisted config.
- Provider connection timeouts are bounded. Finite `timeoutMs` and `websocketConnectTimeoutMs`
  values are limited to 24 hours. The only exception is Pi's disabled HTTP idle-timeout sentinel
  `2147483647` on `timeoutMs`, which is an explicit unbounded stream-idle mapping rather than an
  open-ended numeric range. Arbitrary values above the 24-hour bound remain rejected.
- Prompts, messages, credentials, complete headers, absolute user paths, account data, and opaque
  compaction items are excluded from logs and default diagnostics.
- Opaque checkpoint windows are sensitive provider output. They are cloned into versioned Pi session
  data and bound to the active session, branch boundary, provider, base URL, API, model, and
  authentication identity. No client-side decryption occurs, and the encrypted string is never used
  as a summary, error message, fixture assertion message, or diagnostic value. An official JWT account
  claim may survive credential refresh; an explicit conflicting account header, non-JWT bearer, or
  missing bearer fails closed or binds to the exact credential as defined by the provider contract.
- The request guard is extension-instance local. The process router stores only weak session leases;
  it does not retain credentials, opaque windows, payload approvals, or compaction state. A replaced,
  stale, ambiguous, or mismatched route cannot reach compact, append, fallback, or Responses dispatch.
- Activated Codex compaction failure returns terminal cancellation before Pi can invoke its
  session-unattributed default summarizer. Recovery never relaxes strict session routing or selects a
  lease by process order, liveness, model, or request shape. The only failure notification is fixed
  text; it contains no dynamic exception, provider, credential, URL, session, prompt, path, response,
  header, or opaque-output data. A missing or failed UI notification does not permit fallback.
- Responses transport is implemented only by pinned official native modules. TypeScript does not add
  a second retry, SSE, or WebSocket implementation. When a provider stream fails, the Pi integration
  maps only a strict, protocol-decoded `BridgeRemoteError.retryable` classification into Pi's existing
  safe assistant-error text. That mapping is a redacted compatibility surface; it does not schedule a
  retry, reconnect the bridge, or issue a second provider request. Pi retains host-owned retry
  scheduling, backoff, cancellation, and UI for normal agent turns.
- The complete provider contract is declared explicitly for every `tools.resolve` call. Missing
  required contract fields fail with `provider_contract_incomplete`, while provider endpoints that
  respond as unsupported fail with `provider_contract_mismatch`. Errors name only the missing
  capability and never include endpoint URLs, response bodies, or credentials.
- Shell-command models may receive adaptor-owned `exec_command` and `write_stdin` schemas only when
  the verified bridge exposes the managed session executor and background sessions are enabled.
  Requests fail closed when the native executor is missing, and the provider receives one bounded
  supplemental instruction describing the session contract.
- Vendor synchronization uses immutable commits, an explicit allowlist, file hashes, replayable
  patches, license inventory, and a deterministic tree hash.
- Native artifacts and the final npm tarball must carry checksums and source provenance. Local native
  builds require a clean Git worktree and unchanged `HEAD` through install verification.
- Runtime loading of a packaged sidecar verifies `native-artifact.json` and the executable digest
  before spawn; mismatches fail closed.
- Diagnostics export requires a user confirmation and contains only the allowlisted bridge identity,
  capability list, and configuration schema version; it never serializes configuration values.

Rate-limit snapshots are discarded at the native boundary. Account usage and reset-credit handlers
must not enter the bridge protocol or production build.

## Runtime packaged-sidecar integrity

Production launches resolve `native/bin/<target>/native-artifact.json` next to the bundled
`codex-bridge` executable. The loader validates:

- `schemaVersion`, target triple, and executable basename;
- project source commit and official Codex baseline fields (version, tag, source commit, vendor tree);
- bridge protocol version;
- executable size and streamed SHA-256 digest.

Verification runs before `spawn`. Failures surface as safe `BridgeLoaderError` codes
(`missing_artifact`, `invalid_artifact`, `artifact_tampered`) without path dumps, digests, or process
details. The verified project source commit is required to match the bridge handshake
`buildSourceCommit`. Development and test paths that supply an alternate executable must set
`allowDevelopmentBuild: true` explicitly; setting that flag alone does not bypass packaged integrity
checks for the release layout.

## Bridge child environment

`codex-bridge` is spawned with a narrowed environment. Required runtime variables such as `PATH`,
locale, temporary directories, proxy settings, and TLS trust roots are preserved. Proxy URLs that
contain userinfo credentials are rejected before spawn without exposing their values. Other
credential-bearing variables are removed so OAuth and API credentials can arrive only through
bounded stdin request-scoped provider connections.

## Log redaction

`src/domain/redaction.ts` is the shared redaction policy. Tokens, authorization headers, prompts and
other user content, absolute user paths, and opaque compaction data are replaced with placeholders
before any log, diagnostic, or error surface is emitted. Unit tests assert that redacted output does
not retain the original values.

# Security Design

Pi packages execute with the user's full permissions. This project therefore treats source
provenance, explicit authorization, and diagnostic redaction as product requirements.

- TypeScript builds `tools.execute` params from an adaptor-owned allowlist. Model tool arguments are
  never spread into the bridge request, and the test-only `testBaseUrl` override may only come from
  host runtime options so injected base URLs cannot receive Authorization headers.
- Official shell tool schemas still expose the `shell` parameter, but native execution host-resolves
  only real supported shells from fixed system installation directories, rejects
  workspace-relative or attacker-created executables such as `./bash` or `/tmp/bash`, rejects
  arbitrary programs such as Python or Node, and discloses the resolved shell plus command in the
  approval summary and details before spawning.
- Commands, patches, filesystem reads, network actions, non-empty Unified Exec `write_stdin` writes,
  and non-empty `session_write` control frames must wait for Pi approval and workspace policy
  decisions before native execution. Empty `write_stdin` polls and empty session writes remain
  non-mutating and do not re-prompt. Session write approvals include the session id and a bounded
  input preview for inspection; that preview must not appear in diagnostics. Approval requests
  advertise only `decline`, `cancel`, and `allow_once` in that order; unadvertised `allow_session` is
  rejected and never authorizes execution. Approval waits race request cancellation, dispose the Pi
  use opaque server-generated IDs, dispose the Pi approval UI fail-closed, remove native approval-map
  entries on every cancel or drop path, and never authorize a late decision for an expired approval
  id. A late or unknown approval decision caused by cancellation completes as a no-op and must not
  fail the entire bridge connection.
  `image_gen.imagegen` requires network approval before any Images API call in addition to
  referenced-file approval, and referenced images have aggregate raw and encoded memory limits.
- `apply_patch` defines an atomic commit point immediately before the blocking filesystem apply.
  Cancellation before that point prevents mutation. After the apply begins, the request waits for
  the real terminal outcome rather than reporting `aborted` while files continue to change.
- `view_image` resolves relative paths against the validated tool workdir rather than the bridge
  process CWD, then enforces workspace-root containment before approval and file reads.
- Approval details prefer workspace-relative paths when a representation under a supplied root is
  sufficient, while retaining inspectable command and file summaries.
- Credentials are delivered through bounded stdin protocol frames, never argv or persisted config.
- Prompts, messages, credentials, complete headers, absolute user paths, account data, and opaque
  compaction items are excluded from logs and default diagnostics.
- Responses transport is implemented only by pinned official native modules. TypeScript does not add
  a second retry, SSE, or WebSocket implementation.
- Vendor synchronization uses immutable commits, an explicit allowlist, file hashes, replayable
  patches, license inventory, and a deterministic tree hash.
- Native artifacts and the final npm tarball must carry checksums and source provenance.
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
bounded stdin `initialize` and `authentication_update` frames.

## Log redaction

`src/domain/redaction.ts` is the shared redaction policy. Tokens, authorization headers, prompts and
other user content, absolute user paths, and opaque compaction data are replaced with placeholders
before any log, diagnostic, or error surface is emitted. Unit tests assert that redacted output does
not retain the original values.

# Codex Bridge Infrastructure

Sidecar discovery, lifecycle, JSONL envelopes, cancellation, and binary manifest verification belong
here. OpenAI transport details stay in Rust.

`protocol.ts` is the runtime-validated TypeScript view of adaptor-owned protocol v1 envelopes. Its
request, event, and result payloads remain `unknown`; it does not define OpenAI wire schemas.

`client.ts` owns bounded process I/O, handshake verification, request correlation, event ordering,
automatic acknowledgements, cancellation, and safe shutdown. `runtime.ts` races approval UI against
the request `AbortSignal`, never forwards a late decision for an expired approval id, and clears a
fatally failed client so the next request reconnects without logging credentials. `binary.ts` maps only the five declared
release targets to target-scoped package executables, verifies packaged `native-artifact.json`
identity and executable digests before spawn, and requires an explicit `allowDevelopmentBuild` for
override paths.

`environment.ts` builds the narrowed child-process environment used by `spawnBridgeTransport`.
Credential-bearing proxy URLs are rejected, and other credential variables are excluded so secrets
can only arrive through initialize and authentication_update frames.

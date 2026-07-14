# Security Design

Pi packages execute with the user's full permissions. This project therefore treats source
provenance, explicit authorization, and diagnostic redaction as product requirements.

- Commands, patches, filesystem reads, and network actions must wait for Pi approval and workspace
  policy decisions before native execution.
- Credentials are delivered through bounded stdin protocol frames, never argv or persisted config.
- Prompts, messages, credentials, complete headers, absolute user paths, account data, and opaque
  compaction items are excluded from logs and default diagnostics.
- Responses transport is implemented only by pinned official native modules. TypeScript does not add
  a second retry, SSE, or WebSocket implementation.
- Vendor synchronization uses immutable commits, an explicit allowlist, file hashes, replayable
  patches, license inventory, and a deterministic tree hash.
- Native artifacts and the final npm tarball must carry checksums and source provenance.

Rate-limit snapshots are discarded at the native boundary. Account usage and reset-credit handlers
must not enter the bridge protocol or production build.

# Compatibility

No runtime compatibility range is declared for version `0.0.0`.

The adaptor is delivered with a paired Pi fork, not with an upstream Pi npm release. The local
`@earendil-works/pi-*` SDK graph uses wildcard runtime peers and sibling `file:` dependencies only
for development; it is not a runtime dependency graph. A compatible host exposes
`ExtensionAPI.extensionSdkApiVersion === 1`,
`ExtensionAPI.providerPayloadCompactionApiVersion === 1`, and
`ExtensionAPI.providerCheckpointCommitApiVersion === 1` with
`setProviderCheckpointUsageBoundary`, and
`ExtensionAPI.compactionFailureResultApiVersion === 1`.
The adaptor rejects a host without that marker before it registers providers or before any provider
dispatch can occur.

Verify an exact clean sibling Pi commit with `bun run test:pi-fork`. The test consumes its SDK
manifest and validates tarball digests; do not substitute a package version, branch name, workspace
link, local path, or tarball filename for that record.

The repository skeleton is developed with:

| Component | Pinned or tested version |
| --- | --- |
| OpenAI Codex source | `0.146.0` / `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` |
| Bun | `1.3.14` |
| TypeScript | `7.0.2` |
| Node.js development runtime | `24.18.0` |
| npm CLI | `12.0.1` |
| Rust | `1.95.0` |
| Pi development source | sibling `../pi` workspaces |
| Pi runtime host | extension SDK API version `1`, provider payload compaction API version `1`, provider checkpoint commit API version `1`, compaction failure result API version `1` |
| TypeBox | `1.3.6` |

Before the first release, installation and loading will be tested on the candidate Node.js floor,
the latest LTS, and the current stable release. Supported operating-system targets will be listed
only after native artifact and real installation smoke tests pass on each target.

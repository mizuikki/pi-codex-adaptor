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

Codex Responses transport is owned by the native bridge. A defined Pi
`SimpleStreamOptions.fetch` callback cannot cross the JSON bridge, so the adaptor rejects custom
fetch before configuration, payload approval, or native dispatch with a bounded capability error.
Omit `fetch` to use the ordinary native transport path.

Verify an exact clean sibling Pi commit with `bun run test:pi-fork`. The test consumes its SDK
manifest and validates tarball digests; do not substitute a package version, branch name, workspace
link, local path, or tarball filename for that record.

The current paired host baseline is the protected `pi-extension-sdk-v1.3.1` tag from
`https://github.com/mizuikki/pi.git`. Its annotated tag object is
`91323be540c4618bc337e71e8f46b869f3d78374`, and its peeled commit is
`769eaaba2ead3e9153d4460dd64b040f9703a9f8`. The manifest's `forkCommit` and SHA-256 entries remain
the authoritative provenance; the tag is the immutable CI selection. This host baseline also
exposes the verified provider-checkpoint navigation role: Pi displays the navigation boundary while
the adaptor keeps its provider payload opaque and context-invisible.

The repository skeleton is developed with:

| Component | Pinned or tested version |
| --- | --- |
| OpenAI Codex source | `0.146.0` / `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` |
| Bun | `1.3.14` |
| TypeScript | `7.0.2` |
| Node.js development runtime | `24.18.0` |
| npm CLI | `12.0.1` |
| Rust | `1.95.0` |
| Pi development source | sibling `../pi` workspaces; blocking CI baseline `pi-extension-sdk-v1.3.1` / `769eaaba2ead3e9153d4460dd64b040f9703a9f8` |
| Pi runtime host | extension SDK API version `1`, provider payload compaction API version `1`, provider checkpoint commit API version `1`, compaction failure result API version `1` |
| Pi provider-checkpoint navigation | Host-owned `navigation.role = "provider_checkpoint"` and trusted `tokensBefore`; visible in the default Session Tree without exposing opaque checkpoint data |
| TypeBox | `1.3.7` |

Before the first release, installation and loading will be tested on the candidate Node.js floor,
the latest LTS, and the current stable release. Supported operating-system targets will be listed
only after native artifact and real installation smoke tests pass on each target.

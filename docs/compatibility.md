# Compatibility

No runtime compatibility range is declared for version `0.0.0`.

The adaptor is delivered with a paired Pi fork, not with an upstream Pi npm release. The public
`@earendil-works/pi-*` `0.81.1` development graph is only a build baseline and is not a compatible
runtime host. A compatible host exposes `ExtensionAPI.providerPayloadCompactionApiVersion === 1`.
The adaptor rejects a host without that marker before it registers providers or before any provider
dispatch can occur.

The recorded runtime host is
[`mizuikki/pi`](https://github.com/mizuikki/pi) at
`44a2567c5d3c183e7af4375b195d15df468181c3` (no tag), with
`providerPayloadCompactionApiVersion === 1`. Verify that exact clean checkout with
`bun run test:pi-fork`. Do not substitute a package version, a branch name, a workspace link, or a
local path for that record.

The repository skeleton is developed with:

| Component | Pinned or tested version |
| --- | --- |
| OpenAI Codex source | `0.144.3` / `78ad6e6bfd1d3b6a209acd3ef82172a96b25179c` |
| Bun | `1.3.14` |
| TypeScript | `7.0.2` |
| Node.js development runtime | `24.18.0` |
| npm CLI | `12.0.1` |
| Rust | `1.95.0` |
| Pi package development baseline | `0.81.1` |
| Pi runtime host | `mizuikki/pi` `44a2567c5d3c183e7af4375b195d15df468181c3`, provider payload compaction API version `1` |
| TypeBox | `1.3.6` |

Before the first release, installation and loading will be tested on the candidate Node.js floor,
the latest LTS, and the current stable release. Supported operating-system targets will be listed
only after native artifact and real installation smoke tests pass on each target.

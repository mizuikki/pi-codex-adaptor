# ADR 0018: Private Local Pi Fork Integration

- Status: Accepted
- Date: 2026-07-25
- Supersedes: [0009](./0009-release-please-and-exact-tarball-publishing.md)

## Context

The adaptor depends on Pi extension APIs that do not exist in the upstream package with the same
base version. Registry installation and publication automation could therefore produce a package
whose declared compatibility does not match its required runtime host.

## Decision

Treat the adaptor as a private local extension for the sibling Pi fork. Direct Pi SDK imports remain
exact peers at `0.81.1-local.1`; development dependencies resolve from `file:../pi/packages/...`.
The Pi host must advertise provider payload compaction API version `1` before the adaptor registers
providers.

Install the extension only as a local Pi source. Remove npm publication, GitHub Release, and Release
Please automation. Package assembly remains available only for manifest-driven isolated consumer
verification and never publishes an artifact.

Positive compatibility verification consumes all four SDK tarballs and their SHA-256 values from
the Pi SDK manifest. The upstream-host negative fixture bypasses peer resolution only to verify the
runtime capability rejection through the real Pi loader.

## Consequences

- The sibling Pi checkout is part of the required development environment.
- The repository has no supported npm registry installation or release path.
- SDK package versions and runtime capability versions jointly define compatibility.
- Local package tarballs are disposable verification artifacts, not releases.

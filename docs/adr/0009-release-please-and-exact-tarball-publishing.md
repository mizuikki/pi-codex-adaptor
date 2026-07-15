# ADR 0009: Release Please and Exact-tarball Publishing

- Status: Accepted
- Date: 2026-07-14

## Context

The repository needs deterministic version changes, reviewable changelogs, tokenless routine
publishing, and recovery from partial release failures.

## Decision

Use Conventional Commits and Release Please to create version pull requests and update `package.json`,
`.release-please-manifest.json`, and `CHANGELOG.md`. Release Please does not tag, create GitHub
releases, or publish npm packages. Pull request labels validate release intent and categorize notes;
they do not calculate versions.

Assemble one tarball, verify its whitelist, licenses, checksums, native manifest, and clean Pi install,
then publish those exact bytes through npm Trusted Publishing. Create the Git tag and GitHub Release
only after npm succeeds.

Prerelease versions publish with the npm dist-tag `rc`. Stable versions publish with `latest`. Release
manifests record locked toolchain versions, official Codex identity, vendor tree hash, bridge protocol
version, conformance package integrity, tarball SHA-256/SRI, and native checksums.

If npm already contains the version but the Git tag or GitHub Release is missing, recovery verifies
registry integrity against the saved release-commit artifact before finalize. A Git tag or GitHub
Release without a matching npm publication is an impossible state and fails closed. Tags and releases
always target the exact release source commit.

## Consequences

- The repository does not use Changesets or a custom version calculator.
- `0.1.0-rc.0` may use the documented one-time bootstrap path; later releases require OIDC.
- Recovery verifies registry integrity and the saved release manifest before completing missing tags or
  releases.
- `release-as` bootstrap overrides are limited to `0.1.0-rc.0` and `0.1.0` and must be cleared after the
  corresponding tag exists.
- Release and native artifacts retain for 30 days to cover finalize recovery. Native artifacts are
  attested at build time and verified before packaging when GitHub Actions attestation APIs are
  available.

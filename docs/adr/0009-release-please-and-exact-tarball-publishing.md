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

## Consequences

- The repository does not use Changesets or a custom version calculator.
- `0.1.0-rc.0` may use the documented one-time bootstrap path; later releases require OIDC.
- Recovery verifies registry integrity and the saved release manifest before completing missing tags or
  releases.

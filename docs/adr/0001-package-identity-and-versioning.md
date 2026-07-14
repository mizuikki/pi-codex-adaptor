# ADR 0001: Package Identity and Versioning

- Status: Accepted
- Date: 2026-07-14

## Context

The project needs one stable public identity across its source repository, npm package, diagnostics,
release artifacts, and installation documentation.

## Decision

Use `pi-codex-adaptor` as both the repository and npm package name. Keep a single repository and a
single public npm package. The repository skeleton uses version `0.0.0`; prereleases begin at
`0.1.0-rc.0`, and the first stable release is `0.1.0`.

## Consequences

- `package.json#version` is the product version source of truth.
- Release manifests, tags, diagnostics, and native artifacts use the same version.
- Splitting public packages requires a future ADR backed by measured delivery constraints.

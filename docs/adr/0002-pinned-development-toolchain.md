# ADR 0002: Pinned Development Toolchain

- Status: Accepted
- Date: 2026-07-14

## Context

Reproducible builds require explicit versions while the TypeScript and native implementations must
remain aligned with their respective runtime constraints.

## Decision

Use Bun `1.3.14`, TypeScript `7.0.2`, Node.js `24.18.0` LTS, npm `12.0.1`, Biome `2.5.3`, and Rust
`1.95.0`. Use the stable `tsc` CLI without the TypeScript programmatic API. Pin lockfiles and
third-party GitHub Actions by complete commit SHA.

Rust and its Codex-coupled dependencies move only with an explicit Codex baseline update. Other minor
and patch updates require lockfile verification; major toolchain updates require a dedicated change.

## Consequences

- `fixtures/toolchain.json` is checked against package, workflow, Node.js, and Rust configuration.
- Direct and transitive Node.js development types remain on the Node.js 24 line.
- CI installs exact Bun, Node.js, and npm versions instead of floating release channels.

# Architecture Decision Records

This directory records decisions that shape the product across multiple modules or releases. Each ADR
uses the same structure: context, decision, and consequences.

| ADR | Decision |
| --- | --- |
| [0001](./0001-package-identity-and-versioning.md) | Independent package identity and version line |
| [0002](./0002-pinned-development-toolchain.md) | Pinned Bun, TypeScript, Node.js, npm, Biome, and Rust toolchain |
| [0003](./0003-layered-architecture-and-bridge-boundary.md) | Layered TypeScript architecture and native bridge boundary |
| [0004](./0004-official-codex-source-and-conformance.md) | Pinned official Codex source, minimal vendor closure, and isolated conformance |
| [0005](./0005-core-tool-surface-resolution.md) | Official core tool surface and capability resolvers |
| [0006](./0006-official-compaction-paths.md) | Official capability-driven compaction paths |
| [0007](./0007-versioned-project-configuration.md) | Versioned project-owned configuration schema |
| [0008](./0008-single-package-native-delivery.md) | Single npm package and release-built native sidecar delivery |
| [0009](./0009-release-please-and-exact-tarball-publishing.md) | Release Please and exact-tarball Trusted Publishing |
| [0010](./0010-responsive-terminal-experience.md) | Responsive settings overlay and inline tool rendering |

Accepted ADRs are changed only to correct factual errors. A decision change requires a new ADR that
explicitly supersedes the earlier record. Baseline upgrades and product-boundary changes must remain
separate from routine dependency updates.

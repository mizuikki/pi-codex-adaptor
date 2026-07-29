# ADR 0004: Official Codex Source and Conformance

- Status: Accepted
- Date: 2026-07-14

## Context

Official Codex Rust crates are workspace-oriented rather than stable standalone APIs. Reproducibility
requires an immutable source identity and a controlled dependency closure.

## Decision

Use OpenAI Codex `0.146.0`, tag `rust-v0.146.0`, peeled commit
`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`, and Rust `1.95.0`. Vendor only an allowlisted minimal
closure. Record source paths, hashes, licenses, tree hash, and replayable patches.

Use `@openai/codex@0.146.0`, `@openai/codex-sdk@0.146.0`, and Codex app-server only in isolated schema
generation and conformance jobs. They are not production dependencies and never run as an agent inside
Pi.

## Consequences

- Builds and synchronization use the peeled commit and never depend on a local Codex checkout.
- A baseline update changes source identity, Rust toolchain, schemas, fixtures, dependency closure,
  licenses, and conformance results together.
- Complete `codex-core`, app-server lifecycle, and account functionality remain outside production.

# ADR 0003: Layered Architecture and Bridge Boundary

- Status: Accepted
- Date: 2026-07-14

## Context

Pi owns agent lifecycle and user interaction, while official Codex transport and native tool behavior
belong close to the official Rust modules. Mixing those concerns would duplicate protocol logic and
make conformance difficult to prove.

## Decision

Separate domain, application, Pi integration, terminal UI, bridge infrastructure, and native runtime
modules. Dependencies flow from integration and infrastructure through application ports toward the
domain. TypeScript communicates with one native `codex-bridge` process through a bounded, versioned
JSONL protocol.

Responses, SSE, WebSocket, retries, compaction wire behavior, PTY handling, and patch execution stay in
Rust. TypeScript validates adaptor-owned bridge envelopes and does not define a second OpenAI wire
schema.

## Consequences

- Domain and application code cannot import Pi, terminal, filesystem, HTTP, or child-process details.
- Bridge protocol changes require contract tests and an explicit protocol version decision.
- Pi remains the sole owner of sessions, model selection, approvals, tool dispatch, and UI lifecycle.

# ADR 0007: Versioned Project Configuration

- Status: Accepted
- Date: 2026-07-14

## Context

Configuration needs deterministic validation, transactional editing, and a stable path independent of
domain objects and UI state.

## Decision

Own one schema at `~/.pi/agent/pi-codex-adaptor.json`, using `schemaVersion: 2`. The schema contains
an exact `activation.providers` list and the `codex` behavior group. Parse input as unknown, reject
schema v1, unsupported versions, duplicates, and unknown fields, and separate parsing, validation,
capability resolution, and persistence. Do not read Codex `config.toml`.

Write through a temporary file and atomic rename while retaining one recent backup. Invalid existing
files remain untouched until the user explicitly repairs or replaces them.

## Consequences

- Domain configuration contains no filesystem paths.
- Settings use a validated draft and save as one transaction.
- Shell and web surfaces remain resolver outputs instead of user-forced settings.

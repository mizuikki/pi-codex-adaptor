# ADR 0007: Versioned Project Configuration

- Status: Accepted
- Date: 2026-07-14

## Context

Configuration needs deterministic validation, transactional editing, and a stable path independent of
domain objects and UI state.

## Decision

Own one exact schema at `~/.pi/agent/pi-codex-adaptor.json`, using `schemaVersion: 2`. The schema
contains `activation.providers`, the `tools` group, required `security.approvalPolicy` with
`prompt | bypass`, the `codex` behavior group, and `ui.status`. Parse input as unknown, reject schema
v1, unsupported versions, duplicates, missing fields, and unknown fields, and separate parsing,
validation, capability resolution, and persistence. Prompt is the safe default. Do not read Codex
`config.toml`.

This is an unpublished clean-slate shape. No compatibility reader, missing-field default, migration,
or automatic rewrite is retained for the approval policy.

Write through a temporary file and atomic rename while retaining one recent backup. Invalid existing
files remain untouched until the user explicitly repairs or replaces them.

## Consequences

- Domain configuration contains no filesystem paths.
- Settings use a validated draft and save as one transaction.
- Shell and web surfaces remain resolver outputs instead of user-forced settings.

# ADR 0005: Core Tool Surface Resolution

- Status: Accepted
- Date: 2026-07-14

## Context

Codex `0.144.3` exposes model- and provider-dependent tool surfaces. Static registration would send
unsupported tools or lose official namespace and freeform behavior.

## Decision

Always provide the official `update_plan` contract. Resolve Unified Exec, `shell_command`, or disabled
shell behavior from the official model and feature resolver. Resolve standalone `web.run`, hosted
`web_search`, or disabled web behavior from provider capabilities. Preserve official names,
namespaces, descriptions, schemas, freeform formats, and termination behavior.

Expose `apply_patch`, `view_image`, and `image_gen.imagegen` only when their official capabilities
resolve. Native execution uses prompt approval or explicit Pi-owned per-request preauthorization;
workspace policy and native validation remain mandatory.

## Consequences

- Tool specifications are generated from pinned official builders rather than handwritten in
  TypeScript.
- Resolver branches require golden, contract, integration, and differential conformance coverage.
- Unsupported conditional tools stay absent rather than being force-enabled through configuration.

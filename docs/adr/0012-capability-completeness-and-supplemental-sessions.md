# ADR 0012: Capability Completeness and Supplemental Sessions

- Status: Accepted
- Date: 2026-07-19
- Supersedes: the shell-only selection in ADR 0005

## Context

The pinned model catalog selects `shell_command` for every bundled API model, while the product
enables background sessions by default. The native bridge already owns the pinned Unified Exec
contracts and managed-session executor, but the resolver previously exposed those contracts only
when model metadata selected Unified Exec. The default capability therefore had no model-visible
route.

Model metadata expresses the preferred official primary shell surface. It does not describe every
executor compiled into the product. Treating these facts as the same capability made a shipped
executor unreachable and allowed request construction, Pi activation, settings, and diagnostics to
derive different states.

## Decision

Keep the official model-selected shell as the primary surface. When background sessions are enabled,
the model primary shell is `shell_command`, and the verified bridge advertises Unified Exec, append
the exact pinned `exec_command` and `write_stdin` contracts as a product supplemental session
surface. Never supplement a model whose shell is disabled. Unified Exec models retain their official
contracts even when retention is disabled.

Native `tools.resolve` is authoritative for model-visible tools, dispatch-only tools, local Pi tool
names, hosted tool names, shell/session surfaces, and capability evidence. One application capability
resolver combines that output with verified bridge identity, candidate configuration, and the
explicit complete-provider contract. Requests, compaction, Pi activation, settings, status, and
redacted diagnostics consume that effective snapshot.

Every explicitly activated provider asserts the complete Codex provider contract. Endpoint-level
unsupported responses are reported as `provider_contract_mismatch`; they do not silently disable a
tool or delegate after a request may have started.

## Consequences

- Background sessions are executable on the bundled shell-command catalog without changing official
  generated schemas or implementing process behavior in TypeScript.
- Bridge protocol v3 requires explicit session policy and executor evidence in `tools.resolve`.
- The release gate resolves every bundled visible API model through the real native model and tool
  resolvers and rejects unreachable default capabilities.
- Raw nullable model metadata is not capability evidence; derived auto-compaction values come from
  the pinned official resolver.

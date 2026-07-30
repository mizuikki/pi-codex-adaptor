# ADR 0021: Independent Approval and Filesystem Access

- Status: Accepted
- Date: 2026-07-30

## Context

The former `prompt | bypass` setting controlled approval while Rust rejected external paths before an
approval could be requested. That made `bypass` look like the official dangerous bypass even though
it did not broaden filesystem scope. The pinned Codex 0.146.0 baseline instead defines `never` as
"never ask" and composes it with full filesystem access only for the dangerous bypass mode.

This product has no OS sandbox. It can govern explicit paths handled by native structured tools, but
it cannot constrain filesystem access expressed inside shell command text.

## Decision

Adopt exact configuration schema v3 with two independent fields:

```ts
security: {
  approvalPolicy: "on-request" | "never";
  filesystemAccessPolicy: "workspace" | "unrestricted";
}
```

The default is `on-request + workspace`; `never + unrestricted` is the explicit dangerous full-access
combination. Schema v2 is unsupported and is not migrated or rewritten automatically.

Adopt bridge protocol v7. `tools.execute` carries both host-owned policies after argument allowlisting,
while `session_write` carries only approval policy. Rust owns path resolution, canonical scope
classification, post-approval identity checks, and side effects. Pi owns approval decisions and
terminal presentation.

Under workspace policy, external structured-tool paths are eligible for one clearly external
operation approval under `on-request`, but fail with `workspace_escape` and no prompt under `never`.
Under unrestricted policy, eligible external paths follow normal approval behavior. Structural
failures, direct symlink patch targets, cancellation, and changed target identity remain fail-closed.

## Consequences

- The official meaning of `never` is represented without granting access implicitly.
- Users can explicitly approve one external structured-tool operation without enabling unrestricted
  access globally.
- Settings, status, and startup warnings expose both axes and the combined dangerous state.
- Exact external paths may travel only in ephemeral requests and transient approval UI; they remain
  excluded from errors, logs, diagnostics, fixtures, and snapshots.
- Shell commands still run with the user's permissions, hard links and the final validation race are
  residual risks, and no UI or documentation calls the path guardrail a sandbox.

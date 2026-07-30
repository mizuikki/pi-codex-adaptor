# Security Boundary

The adaptor is a local extension and native sidecar. It does not provide an OS sandbox. Native
commands run with the user's permissions. Filesystem access policy constrains explicit structured-tool
paths and working directories rather than OS filesystem authority; shell command text is not parsed.

## Credentials and transport

- Provider credentials enter the bridge only in bounded request-scoped connection objects.
- Credentials are not placed in argv, environment variables, persisted configuration, logs, fixtures,
  snapshots, errors, or diagnostics.
- Provider headers, URLs with userinfo, account identifiers, and bearer tokens are validated and
  redacted before any user-visible or diagnostic surface.
- The bridge child receives a narrowed environment and is shut down with active requests cancelled.

## Approval and filesystem access

Approval and filesystem scope are independent. `on-request + workspace` is the default. `never`
means that the bridge never asks for approval: eligible operations execute and rejected operations
return a bounded failure to the model. It does not grant filesystem access. `unrestricted` makes
external paths explicitly handled by patch, workdir, image-read, and image-reference code eligible;
`never + unrestricted` is the explicit dangerous full-access combination.

Under workspace policy, an external structured-tool path requests one external-scope operation
approval with `on-request`, but returns `workspace_escape` without prompting under `never`. Targets
are resolved again after approval and must retain the approved canonical identity before mutation.
Direct patch targets that are symlinks remain unsupported. Exact external paths may appear in the
transient approval needed for an informed decision, but not in errors, diagnostics, logs, fixtures,
or snapshots. Cancellation is checked before side effects and while awaiting approvals or external
processes.

## Opaque compaction output

Remote output is provider-bound state. It is accepted only after strict structured JSON validation,
exactly-one-compaction-item validation, bounded output limits, request identity checks, and completion.
It is stored only inside the version-one extension `CustomEntry` checkpoint and is never decrypted,
rendered as prose, placed in diagnostics, or used after an identity mismatch.

The checkpoint requires the session fingerprint, provider, API, normalized base URL, model,
authentication binding, checkpoint ID, and covered active-branch entry. Suffix projection excludes
the checkpoint and every context-invisible entry. A forged token, stale leaf, wrong branch, changed
identity, cancelled request, or indeterminate append blocks provider dispatch.

After a verified append, Pi records only the custom entry ID as a usage epoch boundary. The Pi host
does not parse checkpoint data. Usage is unknown until a later valid assistant response, and reload or
identity changes restore or clear the boundary from active-branch structure alone.

## Diagnostics and errors

Diagnostics are an allowlisted identity/capability snapshot. Redaction replaces tokens, authorization
headers, prompts, messages, absolute paths, account data, and opaque output before logs, snapshots,
errors, or export. Native provider detail is bounded and classified; it is not a debug dump.

Rate-limit snapshots, account usage, reset-credit data, and app-server lifecycle state are not product
features and cannot enter the bridge contract.

## Artifact and supply chain

The sidecar is loaded only after `native-artifact.json` validates its target, official baseline, source
commit, executable size, and SHA-256. The package verifier checks the npm file allowlist and wildcard
Pi peers. The pinned vendor verifier checks the official source commit, selected file closure, source
hashes, vendor hashes, tree hash, licenses, SBOM, and recorded patches.

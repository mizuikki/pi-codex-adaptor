# ADR 0011: Explicit Provider Dispatch Without Pi Changes

## Status

Accepted

## Context

Pi registers one `streamSimple` handler per API id. Its native
`openai-codex-responses` handler treats credentials as ChatGPT OAuth tokens and
requires an account id, while ordinary `openai-responses` providers may use API
keys or opaque gateway tokens. Changing Pi would break the product boundary and
would make provider selection implicit in a transport API.

## Decision

The adaptor owns an exact provider-id allowlist in configuration. A model is
effectively active only when its provider id is selected and its Pi API is
`openai-responses` or `openai-codex-responses`. The same predicate governs the
stream dispatcher, tools, status, and compaction.

The extension registers one synchronous dispatcher for each supported Pi API.
Selected models use the native Codex bridge; unselected models call Pi's public
native stream implementation directly. Provider ids remain Pi-owned model
identity and are never inferred from URLs, names, model ids, or token shapes.

The provider connection is immutable and request-scoped. Pi supplies the model
endpoint, final headers, and resolved credential; TypeScript normalizes those
values and sends the connection only in bridge requests that need network
access. Model and tool resolution remain credential-free.

Bridge protocol v1 and configuration schema v1 are removed in this breaking
pre-release. No migration, alias, or compatibility reader is provided.

## Consequences

- Custom providers keep `api: openai-responses` and opt in by exact provider id.
- The default allowlist keeps the built-in `openai-codex` provider active.
- A provider is selected for every model under that provider id.
- Extensions that also replace either supported API id cannot safely compose
  with this extension. Pi's normal registry reset remains the unload mechanism.
- Pi source and runtime packages remain unchanged.

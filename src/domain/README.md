# Domain

Configuration, capability, plan, compaction, and tool-call value objects belong here. This layer has
no Pi, terminal, network, filesystem, or process dependencies.

`capability.ts` resolves shell, web, transport, and compaction surfaces from validated official
model and provider metadata. Provider activation is decided separately by the explicit provider
allowlist in `provider-activation.ts`.

`redaction.ts` owns the pure log and diagnostic redaction policy.

# Domain

Configuration, capability, plan, compaction, and tool-call value objects belong here. This layer has
no Pi, terminal, network, filesystem, or process dependencies.

`capability.ts` resolves shell, web, transport, and compaction surfaces from official model and
provider metadata. Missing metadata and third-party providers return explicit unsupported reasons.

`redaction.ts` owns the pure log and diagnostic redaction policy.

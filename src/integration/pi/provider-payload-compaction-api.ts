import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderCheckpointProposal,
	ProviderCompactionCommitToken,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type ProviderRequestOrigin = "agent" | "compaction_summary" | "branch_summary";

export interface ProviderPayloadAttribution {
	readonly sessionId: string;
	readonly origin: ProviderRequestOrigin;
	readonly signal: AbortSignal;
	readonly compaction?: {
		readonly token: ProviderCompactionCommitToken;
		readonly candidateLeafId: string;
		readonly candidateRetainedTail: readonly AgentMessage[];
	};
}

export type { ProviderCheckpointProposal, ProviderCompactionCommitToken };

export interface BeforeProviderPayloadEvent {
	readonly type: "before_provider_payload";
	readonly model: Model<Api>;
	readonly payload: unknown;
	readonly attribution: ProviderPayloadAttribution;
}

export interface BeforeProviderPayloadEventResult {
	readonly payload: unknown;
	readonly providerCheckpoint?: ProviderCheckpointProposal;
}

type BeforeProviderPayloadHandler = (
	event: BeforeProviderPayloadEvent,
	ctx: ExtensionContext,
) =>
	| Promise<BeforeProviderPayloadEventResult | undefined>
	| BeforeProviderPayloadEventResult
	| undefined;

interface SessionManagerWithFullActivePathSnapshot {
	getFullActivePathSnapshot(): readonly SessionEntry[];
}

export function onBeforeProviderPayload(
	pi: ExtensionAPI,
	handler: BeforeProviderPayloadHandler,
): void {
	const on = pi.on as unknown as (
		event: "before_provider_payload",
		handler: BeforeProviderPayloadHandler,
	) => void;
	on("before_provider_payload", handler);
}

export function fullActivePathSnapshot(
	sessionManager: ExtensionContext["sessionManager"],
): readonly SessionEntry[] | undefined {
	const candidate = sessionManager as ExtensionContext["sessionManager"] &
		Partial<SessionManagerWithFullActivePathSnapshot>;
	return typeof candidate.getFullActivePathSnapshot === "function"
		? candidate.getFullActivePathSnapshot()
		: undefined;
}

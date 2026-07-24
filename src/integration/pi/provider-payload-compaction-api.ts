import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type ProviderRequestOrigin = "agent" | "compaction_summary" | "branch_summary";

export interface ProviderCompactionCommitToken {
	readonly providerPayloadCompactionCommitToken: unique symbol;
}

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

export interface ProviderCompactionProposal {
	readonly token: ProviderCompactionCommitToken;
	readonly summary: string;
	readonly tokensBefore: number;
	readonly usage?: Usage;
	readonly details?: unknown;
}

export interface BeforeProviderPayloadEvent {
	readonly type: "before_provider_payload";
	readonly model: Model<Api>;
	readonly payload: unknown;
	readonly attribution: ProviderPayloadAttribution;
}

export interface BeforeProviderPayloadEventResult {
	readonly payload: unknown;
	readonly compaction?: ProviderCompactionProposal;
}

export interface ProviderPayloadSessionCompactEvent extends SessionCompactEvent {
	readonly trigger: "manual" | "threshold" | "overflow" | "provider_inline";
	readonly compactionEntry: SessionCompactEvent["compactionEntry"] & {
		readonly retainedTail?: readonly AgentMessage[];
	};
}

type BeforeProviderPayloadHandler = (
	event: BeforeProviderPayloadEvent,
	ctx: ExtensionContext,
) =>
	| Promise<BeforeProviderPayloadEventResult | undefined>
	| BeforeProviderPayloadEventResult
	| undefined;
type ProviderPayloadSessionCompactHandler = (
	event: ProviderPayloadSessionCompactEvent,
	ctx: ExtensionContext,
) => void;
type ProviderPayloadCompactionIndeterminateHandler = (
	event: { readonly type: "session_compact_indeterminate" },
	ctx: ExtensionContext,
) => void;

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

export function onProviderPayloadSessionCompact(
	pi: ExtensionAPI,
	handler: ProviderPayloadSessionCompactHandler,
): void {
	const on = pi.on as unknown as (
		event: "session_compact",
		handler: ProviderPayloadSessionCompactHandler,
	) => void;
	on("session_compact", handler);
}

export function onProviderPayloadCompactionIndeterminate(
	pi: ExtensionAPI,
	handler: ProviderPayloadCompactionIndeterminateHandler,
): void {
	const on = pi.on as unknown as (
		event: "session_compact_indeterminate",
		handler: ProviderPayloadCompactionIndeterminateHandler,
	) => void;
	on("session_compact_indeterminate", handler);
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

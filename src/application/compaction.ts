import type { CompactionConfig } from "../domain/config.ts";

export const CODEX_COMPACTION_DETAILS_KIND = "pi-codex-adaptor.compaction";
export const CODEX_COMPACTION_DETAILS_VERSION = 1;

export interface CodexCompactionDetails {
	kind: typeof CODEX_COMPACTION_DETAILS_KIND;
	version: typeof CODEX_COMPACTION_DETAILS_VERSION;
	modelId: string;
	output: readonly unknown[];
}

export interface CodexCompactionSnapshot extends CodexCompactionDetails {
	summary: string;
}

export class CodexCompactionStore {
	readonly #sessions = new Map<string, CodexCompactionSnapshot>();

	get(sessionId: string | undefined, modelId: string): CodexCompactionSnapshot | undefined {
		if (sessionId === undefined) return undefined;
		const snapshot = this.#sessions.get(sessionId);
		return snapshot?.modelId === modelId ? snapshot : undefined;
	}

	set(sessionId: string, summary: string, details: CodexCompactionDetails): void {
		this.#sessions.set(sessionId, { ...details, summary });
	}

	clear(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}
}

export function createCodexCompactionDetails(
	modelId: string,
	output: readonly unknown[],
): CodexCompactionDetails {
	return {
		kind: CODEX_COMPACTION_DETAILS_KIND,
		version: CODEX_COMPACTION_DETAILS_VERSION,
		modelId,
		output,
	};
}

export function parseCodexCompactionDetails(value: unknown): CodexCompactionDetails | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	if (
		details.kind !== CODEX_COMPACTION_DETAILS_KIND ||
		details.version !== CODEX_COMPACTION_DETAILS_VERSION ||
		typeof details.modelId !== "string" ||
		details.modelId.length === 0 ||
		!Array.isArray(details.output)
	) {
		return undefined;
	}
	return {
		kind: CODEX_COMPACTION_DETAILS_KIND,
		version: CODEX_COMPACTION_DETAILS_VERSION,
		modelId: details.modelId,
		output: details.output,
	};
}

/**
 * Resolve the absolute token threshold used for Pi-owned auto-compaction.
 * Returns undefined when auto-compaction is disabled or no valid limit is available.
 */
export function resolveCompactionThreshold(
	compaction: CompactionConfig,
	modelAutoCompactTokenLimit: number | null,
	contextWindow: number,
): number | undefined {
	if (compaction.mode === "off") return undefined;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

	const candidate =
		typeof compaction.autoCompactTokenLimit === "number"
			? compaction.autoCompactTokenLimit
			: modelAutoCompactTokenLimit;
	if (candidate === null || candidate === undefined) return undefined;
	if (!Number.isFinite(candidate) || candidate <= 0) return undefined;
	const threshold = Math.trunc(candidate);
	return threshold < contextWindow ? threshold : undefined;
}

export type CompactionCycleOutcome = "success" | "error" | "cancel";

export interface CompactionThresholdCache {
	readonly modelId: string;
	readonly autoCompactTokenLimit: number | null;
}

type CompactionPhase = "idle" | "pending" | "executing";

interface SessionCompactionGuard {
	phase: CompactionPhase;
	previousTokens: number | null | undefined;
	thresholdCache: CompactionThresholdCache | undefined;
}

/**
 * Shared per-session coordinator for auto turn_end, session_before_compact, and
 * manual /codex compact. Serializes runtime.compact execution, preserves rising-edge
 * token observations, and clears in-flight state on success, error, cancel, or dispose.
 */
export class CodexCompactionCoordinator {
	readonly #sessions = new Map<string, SessionCompactionGuard>();

	/** True while a compact request is pending or runtime.compact is executing. */
	isBusy(sessionId: string): boolean {
		const state = this.#sessions.get(sessionId);
		return state !== undefined && state.phase !== "idle";
	}

	/**
	 * Begin an initiator-owned compact cycle (auto turn_end or manual /codex).
	 * Returns false when another cycle is already active for the session.
	 */
	begin(sessionId: string): boolean {
		const state = this.#ensure(sessionId);
		if (state.phase !== "idle") return false;
		state.phase = "pending";
		return true;
	}

	/**
	 * Enter the runtime.compact critical section from session_before_compact.
	 * Accepts idle (Pi-native /compact or overflow) or pending (our initiator).
	 * Rejects re-entrant or concurrent execution.
	 */
	beginExecution(sessionId: string): boolean {
		const state = this.#ensure(sessionId);
		if (state.phase === "executing") return false;
		state.phase = "executing";
		return true;
	}

	/**
	 * Release the session cycle. Idempotent while idle.
	 * Success resets the token observation to null so the next reading is a baseline.
	 */
	end(sessionId: string, outcome: CompactionCycleOutcome): void {
		const state = this.#sessions.get(sessionId);
		if (state === undefined || state.phase === "idle") return;
		state.phase = "idle";
		if (outcome === "success") {
			state.previousTokens = null;
		}
	}

	getPreviousTokens(sessionId: string): number | null | undefined {
		return this.#sessions.get(sessionId)?.previousTokens;
	}

	setPreviousTokens(sessionId: string, value: number | null): void {
		this.#ensure(sessionId).previousTokens = value;
	}

	/**
	 * Drop the previous observation so the next reading cannot form a rising edge.
	 * Used on session start and model selection.
	 */
	clearTokenObservation(sessionId: string): void {
		const state = this.#sessions.get(sessionId);
		if (state === undefined) return;
		state.previousTokens = undefined;
		state.thresholdCache = undefined;
	}

	getThresholdCache(sessionId: string): CompactionThresholdCache | undefined {
		return this.#sessions.get(sessionId)?.thresholdCache;
	}

	setThresholdCache(sessionId: string, value: CompactionThresholdCache): void {
		this.#ensure(sessionId).thresholdCache = value;
	}

	/** Drop all coordinator state for one session, including any in-flight cycle. */
	dispose(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}

	/** Drop coordinator state for every session. */
	disposeAll(): void {
		this.#sessions.clear();
	}

	#ensure(sessionId: string): SessionCompactionGuard {
		let state = this.#sessions.get(sessionId);
		if (state === undefined) {
			state = {
				phase: "idle",
				previousTokens: undefined,
				thresholdCache: undefined,
			};
			this.#sessions.set(sessionId, state);
		}
		return state;
	}
}

export interface AutoCompactionTriggerState {
	readonly previousTokens: number | null | undefined;
	readonly currentTokens: number | null;
	readonly threshold: number | undefined;
	readonly compacting: boolean;
	readonly mode: CompactionConfig["mode"];
}

/**
 * Detect a rising edge across the configured auto-compact threshold.
 * Requires a known previous observation so the first reading never triggers.
 */
export function shouldTriggerAutoCompaction(state: AutoCompactionTriggerState): boolean {
	if (state.mode !== "auto" || state.compacting) return false;
	if (state.threshold === undefined) return false;
	if (
		state.currentTokens === null ||
		state.previousTokens === undefined ||
		state.previousTokens === null
	) {
		return false;
	}
	return state.previousTokens <= state.threshold && state.currentTokens > state.threshold;
}

/**
 * Decide whether a Pi-owned session_before_compact event may proceed.
 * Manual and overflow paths remain available when mode is auto; threshold events
 * require the current usage to already exceed the resolved limit.
 */
export function shouldAcceptCompactionEvent(options: {
	mode: CompactionConfig["mode"];
	reason: "manual" | "threshold" | "overflow";
	tokensBefore: number;
	threshold: number | undefined;
}): boolean {
	if (options.mode === "off") return false;
	if (options.reason === "manual" || options.reason === "overflow") return true;
	if (options.threshold === undefined) return false;
	return options.tokensBefore > options.threshold;
}

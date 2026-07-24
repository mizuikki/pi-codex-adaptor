import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { type CodexRuntime, remoteCompactionV2Context } from "../../application/codex-runtime.ts";
import {
	CODEX_AUTO_COMPACTION_KIND,
	CodexCompactionCoordinator,
	type CodexCompactionStore,
	createPortableCompactionDetails,
	isStructuredJsonValue,
	isSupportedStructuredResponseItem,
	matchingOpaqueSnapshotOutput,
	type StructuredResponseItem,
	validateCommittedCompactionEntry,
	validateCompactionOutput,
} from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	capabilityCacheKey,
	ResolveEffectiveCapabilities,
	withSupplementalSessionInstructions,
} from "../../application/resolve-effective-capabilities.ts";
import {
	providerCompactionIdentity,
	registerCodexCompactionReplay,
} from "./codex-compaction-replay.ts";
import { responseItemsFromMessages } from "./codex-provider.ts";
import { type CodexProviderRequestGuard, sha256Hex } from "./codex-provider-request-guard.ts";
import {
	type CodexToolProfileCoordinator,
	createUnavailableCodexToolProfile,
} from "./codex-tool-profile.ts";
import { selectCodexToolSurface } from "./codex-tool-surface.ts";
import { resolveProviderConnection } from "./provider-connection.ts";

const CODEX_COMPACTION_FAILED =
	"OpenAI Codex compaction failed; the session context was left unchanged.";

export function registerCodexCompaction(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	store: CodexCompactionStore,
	activation: ProviderActivationPolicy,
	coordinator: CodexCompactionCoordinator = new CodexCompactionCoordinator(),
	capabilities = new ResolveEffectiveCapabilities(runtime),
	profile: CodexToolProfileCoordinator = createUnavailableCodexToolProfile(),
	requestGuard?: CodexProviderRequestGuard,
): void {
	pi.on("session_start", (_event, ctx) => {
		coordinator.dispose(ctx.sessionManager.getSessionId());
		restoreCompaction(ctx, store);
	});
	pi.on("model_select", () => {});
	pi.on("session_compact", (event, ctx) => {
		acceptCompaction(event, ctx, store);
	});
	pi.on("session_compact_indeterminate", (_event, ctx) => {
		store.markReplayInvalid(ctx.sessionManager.getSessionId());
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.dispose(sessionId);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		return compactForPi(event, ctx, {
			pi,
			runtime,
			configuration,
			store,
			activation,
			coordinator,
			capabilities,
			profile,
		});
	});
	if (requestGuard !== undefined) {
		registerCodexCompactionReplay({
			pi,
			runtime,
			configuration,
			activation,
			store,
			coordinator,
			capabilities,
			profile,
			guard: requestGuard,
		});
	}
}

async function compactForPi(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	state: {
		pi: ExtensionAPI;
		runtime: CodexRuntime;
		configuration: ConfigurationService;
		store: CodexCompactionStore;
		activation: ProviderActivationPolicy;
		coordinator: CodexCompactionCoordinator;
		capabilities: ResolveEffectiveCapabilities;
		profile: CodexToolProfileCoordinator;
	},
): Promise<{ cancel?: boolean; compaction?: CompactionResult } | undefined> {
	const sessionId = ctx.sessionManager.getSessionId();
	const model = ctx.model;
	if (model === undefined) {
		state.coordinator.endPending(sessionId, "error");
		notifyCompactionFailure(ctx);
		return { cancel: true };
	}
	if (!state.activation.isActive(model)) return undefined;
	if (event.signal.aborted) {
		state.coordinator.endPending(sessionId, "cancel");
		return { cancel: true };
	}
	// Pi's post-run threshold event aborts the active retry path. Inline automatic
	// compaction is owned by before_provider_payload; overflow remains Pi-owned.
	if (event.reason === "threshold") {
		return { cancel: true };
	}

	let ownsExecution = false;
	try {
		const connection = await resolveProviderConnection(
			ctx,
			state.activation,
			"Codex compaction is inactive for the selected provider and API",
		);
		const config = await state.configuration.load();
		if (config.codex.compaction.mode === "off") {
			state.coordinator.endPending(sessionId, "cancel");
			return { cancel: true };
		}
		const capabilityKey = capabilityCacheKey({
			modelId: model.id,
			providerId: model.provider,
			config,
			contextWindow: model.contextWindow,
		});
		if (!state.profile.isHealthy(capabilityKey)) {
			throw new Error("Codex tool profile is unavailable for the selected capability");
		}
		const capabilitySnapshot = await state.capabilities.resolve({
			modelId: model.id,
			providerId: model.provider,
			config,
			contextWindow: model.contextWindow,
		});
		if (!state.coordinator.beginExecution(sessionId)) return { cancel: true };
		ownsExecution = true;
		if (event.signal.aborted) {
			state.coordinator.end(sessionId, "cancel");
			return { cancel: true };
		}
		const identity = providerCompactionIdentity({
			sessionId,
			model,
			connection,
		});
		if (identity === undefined)
			throw new Error("OpenAI Codex compaction credentials are unsupported");
		const officialTools = capabilitySnapshot.modelTools;
		const tools = selectCodexToolSurface(
			officialTools,
			state.pi.getActiveTools(),
			state.pi.getAllTools(),
		);
		const previousSnapshot = state.store.getForSession(sessionId);
		const previousOutput = matchingOpaqueSnapshotOutput(
			previousSnapshot,
			identity,
			previousSnapshot?.source === "manual" ? sha256Hex(previousSnapshot.summary) : undefined,
		);
		const messages = [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		const inputCandidate = [...(previousOutput ?? []), ...responseItemsFromMessages(messages)];
		if (
			!inputCandidate.every(
				(item) => isStructuredJsonValue(item) && isSupportedStructuredResponseItem(item),
			)
		) {
			throw new Error("OpenAI Codex compaction input is invalid");
		}
		const input = inputCandidate as readonly StructuredResponseItem[];
		const remoteV2Context = remoteCompactionV2Context(
			previousOutput === undefined ? null : capabilitySnapshot.compaction.implementation,
			previousOutput === undefined ? undefined : sessionId,
			"manual",
		);
		const compactRequest = {
			model: model.id,
			input,
			instructions: withSupplementalSessionInstructions(ctx.getSystemPrompt(), capabilitySnapshot),
			tools: tools.length === 0 ? null : tools,
			parallel_tool_calls: true,
			reasoning: reasoningFor(model, state.pi.getThinkingLevel()),
			service_tier: config.codex.serviceTier,
			prompt_cache_key: sessionId,
			text: { verbosity: config.codex.verbosity },
		};
		const sharedAbort = new AbortController();
		const releaseAbort = linkAbortSignal(event.signal, sharedAbort);
		try {
			const summaryPromise = state.runtime.summarizeContext({
				connection,
				modelId: model.id,
				input,
				transportMode: config.codex.transport.mode,
				providerSupportsWebsockets: capabilitySnapshot.providerSupportsWebsockets,
				...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
				signal: sharedAbort.signal,
			});
			const compactPromise = state.runtime
				.compact({
					connection,
					request: compactRequest,
					implementation: capabilitySnapshot.compaction.implementation ?? "compact_endpoint",
					transportMode: config.codex.transport.mode,
					providerSupportsWebsockets: capabilitySnapshot.providerSupportsWebsockets,
					...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
					signal: sharedAbort.signal,
				})
				.catch(() => undefined);
			let summaryResult: Awaited<ReturnType<CodexRuntime["summarizeContext"]>>;
			try {
				summaryResult = await summaryPromise;
			} catch (error) {
				sharedAbort.abort();
				throw error;
			}
			if (event.signal.aborted || summaryResult.status === "aborted") {
				sharedAbort.abort();
				state.coordinator.end(sessionId, "cancel");
				return { cancel: true };
			}
			if (summaryResult.status !== "completed") {
				sharedAbort.abort();
				throw new Error(`OpenAI Codex summarization ended with status ${summaryResult.status}`);
			}
			const compactResult = await compactPromise;
			if (event.signal.aborted) {
				state.coordinator.end(sessionId, "cancel");
				return { cancel: true };
			}
			let usage = usageFromNormalized(summaryResult.result.usage);
			let details = createPortableCompactionDetails(sha256Hex(summaryResult.result.summary));
			if (compactResult?.status === "completed") {
				try {
					const output = validateCompactionOutput(record(compactResult.result)?.output);
					usage = combineUsage(usage, usageFromNormalized(compactResult.result.usage));
					details = createPortableCompactionDetails(sha256Hex(summaryResult.result.summary), {
						identity,
						output,
					});
				} catch {
					// A malformed or failed accelerator is ignored; the portable summary still commits.
				}
			}
			if (usage !== undefined) calculateCost(model, usage);
			state.coordinator.end(sessionId, "success");
			return {
				compaction: {
					summary: summaryResult.result.summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					...(usage === undefined ? {} : { usage }),
					details,
				},
			};
		} finally {
			releaseAbort();
		}
	} catch {
		if (event.signal.aborted) {
			if (ownsExecution) state.coordinator.end(sessionId, "cancel");
			else state.coordinator.endPending(sessionId, "cancel");
			return { cancel: true };
		}
		if (ownsExecution) state.coordinator.end(sessionId, "error");
		else state.coordinator.endPending(sessionId, "error");
		notifyCompactionFailure(ctx);
		return { cancel: true };
	}
}

function notifyCompactionFailure(ctx: ExtensionContext): void {
	try {
		ctx.ui.notify(CODEX_COMPACTION_FAILED, "error");
	} catch {
		// UI availability is not part of compaction correctness.
	}
}

function restoreCompaction(ctx: ExtensionContext, store: CodexCompactionStore): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const raw = branch[index];
		if (raw === undefined || (raw.type !== "compaction" && raw.type !== "custom")) continue;
		if (raw.type === "custom" && raw.customType !== CODEX_AUTO_COMPACTION_KIND) continue;
		const validated = validateCommittedCompactionEntry(
			toPersistedEntryView(raw),
			undefined,
			raw.type === "compaction" ? sha256Hex(raw.summary) : undefined,
		);
		if (!validated.ok) {
			store.markReplayInvalid(sessionId);
			return;
		}
		const kind = validated.kind;
		if (kind.source === "portable_pi") {
			store.clear(sessionId);
			return;
		}
		if (kind.source === "legacy_opaque") {
			if (kind.details.kind === CODEX_AUTO_COMPACTION_KIND) {
				if (typeof raw.id !== "string") {
					store.markReplayInvalid(sessionId);
					return;
				}
				store.setAutomatic(sessionId, kind.details, raw.id);
				return;
			}
			if (
				raw.type !== "compaction" ||
				kind.details.version === 1 ||
				typeof raw.summary !== "string" ||
				typeof raw.id !== "string"
			) {
				store.clear(sessionId);
				return;
			}
			store.setManual(sessionId, raw.summary, kind.details, raw.id);
			return;
		}
		if (kind.source !== "adaptor_v3" || raw.type !== "compaction" || typeof raw.id !== "string") {
			store.markReplayInvalid(sessionId);
			return;
		}
		store.setManual(sessionId, raw.summary, kind.details, raw.id);
		return;
	}
	store.clear(sessionId);
}

function acceptCompaction(
	event: SessionCompactEvent,
	ctx: ExtensionContext,
	store: CodexCompactionStore,
): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const entry = event.compactionEntry;
	const pending =
		event.trigger === "provider_inline" ? store.getPendingCommit(sessionId) : undefined;
	const validated = validateCommittedCompactionEntry(
		{
			type: "compaction",
			id: entry.id,
			parentId: entry.parentId,
			summary: entry.summary,
			...(entry.details === undefined ? {} : { details: entry.details }),
			...(entry.firstKeptEntryId === undefined ? {} : { firstKeptEntryId: entry.firstKeptEntryId }),
			...(entry.usage === undefined ? {} : { usage: entry.usage }),
			...(entry.retainedTail === undefined ? {} : { retainedTail: entry.retainedTail }),
		},
		pending,
		sha256Hex(entry.summary),
	);
	if (!validated.ok) {
		store.markReplayInvalid(sessionId);
		return;
	}
	store.clearPendingCommit(sessionId);
	if (validated.kind.source === "adaptor_v3") {
		store.setManual(sessionId, entry.summary, validated.kind.details, entry.id);
		return;
	}
	if (
		validated.kind.source === "legacy_opaque" &&
		validated.kind.details.kind !== CODEX_AUTO_COMPACTION_KIND
	) {
		if (validated.kind.details.version === 1) {
			store.clear(sessionId);
			return;
		}
		store.setManual(sessionId, entry.summary, validated.kind.details, entry.id);
		return;
	}
	store.clear(sessionId);
}

function toPersistedEntryView(entry: {
	readonly type: string;
	readonly id?: string;
	readonly parentId?: string | null;
	readonly summary?: string;
	readonly details?: unknown;
	readonly firstKeptEntryId?: string;
	readonly usage?: unknown;
	readonly retainedTail?: unknown;
	readonly customType?: string;
	readonly data?: unknown;
}) {
	if (entry.type === "custom") {
		return {
			type: "custom" as const,
			...(entry.id === undefined ? {} : { id: entry.id }),
			...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
			...(entry.customType === undefined ? {} : { customType: entry.customType }),
			...(entry.data === undefined ? {} : { data: entry.data }),
		};
	}
	return {
		type: "compaction" as const,
		...(entry.id === undefined ? {} : { id: entry.id }),
		...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
		...(entry.summary === undefined ? {} : { summary: entry.summary }),
		...(entry.details === undefined ? {} : { details: entry.details }),
		...(entry.firstKeptEntryId === undefined ? {} : { firstKeptEntryId: entry.firstKeptEntryId }),
		...(entry.usage === undefined ? {} : { usage: entry.usage }),
		...(entry.retainedTail === undefined ? {} : { retainedTail: entry.retainedTail }),
	};
}

function reasoningFor(
	model: NonNullable<ExtensionContext["model"]>,
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): Record<string, unknown> | null {
	if (!model.reasoning || thinkingLevel === "off") return null;
	const effort = model.thinkingLevelMap?.[thinkingLevel] ?? thinkingLevel;
	return effort === null ? null : { effort, summary: "auto", context: "all_turns" };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function linkAbortSignal(signal: AbortSignal, controller: AbortController): () => void {
	if (signal.aborted) {
		controller.abort(signal.reason);
		return () => {};
	}
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	return () => signal.removeEventListener("abort", abort);
}

function usageFromNormalized(
	value:
		| {
				inputTokens: number;
				outputTokens: number;
				cachedInputTokens: number;
				reasoningTokens?: number;
		  }
		| undefined,
): Usage | undefined {
	if (value === undefined) return undefined;
	const cachedInputTokens = integer(value.cachedInputTokens);
	const inputTokens = Math.max(0, integer(value.inputTokens) - cachedInputTokens);
	const usage: Usage = {
		input: inputTokens,
		output: integer(value.outputTokens),
		cacheRead: cachedInputTokens,
		cacheWrite: 0,
		totalTokens: inputTokens + integer(value.outputTokens) + cachedInputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (typeof value.reasoningTokens === "number") {
		usage.reasoning = integer(value.reasoningTokens);
	}
	return usage;
}

function combineUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
	};
}

function integer(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export type { SessionBeforeCompactEvent };

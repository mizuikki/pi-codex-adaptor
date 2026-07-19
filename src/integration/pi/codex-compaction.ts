import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CodexRuntime } from "../../application/codex-runtime.ts";
import {
	CodexCompactionCoordinator,
	type CodexCompactionStore,
	type CompactionThresholdCache,
	createCodexCompactionDetails,
	parseCodexCompactionDetails,
	resolveCompactionThreshold,
	shouldAcceptCompactionEvent,
	shouldTriggerAutoCompaction,
} from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	buildToolsResolveParams,
	parseModelResolution,
	selectCompactionImplementation,
} from "../../domain/capability.ts";
import type { CompactionConfig } from "../../domain/config.ts";
import {
	officialToolNames,
	responseItemsFromMessages,
	supportsProviderWebsockets,
} from "./codex-provider.ts";
import { resolveProviderConnection } from "./provider-connection.ts";

const COMPACTION_SUMMARY = "Context compacted by the OpenAI Codex Responses API.";

export function registerCodexCompaction(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	store: CodexCompactionStore,
	activation: ProviderActivationPolicy,
	coordinator: CodexCompactionCoordinator = new CodexCompactionCoordinator(),
): void {
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (coordinator.isBusy(sessionId)) {
			coordinator.end(sessionId, "cancel");
		}
		coordinator.clearTokenObservation(sessionId);
		restoreCompaction(ctx, store);
	});
	pi.on("model_select", (_event, ctx) => {
		coordinator.clearTokenObservation(ctx.sessionManager.getSessionId());
	});
	pi.on("session_compact", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.end(sessionId, "success");
		acceptCompaction(event, ctx, store);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.dispose(sessionId);
	});
	pi.on("turn_end", async (_event, ctx) => {
		await maybeTriggerThresholdCompaction(ctx, {
			runtime,
			configuration,
			activation,
			coordinator,
		});
	});
	pi.on("session_before_compact", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const model = ctx.model;
		if (model === undefined) {
			coordinator.end(sessionId, "error");
			throw new Error("OpenAI Codex compaction requires an active model");
		}
		// Inactive providers skip Codex compaction so Pi can fall back to its native path.
		// True cancellation is reserved for threshold/mode rejection, concurrency, and abort.
		if (!activation.isActive(model)) return;
		if (event.signal.aborted) return { cancel: true };
		let connection: Awaited<ReturnType<typeof resolveProviderConnection>>;
		try {
			connection = await resolveProviderConnection(
				ctx,
				activation,
				"Codex compaction is inactive for the selected provider and API",
			);
		} catch (error) {
			coordinator.end(sessionId, "error");
			throw error;
		}
		const config = await configuration.load();
		const resolution = parseModelResolution(await runtime.resolveModel(model.id), model.id);
		coordinator.setThresholdCache(sessionId, {
			modelId: model.id,
			autoCompactTokenLimit: resolution.autoCompactTokenLimit,
		});
		const threshold = resolveCompactionThreshold(
			config.codex.compaction,
			resolution.autoCompactTokenLimit,
			model.contextWindow,
		);
		if (
			!shouldAcceptCompactionEvent({
				mode: config.codex.compaction.mode,
				reason: event.reason,
				tokensBefore: event.preparation.tokensBefore,
				threshold,
			})
		) {
			// Do not clear another in-flight cycle. Initiator-owned pending cycles are
			// released by Pi onError when this cancel surfaces as compaction failure.
			return { cancel: true };
		}
		const compactionConfig = config.codex.compaction;
		if (
			compactionConfig.mode === "auto" &&
			typeof compactionConfig.autoCompactTokenLimit === "number" &&
			compactionConfig.autoCompactTokenLimit >= model.contextWindow
		) {
			coordinator.end(sessionId, "error");
			throw new Error("OpenAI Codex compaction threshold must be below the context window");
		}

		if (!coordinator.beginExecution(sessionId)) {
			// Another runtime.compact is already executing for this session.
			return { cancel: true };
		}
		try {
			if (event.signal.aborted) {
				coordinator.end(sessionId, "cancel");
				return { cancel: true };
			}
			const toolResolution = record(
				await runtime.resolveTools(
					buildToolsResolveParams(resolution, {
						webSearchMode: config.codex.webSearch.mode,
						viewImage: config.tools.optional.viewImage === "auto",
						imageGeneration: config.tools.optional.imageGeneration === "auto",
						standaloneWebSearchExecutorAvailable: true,
					}),
				),
			);
			const officialTools = Array.isArray(toolResolution?.modelTools)
				? toolResolution.modelTools
				: [];
			const tools = mergeTools(pi, officialTools);
			const previous = store.get(sessionId, model.id);
			const messages = [
				...event.preparation.messagesToSummarize,
				...event.preparation.turnPrefixMessages,
			];
			const hasPreviousMarker = messages.some(
				(message) =>
					record(message)?.role === "compactionSummary" &&
					record(message)?.summary === previous?.summary,
			);
			const input = [
				...(hasPreviousMarker ? (previous?.output ?? []) : []),
				...responseItemsFromMessages(messages),
			];
			const result = await runtime.compact({
				connection,
				request: {
					model: model.id,
					input,
					instructions: ctx.getSystemPrompt(),
					tools: tools.length === 0 ? null : tools,
					parallel_tool_calls: true,
					reasoning: reasoningFor(model, pi.getThinkingLevel()),
					service_tier: config.codex.serviceTier,
					prompt_cache_key: sessionId,
					text: { verbosity: config.codex.verbosity },
				},
				implementation: selectCompactionImplementation(resolution.provider),
				transportMode: config.codex.transport.mode,
				providerSupportsWebsockets: supportsProviderWebsockets(
					model,
					resolution.provider.supportsWebsockets,
				),
				signal: event.signal,
			});
			if (event.signal.aborted) {
				coordinator.end(sessionId, "cancel");
				return { cancel: true };
			}
			if (result.status !== "completed") {
				throw new Error(`OpenAI Codex compaction ended with status ${result.status}`);
			}
			const output = record(result.result)?.output;
			if (!Array.isArray(output)) {
				throw new Error("OpenAI Codex compaction returned an invalid canonical window");
			}
			const details = createCodexCompactionDetails(model.id, output);
			// Keep the execution lease until session_compact (or onError paths) clear it.
			return {
				compaction: {
					summary: COMPACTION_SUMMARY,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details,
				},
			};
		} catch (error) {
			coordinator.end(sessionId, "error");
			throw error;
		}
	});
}

async function maybeTriggerThresholdCompaction(
	ctx: ExtensionContext,
	state: {
		runtime: CodexRuntime;
		configuration: ConfigurationService;
		activation: ProviderActivationPolicy;
		coordinator: CodexCompactionCoordinator;
	},
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const model = ctx.model;
	if (model === undefined || !state.activation.isActive(model)) {
		state.coordinator.setPreviousTokens(sessionId, null);
		return;
	}
	const usage = ctx.getContextUsage?.();
	const currentTokens = usage?.tokens ?? null;
	if (currentTokens === null) {
		return;
	}

	const config = await state.configuration.load();
	const compaction = config.codex.compaction;
	if (compaction.mode === "off") {
		state.coordinator.setPreviousTokens(sessionId, currentTokens);
		return;
	}

	const threshold = await resolveThresholdForModel(
		ctx,
		sessionId,
		model.id,
		model.contextWindow,
		compaction,
		state,
	);
	const previousTokens = state.coordinator.getPreviousTokens(sessionId);
	const shouldTrigger = shouldTriggerAutoCompaction({
		previousTokens,
		currentTokens,
		threshold,
		compacting: state.coordinator.isBusy(sessionId),
		mode: compaction.mode,
	});
	state.coordinator.setPreviousTokens(sessionId, currentTokens);
	if (!shouldTrigger) return;

	if (!state.coordinator.begin(sessionId)) {
		return;
	}
	ctx.compact({
		onComplete: () => {
			state.coordinator.end(sessionId, "success");
		},
		onError: () => {
			state.coordinator.end(sessionId, "error");
		},
	});
}

async function resolveThresholdForModel(
	_ctx: ExtensionContext,
	sessionId: string,
	modelId: string,
	contextWindow: number,
	compaction: CompactionConfig,
	state: {
		runtime: CodexRuntime;
		activation: ProviderActivationPolicy;
		coordinator: CodexCompactionCoordinator;
	},
): Promise<number | undefined> {
	if (compaction.mode === "auto" && typeof compaction.autoCompactTokenLimit === "number") {
		return resolveCompactionThreshold(compaction, null, contextWindow);
	}
	const cached = state.coordinator.getThresholdCache(sessionId);
	if (cached?.modelId === modelId) {
		return resolveCompactionThreshold(compaction, cached.autoCompactTokenLimit, contextWindow);
	}
	const resolution = parseModelResolution(await state.runtime.resolveModel(modelId), modelId);
	const nextCache: CompactionThresholdCache = {
		modelId,
		autoCompactTokenLimit: resolution.autoCompactTokenLimit,
	};
	state.coordinator.setThresholdCache(sessionId, nextCache);
	return resolveCompactionThreshold(compaction, resolution.autoCompactTokenLimit, contextWindow);
}

function restoreCompaction(ctx: ExtensionContext, store: CodexCompactionStore): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = record(branch[index]);
		if (entry?.type !== "compaction") continue;
		const details = parseCodexCompactionDetails(entry.details);
		if (details !== undefined && typeof entry.summary === "string") {
			store.set(sessionId, entry.summary, details);
		} else {
			store.clear(sessionId);
		}
		return;
	}
	store.clear(sessionId);
}

function acceptCompaction(
	event: SessionCompactEvent,
	ctx: ExtensionContext,
	store: CodexCompactionStore,
): void {
	const details = parseCodexCompactionDetails(event.compactionEntry.details);
	if (details === undefined) return;
	store.set(ctx.sessionManager.getSessionId(), event.compactionEntry.summary, details);
}

function mergeTools(pi: ExtensionAPI, officialTools: readonly unknown[]): unknown[] {
	const officialNames = officialToolNames(officialTools);
	const active = new Set(pi.getActiveTools());
	const thirdParty = pi
		.getAllTools()
		.filter((tool) => active.has(tool.name) && !officialNames.has(tool.name))
		.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: false,
		}));
	return [...officialTools, ...thirdParty];
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

// Keep the imported type referenced for documentation of the event contract.
export type { SessionBeforeCompactEvent };

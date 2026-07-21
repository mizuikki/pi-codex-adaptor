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
	createCodexCompactionDetails,
	parseCodexAutoCompactionCheckpoint,
	parseCodexCompactionDetails,
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
import type { CodexProviderRequestGuard } from "./codex-provider-request-guard.ts";
import {
	type CodexToolProfileCoordinator,
	createUnavailableCodexToolProfile,
} from "./codex-tool-profile.ts";
import { selectCodexToolSurface } from "./codex-tool-surface.ts";
import { resolveProviderConnection } from "./provider-connection.ts";

const COMPACTION_SUMMARY = "Context compacted by the OpenAI Codex Responses API.";

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
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.end(sessionId, "success");
		acceptCompaction(event, ctx, store);
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
		state.coordinator.end(sessionId, "error");
		throw new Error("OpenAI Codex compaction requires an active model");
	}
	if (!state.activation.isActive(model)) return undefined;
	if (event.signal.aborted) return { cancel: true };
	// Pi's post-run threshold event aborts the active retry path. Inline automatic
	// compaction is owned by before_provider_request; overflow remains Pi-owned.
	if (event.reason === "threshold") return { cancel: true };

	let connection: Awaited<ReturnType<typeof resolveProviderConnection>>;
	try {
		connection = await resolveProviderConnection(
			ctx,
			state.activation,
			"Codex compaction is inactive for the selected provider and API",
		);
	} catch (error) {
		state.coordinator.end(sessionId, "error");
		throw error;
	}
	const config = await state.configuration.load();
	if (config.codex.compaction.mode === "off") {
		state.coordinator.end(sessionId, "cancel");
		return { cancel: true };
	}
	const capabilityKey = capabilityCacheKey({
		modelId: model.id,
		providerId: model.provider,
		config,
		contextWindow: model.contextWindow,
	});
	if (!state.profile.isHealthy(capabilityKey)) {
		state.coordinator.end(sessionId, "error");
		throw new Error("Codex tool profile is unavailable for the selected capability");
	}
	const capabilitySnapshot = await state.capabilities.resolve({
		modelId: model.id,
		providerId: model.provider,
		config,
		contextWindow: model.contextWindow,
	});
	if (!state.coordinator.beginExecution(sessionId)) return { cancel: true };
	try {
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
		const previous = matchingSnapshot(state.store.getForSession(sessionId), identity);
		const messages = [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		const input = [...(previous?.output ?? []), ...responseItemsFromMessages(messages)];
		const remoteV2Context = remoteCompactionV2Context(
			capabilitySnapshot.compaction.implementation,
			sessionId,
			"manual",
		);
		const result = await state.runtime.compact({
			connection,
			request: {
				model: model.id,
				input,
				instructions: withSupplementalSessionInstructions(
					ctx.getSystemPrompt(),
					capabilitySnapshot,
				),
				tools: tools.length === 0 ? null : tools,
				parallel_tool_calls: true,
				reasoning: reasoningFor(model, state.pi.getThinkingLevel()),
				service_tier: config.codex.serviceTier,
				prompt_cache_key: sessionId,
				text: { verbosity: config.codex.verbosity },
			},
			implementation: capabilitySnapshot.compaction.implementation ?? "compact_endpoint",
			transportMode: config.codex.transport.mode,
			providerSupportsWebsockets: capabilitySnapshot.providerSupportsWebsockets,
			...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
			signal: event.signal,
		});
		if (event.signal.aborted || result.status === "aborted") {
			state.coordinator.end(sessionId, "cancel");
			return { cancel: true };
		}
		if (result.status !== "completed")
			throw new Error(`OpenAI Codex compaction ended with status ${result.status}`);
		const output = validateCompactionOutput(record(result.result)?.output);
		const details = createCodexCompactionDetails(identity, output);
		state.coordinator.end(sessionId, "success");
		return {
			compaction: {
				summary: COMPACTION_SUMMARY,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details,
			},
		};
	} catch (error) {
		state.coordinator.end(sessionId, "error");
		throw error;
	}
}

function restoreCompaction(ctx: ExtensionContext, store: CodexCompactionStore): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = record(branch[index]);
		if (entry?.type === "custom" && entry.customType === CODEX_AUTO_COMPACTION_KIND) {
			const checkpoint = parseCodexAutoCompactionCheckpoint(entry.data);
			if (checkpoint === undefined) store.markReplayInvalid(sessionId);
			else if (typeof entry.id === "string") store.setAutomatic(sessionId, checkpoint, entry.id);
			else store.markReplayInvalid(sessionId);
			return;
		}
		if (entry?.type !== "compaction") continue;
		const details = parseCodexCompactionDetails(entry.details);
		if (details === undefined || details.version !== 2 || typeof entry.summary !== "string") {
			store.clear(sessionId);
			return;
		}
		if (typeof entry.id !== "string") {
			store.markReplayInvalid(sessionId);
			return;
		}
		store.setManual(sessionId, entry.summary, details, entry.id);
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
	if (details === undefined || details.version !== 2) {
		store.clear(ctx.sessionManager.getSessionId());
		return;
	}
	store.setManual(
		ctx.sessionManager.getSessionId(),
		event.compactionEntry.summary,
		details,
		event.compactionEntry.id,
	);
}

function matchingSnapshot(
	snapshot: ReturnType<CodexCompactionStore["getForSession"]>,
	identity: {
		readonly sessionFingerprint: string;
		readonly providerId: string;
		readonly api: string;
		readonly baseUrl: string;
		readonly modelId: string;
		readonly authenticationBinding: unknown;
	},
): { readonly output: readonly unknown[] } | undefined {
	if (snapshot === undefined) return undefined;
	const value = snapshot.source === "manual" ? snapshot.details : snapshot.checkpoint;
	if (
		value.sessionFingerprint !== identity.sessionFingerprint ||
		value.providerId !== identity.providerId ||
		value.api !== identity.api ||
		value.baseUrl !== identity.baseUrl ||
		value.modelId !== identity.modelId ||
		JSON.stringify(value.authenticationBinding) !== JSON.stringify(identity.authenticationBinding)
	) {
		return undefined;
	}
	return { output: snapshot.output };
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

export type { SessionBeforeCompactEvent };

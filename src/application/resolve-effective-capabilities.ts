import {
	type Availability,
	buildToolsResolveParams,
	type CompleteCodexProviderContract,
	completeProviderContract,
	type ManagedToolName,
	parseModelResolution,
	parseToolResolution,
} from "../domain/capability.ts";
import type { CodexConfig, ConfigCapabilityContext, ShellSurface } from "../domain/config.ts";
import type { CodexRuntime } from "./codex-runtime.ts";

export const SUPPLEMENTAL_SESSION_INSTRUCTIONS =
	"Use shell_command for bounded commands. For commands expected to remain running after the initial yield or that require later input, use exec_command, retain its session_id, and poll or write through write_stdin until the process exits.";

export interface EffectiveCapabilitySnapshot {
	modelId: string;
	model: Record<string, unknown>;
	bridgeCapabilities: readonly string[];
	providerContract: CompleteCodexProviderContract;
	providerSupportsWebsockets: boolean;
	modelTools: readonly unknown[];
	dispatchTools: readonly unknown[];
	localTools: readonly ManagedToolName[];
	hostedTools: readonly string[];
	shell: {
		primary: ShellSurface;
		bounded: Availability;
		sessions: Availability;
		sessionSurface: "official" | "supplemental" | "disabled" | "unavailable";
	};
	applyPatch: Availability;
	viewImage: Availability;
	imageGeneration: Availability;
	webSearch: Availability;
	webSurface: "standalone" | "hosted" | "disabled" | "unsupported";
	compaction: {
		manual: Availability;
		automatic: Availability;
		modelThreshold: number | null;
		threshold: number | null;
		implementation: "remote_v2" | "compact_endpoint" | null;
	};
	transport: Availability;
}

export interface ResolveEffectiveCapabilitiesInput {
	modelId: string;
	providerId: string;
	config: CodexConfig;
	contextWindow?: number;
}

export class ResolveEffectiveCapabilities {
	readonly #runtime: CodexRuntime;
	readonly #cache = new Map<string, Promise<EffectiveCapabilitySnapshot>>();

	constructor(runtime: CodexRuntime) {
		this.#runtime = runtime;
	}

	resolve(input: ResolveEffectiveCapabilitiesInput): Promise<EffectiveCapabilitySnapshot> {
		const key = capabilityCacheKey(input);
		let pending = this.#cache.get(key);
		if (pending === undefined) {
			pending = this.#resolve(input).catch((error) => {
				this.#cache.delete(key);
				throw error;
			});
			this.#cache.set(key, pending);
		}
		return pending;
	}

	invalidate(): void {
		this.#cache.clear();
	}

	async #resolve(input: ResolveEffectiveCapabilitiesInput): Promise<EffectiveCapabilitySnapshot> {
		const nativeDiagnostics = await this.#runtime.readDiagnostics?.();
		const bridgeCapabilities = parseBridgeCapabilities(nativeDiagnostics);
		const modelResolution = parseModelResolution(
			await this.#runtime.resolveModel(input.modelId),
			input.modelId,
		);
		const bridge = new Set(bridgeCapabilities);
		const sessionExecutorAvailable = bridge.has("unified_exec");
		const tools = parseToolResolution(
			await this.#runtime.resolveTools(
				buildToolsResolveParams(modelResolution, {
					providerId: input.providerId,
					webSearchMode: input.config.codex.webSearch.mode,
					viewImage: input.config.tools.optional.viewImage === "auto",
					imageGeneration: input.config.tools.optional.imageGeneration === "auto",
					backgroundSessions: input.config.tools.backgroundSessions && sessionExecutorAvailable,
					bridgeCapabilities,
				}),
			),
		);
		const requestedSessionExecutorMissing =
			input.config.tools.backgroundSessions && !sessionExecutorAvailable;
		const providerContract = completeProviderContract(input.providerId);
		const providerSupportsWebsockets =
			providerContract.responsesWebsocket === "official-only" &&
			bridge.has("responses_websocket") &&
			input.providerId === "openai-codex";
		const portableContextSummary = bridge.has("portable_context_summary");
		const transport = bridge.has("responses_sse")
			? available("provider-contract")
			: unavailable("responses_sse_executor_unavailable");
		const implementation =
			portableContextSummary &&
			(bridge.has("remote_compaction_v2") || bridge.has("compact_endpoint"))
				? bridge.has("remote_compaction_v2")
					? "remote_v2"
					: "compact_endpoint"
				: null;
		const manualCompaction =
			input.config.codex.compaction.mode === "off"
				? disabled("disabled_by_configuration")
				: implementation === null
					? unavailable("compaction_executor_unavailable")
					: available("provider-contract");
		const threshold = resolveThreshold(
			input.config,
			modelResolution.autoCompactTokenLimit,
			input.contextWindow,
		);
		const automaticCompaction =
			manualCompaction.status !== "available"
				? manualCompaction
				: threshold === null
					? unavailable("auto_compact_threshold_unavailable")
					: available("official");
		return {
			modelId: input.modelId,
			model: modelResolution.model,
			bridgeCapabilities,
			providerContract,
			providerSupportsWebsockets,
			modelTools: tools.modelTools,
			dispatchTools: tools.dispatchTools,
			localTools: tools.localToolNames,
			hostedTools: tools.hostedToolNames,
			shell: {
				primary: tools.shellSurface,
				bounded:
					tools.shellSurface === "disabled"
						? unavailable("model_shell_disabled")
						: bridge.has(tools.shellSurface === "unified-exec" ? "unified_exec" : "shell_command")
							? available("official")
							: unavailable("shell_executor_unavailable"),
				sessions: requestedSessionExecutorMissing
					? unavailable("session_executor_unavailable")
					: tools.capabilities.sessions,
				sessionSurface: requestedSessionExecutorMissing ? "unavailable" : tools.sessionSurface,
			},
			applyPatch: requireBridge(tools.capabilities.applyPatch, bridge, "apply_patch"),
			viewImage: requireBridge(tools.capabilities.viewImage, bridge, "view_image"),
			imageGeneration: requireBridge(
				tools.capabilities.imageGeneration,
				bridge,
				"image_generation",
			),
			webSearch: requireEitherBridge(
				tools.capabilities.webSearch,
				bridge,
				"standalone_web_search",
				"hosted_web_search",
			),
			webSurface: tools.webSurface,
			compaction: {
				manual: manualCompaction,
				automatic: automaticCompaction,
				modelThreshold: modelResolution.autoCompactTokenLimit,
				threshold,
				implementation,
			},
			transport,
		};
	}
}

export function capabilityContextFromSnapshot(
	snapshot: EffectiveCapabilitySnapshot,
	contextWindow?: number,
): ConfigCapabilityContext {
	return {
		...(contextWindow === undefined ? {} : { contextWindow }),
		modelAutoCompactTokenLimit: snapshot.compaction.modelThreshold,
		bridgeCapabilities: snapshot.bridgeCapabilities,
		shellSurface: snapshot.shell.primary,
		// A disabled session setting is still reversible. Only an unavailable executor or
		// disabled shell surface should make the setting itself unavailable in the UI.
		backgroundSessionsAvailable:
			snapshot.bridgeCapabilities.includes("unified_exec") &&
			snapshot.shell.sessionSurface !== "unavailable",
		viewImageAvailable: snapshot.viewImage.status === "available",
		imageGenerationAvailable: snapshot.imageGeneration.status === "available",
		webSearchAvailable: snapshot.webSearch.status === "available",
		manualCompactionAvailable: snapshot.compaction.manual.status === "available",
		transportAvailable: snapshot.transport.status === "available",
		providerSupportsWebsockets: snapshot.providerSupportsWebsockets,
		remoteCompactionV2: snapshot.compaction.implementation === "remote_v2",
		compactEndpoint: snapshot.compaction.implementation === "compact_endpoint",
		portableContextSummary: snapshot.bridgeCapabilities.includes("portable_context_summary"),
	};
}

export function withSupplementalSessionInstructions(
	instructions: string,
	snapshot: EffectiveCapabilitySnapshot,
): string {
	if (snapshot.shell.sessionSurface !== "supplemental") return instructions;
	if (instructions.includes(SUPPLEMENTAL_SESSION_INSTRUCTIONS)) return instructions;
	return instructions.length === 0
		? SUPPLEMENTAL_SESSION_INSTRUCTIONS
		: `${instructions}\n\n${SUPPLEMENTAL_SESSION_INSTRUCTIONS}`;
}

function parseBridgeCapabilities(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Verified bridge diagnostics are unavailable");
	}
	const capabilities = (value as Record<string, unknown>).capabilities;
	if (
		!Array.isArray(capabilities) ||
		!capabilities.every((item) => typeof item === "string" && item.length > 0)
	) {
		throw new Error("Verified bridge capability identity is unavailable");
	}
	return [...new Set(capabilities)];
}

function resolveThreshold(
	config: CodexConfig,
	modelThreshold: number | null,
	contextWindow: number | undefined,
): number | null {
	if (config.codex.compaction.mode === "off") return null;
	const value =
		typeof config.codex.compaction.autoCompactTokenLimit === "number"
			? config.codex.compaction.autoCompactTokenLimit
			: modelThreshold;
	if (value === null || value <= 0) return null;
	if (contextWindow !== undefined && value >= contextWindow) return null;
	return value;
}

function requireBridge(
	value: Availability,
	bridge: ReadonlySet<string>,
	capability: string,
): Availability {
	return value.status === "available" && !bridge.has(capability)
		? unavailable(`${capability}_executor_unavailable`)
		: value;
}

function requireEitherBridge(
	value: Availability,
	bridge: ReadonlySet<string>,
	first: string,
	second: string,
): Availability {
	return value.status === "available" && !bridge.has(first) && !bridge.has(second)
		? unavailable("web_search_executor_unavailable")
		: value;
}

function available(source: "official" | "supplemental" | "provider-contract"): Availability {
	return { status: "available", source };
}

function disabled(reason: string): Availability {
	return { status: "disabled", reason };
}

function unavailable(reason: string): Availability {
	return { status: "unavailable", reason };
}

/** Stable application-owned projection shared by capability caching and Pi profile readiness. */
export function capabilityCacheKey(input: ResolveEffectiveCapabilitiesInput): string {
	const compaction = input.config.codex.compaction;
	return JSON.stringify([
		input.modelId,
		input.providerId,
		input.contextWindow ?? null,
		{
			webSearchMode: input.config.codex.webSearch.mode,
			viewImage: input.config.tools.optional.viewImage,
			imageGeneration: input.config.tools.optional.imageGeneration,
			backgroundSessions: input.config.tools.backgroundSessions,
			compactionMode: compaction.mode,
			autoCompactTokenLimit: compaction.mode === "auto" ? compaction.autoCompactTokenLimit : null,
		},
	]);
}

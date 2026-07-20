import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	CodexRuntime,
	CompactResponseOptions,
	CreateResponseResult,
	ExecuteToolOptions,
} from "../../src/application/codex-runtime.ts";
import {
	CodexCompactionCoordinator,
	CodexCompactionStore,
	type CompactionOperation,
	type CompactionPhase,
	type CompactionTrigger,
	createCodexAutoCompactionCheckpoint,
	createCodexCompactionDetails,
	parseCodexAutoCompactionCheckpoint,
	parseCodexCompactionDetails,
	resolveCompactionThreshold,
	shouldCreateAutomaticCheckpoint,
	validateCompactionOutput,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";
import type {
	CodexToolProfileCoordinator,
	CodexToolProfileReadiness,
} from "../../src/integration/pi/codex-tool-profile.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

const OPAQUE = "synthetic-opaque-content";

class FixtureRuntime implements CodexRuntime {
	compaction: CompactResponseOptions | undefined;
	compactCalls = 0;
	compactImpl: ((options: CompactResponseOptions) => Promise<CreateResponseResult>) | undefined;
	bridgeCapabilities = [
		"responses_sse",
		"responses_websocket",
		"remote_compaction_v2",
		"compact_endpoint",
		"update_plan",
		"unified_exec",
		"shell_command",
		"apply_patch",
		"view_image",
		"image_generation",
		"standalone_web_search",
		"hosted_web_search",
	];

	async createResponse(): Promise<CreateResponseResult> {
		return { status: "completed", result: {} };
	}

	async compact(options: CompactResponseOptions): Promise<CreateResponseResult> {
		this.compactCalls += 1;
		this.compaction = options;
		if (this.compactImpl !== undefined) return this.compactImpl(options);
		return {
			status: "completed",
			result: { output: [{ type: "compaction", encrypted_content: OPAQUE }] },
		};
	}

	async readDiagnostics(): Promise<unknown> {
		return { capabilities: this.bridgeCapabilities };
	}

	async resolveModel(modelId: string): Promise<unknown> {
		return {
			model: { slug: modelId },
			shellSurface: "unified-exec",
			autoCompactTokenLimit: 90_000,
			provider: {
				name: "Codex",
				supportsWebsockets: true,
				supportsRemoteCompaction: true,
				namespaceTools: true,
				imageGeneration: true,
				hostedWebSearch: true,
			},
		};
	}

	async resolveTools(): Promise<unknown> {
		return {
			modelTools: [],
			dispatchTools: [],
			localToolNames: [],
			hostedToolNames: [],
			shellSurface: "unified-exec",
			sessionSurface: "official",
			webSurface: "hosted",
			imageGenerationSurface: "disabled",
			capabilities: {
				sessions: { status: "available", source: "official" },
				applyPatch: { status: "unavailable", reason: "fixture" },
				viewImage: { status: "unavailable", reason: "fixture" },
				imageGeneration: { status: "unavailable", reason: "fixture" },
				webSearch: { status: "unavailable", reason: "fixture" },
			},
		};
	}

	async executeTool(_options: ExecuteToolOptions): Promise<CreateResponseResult> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

function fixtureToken(accountId = "account-fixture"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function configuration(
	overrides?: Partial<ReturnType<typeof createDefaultConfig>["codex"]["compaction"]>,
): ConfigurationService {
	const defaults = createDefaultConfig();
	return {
		load: async () => ({
			...defaults,
			codex: {
				...defaults.codex,
				compaction: { ...defaults.codex.compaction, ...overrides },
			},
		}),
	} as ConfigurationService;
}

const model: Model<string> = {
	id: "fixture-model",
	name: "Fixture model",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://invalid.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

function context(
	options: {
		tokens?: number;
		authFailure?: boolean;
		sessionId?: string;
		compact?: ExtensionContext["compact"];
	} = {},
): ExtensionContext {
	return {
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				options.authFailure === true
					? { ok: false, error: "fixture authentication failure" }
					: { ok: true, apiKey: fixtureToken(), headers: {} },
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-fixture",
			getBranch: () => [],
		},
		getSystemPrompt: () => "fixture system",
		getContextUsage: () => ({
			tokens: options.tokens ?? 50_000,
			contextWindow: 100_000,
			percent: (options.tokens ?? 50_000) / 1_000,
		}),
		compact: options.compact ?? (() => {}),
	} as unknown as ExtensionContext;
}

function compactEvent(
	reason: "manual" | "threshold" | "overflow",
	tokensBefore = 50_000,
	signal: AbortSignal = new AbortController().signal,
): Record<string, unknown> {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [{ role: "user", content: "compact this", timestamp: 1 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore,
			fileOps: { read: [], written: [] },
			settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 5_000 },
		},
		branchEntries: [],
		reason,
		willRetry: false,
		signal,
	};
}

function healthyProfile(): CodexToolProfileCoordinator {
	const readiness: CodexToolProfileReadiness = { kind: "healthy", capabilityKey: "fixture-key" };
	return {
		readiness,
		skillLoader: undefined,
		enterPending: () => {},
		installHealthy: () => true,
		installUnavailable: () => {},
		revalidateHealthyOwnership: () => true,
		isHealthy: () => true,
		restorePi: () => {},
		dispose: () => {},
	};
}

function register(
	runtime: FixtureRuntime,
	config: ConfigurationService = configuration(),
	store = new CodexCompactionStore(),
	coordinator = new CodexCompactionCoordinator(),
): {
	handlers: Map<string, EventHandler[]>;
	store: CodexCompactionStore;
	coordinator: CodexCompactionCoordinator;
} {
	const handlers = new Map<string, EventHandler[]>();
	registerCodexCompaction(
		{
			on: (name: string, handler: EventHandler) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "low",
		} as never,
		runtime,
		config,
		store,
		new ProviderActivationPolicy(config),
		coordinator,
		undefined,
		healthyProfile(),
	);
	return { handlers, store, coordinator };
}

function identity() {
	return {
		sessionFingerprint: "sha256:session-fixture",
		providerId: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://invalid.example",
		modelId: "fixture-model",
		authenticationBinding: { kind: "credential" as const, fingerprint: "sha256:credential" },
	};
}

describe("Codex compaction contracts", () => {
	test("accepts the canonical protocol-3 compaction projection and deep-clones it", () => {
		const value = {
			type: "compaction",
			id: "synthetic-item-id",
			encrypted_content: OPAQUE,
			internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
		};
		const output = validateCompactionOutput([
			{ type: "message", role: "assistant", content: [] },
			value,
		]);
		value.internal_chat_message_metadata_passthrough.turn_id = "changed";
		expect(output).toEqual([
			{ type: "message", role: "assistant", content: [] },
			{
				type: "compaction",
				id: "synthetic-item-id",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
		]);
		expect(Object.isFrozen(output)).toBe(true);
		expect(Object.isFrozen(output[1])).toBe(true);
	});

	test("rejects aliases, unsupported items, multiple compactions, and unsafe values", () => {
		const valid = { type: "compaction", encrypted_content: OPAQUE };
		expect(() =>
			validateCompactionOutput([{ type: "compaction_summary", encrypted_content: OPAQUE }]),
		).toThrow();
		expect(() => validateCompactionOutput([{ type: "future_item" }, valid])).toThrow();
		expect(() =>
			validateCompactionOutput([valid, { ...valid, encrypted_content: "second" }]),
		).toThrow();
		expect(() =>
			validateCompactionOutput([{ type: "compaction", encrypted_content: "" }]),
		).toThrow();
		expect(() =>
			validateCompactionOutput([
				{ type: "compaction", encrypted_content: OPAQUE, value: Number.NaN },
			]),
		).toThrow();
		expect(() =>
			validateCompactionOutput([Object.assign(Object.create({ polluted: true }), valid)]),
		).toThrow();
		const accessor = {} as Record<string, unknown>;
		Object.defineProperty(accessor, "type", {
			enumerable: true,
			get: () => "compaction",
		});
		expect(() => validateCompactionOutput([accessor])).toThrow();
		const sparse = new Array(2);
		sparse[1] = valid;
		expect(() => validateCompactionOutput(sparse)).toThrow();
		const symbolValue = { ...valid } as Record<string | symbol, unknown>;
		symbolValue[Symbol("synthetic")] = "rejected";
		expect(() => validateCompactionOutput([symbolValue])).toThrow();
		const nonEnumerable = { ...valid };
		Object.defineProperty(nonEnumerable, "id", { value: "hidden", enumerable: false });
		expect(() => validateCompactionOutput([nonEnumerable])).toThrow();
		expect(() =>
			validateCompactionOutput([
				{
					type: "compaction",
					encrypted_content: OPAQUE,
					internal_chat_message_metadata_passthrough: { marker: "unsupported" },
				},
			]),
		).toThrow();
	});

	test("exposes Pi-independent lifecycle operation values", () => {
		const trigger: CompactionTrigger = "auto";
		const phase: CompactionPhase = "mid_turn";
		const operation: CompactionOperation = {
			trigger,
			phase,
			sessionId: "synthetic-session",
			modelId: "synthetic-model",
			input: [{ type: "message", role: "user", content: [] }],
		};
		expect(operation).toMatchObject({ trigger: "auto", phase: "mid_turn" });
	});

	test("round-trips manual v2 and automatic v1 contracts while blocking legacy replay", () => {
		const details = createCodexCompactionDetails(identity(), [
			{ type: "compaction", encrypted_content: OPAQUE },
		]);
		expect(parseCodexCompactionDetails(details)).toEqual(details);
		const checkpoint = createCodexAutoCompactionCheckpoint(
			identity(),
			"checkpoint-fixture",
			"entry-fixture",
			details.output,
		);
		expect(parseCodexAutoCompactionCheckpoint(checkpoint)).toEqual(checkpoint);
		const legacy = createCodexCompactionDetails("fixture-model", [
			{ type: "message", role: "assistant" },
		]);
		expect(parseCodexCompactionDetails(legacy)).toMatchObject({
			version: 1,
			replay: "legacy_identity_missing",
		});
		const store = new CodexCompactionStore();
		store.set("session-fixture", "legacy", legacy);
		expect(store.getForSession("session-fixture")).toBeUndefined();
		expect(parseCodexCompactionDetails({ ...details, version: 3 })).toBeUndefined();
		expect(parseCodexCompactionDetails({ ...details, extra: true })).toBeUndefined();
		expect(
			parseCodexAutoCompactionCheckpoint({
				...checkpoint,
				checkpointId: checkpoint.checkpointId,
				extra: true,
			}),
		).toBeUndefined();
	});

	test("resolves request-bound threshold eligibility", () => {
		expect(
			resolveCompactionThreshold({ mode: "auto", autoCompactTokenLimit: "model" }, 90_000, 100_000),
		).toBe(90_000);
		expect(resolveCompactionThreshold({ mode: "off" }, 90_000, 100_000)).toBeUndefined();
		expect(
			resolveCompactionThreshold({ mode: "auto", autoCompactTokenLimit: 100_000 }, 90_000, 100_000),
		).toBeUndefined();
		expect(
			shouldCreateAutomaticCheckpoint({
				mode: "auto",
				contextTokens: 90_001,
				threshold: 90_000,
				hasUncheckpointedInput: true,
				busy: false,
			}),
		).toBe(true);
		expect(
			shouldCreateAutomaticCheckpoint({
				mode: "auto",
				contextTokens: 90_001,
				threshold: 90_000,
				hasUncheckpointedInput: false,
				busy: false,
			}),
		).toBe(false);
		expect(
			shouldCreateAutomaticCheckpoint({
				mode: "auto",
				contextTokens: 90_001,
				threshold: 90_000,
				hasUncheckpointedInput: true,
				busy: true,
			}),
		).toBe(false);
	});

	test("serializes compaction operations per session", () => {
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.beginExecution("session-a")).toBe(true);
		expect(coordinator.beginExecution("session-a")).toBe(false);
		expect(coordinator.isBusy("session-a")).toBe(true);
		expect(coordinator.beginExecution("session-b")).toBe(true);
		coordinator.end("session-a", "success");
		coordinator.end("session-b", "cancel");
		expect(coordinator.isBusy("session-a")).toBe(false);
	});
});

describe("manual Pi compaction", () => {
	test("returns provider-bound v2 opaque details and never registers a turn-end scheduler", async () => {
		const runtime = new FixtureRuntime();
		const { handlers, store } = register(runtime);
		const result = (await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			context(),
		)) as {
			compaction: { summary: string; details: unknown; firstKeptEntryId: string };
		};
		expect(result.compaction.summary).toBe("Context compacted by the OpenAI Codex Responses API.");
		expect(parseCodexCompactionDetails(result.compaction.details)).toMatchObject({
			version: 2,
			output: [{ type: "compaction", encrypted_content: OPAQUE }],
		});
		expect(handlers.has("turn_end")).toBe(false);
		expect(runtime.compactCalls).toBe(1);
		await handlers.get("session_compact")?.[0]?.(
			{
				type: "session_compact",
				compactionEntry: {
					type: "compaction",
					id: "compaction-entry",
					parentId: "parent-entry",
					timestamp: new Date(0).toISOString(),
					summary: result.compaction.summary,
					firstKeptEntryId: result.compaction.firstKeptEntryId,
					tokensBefore: 50_000,
					details: result.compaction.details,
				},
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			context(),
		);
		expect(store.getForSession("session-fixture")?.source).toBe("manual");
	});

	test("consumes the settings reservation when Pi starts manual compaction", async () => {
		const runtime = new FixtureRuntime();
		const { handlers, coordinator } = register(runtime);
		expect(coordinator.begin("session-fixture")).toBe(true);
		const result = (await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			context(),
		)) as { compaction: { details: unknown } };
		expect(parseCodexCompactionDetails(result.compaction.details)?.version).toBe(2);
		expect(runtime.compactCalls).toBe(1);
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("cancels threshold events, keeps overflow recovery, and honors cancellation", async () => {
		const runtime = new FixtureRuntime();
		const { handlers } = register(runtime);
		const threshold = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("threshold"),
			context({ tokens: 99_000 }),
		);
		expect(threshold).toEqual({ cancel: true });
		expect(runtime.compactCalls).toBe(0);
		await handlers.get("session_before_compact")?.[0]?.(compactEvent("overflow"), context());
		expect(runtime.compactCalls).toBe(1);
		const controller = new AbortController();
		controller.abort();
		const cancelled = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 50_000, controller.signal),
			context(),
		);
		expect(cancelled).toEqual({ cancel: true });
		expect(runtime.compactCalls).toBe(1);
	});

	test("fails closed for malformed native output and auth failures", async () => {
		const malformed = new FixtureRuntime();
		malformed.compactImpl = async () => ({
			status: "completed",
			result: { output: [{ type: "message" }] },
		});
		const malformedRegistration = register(malformed);
		await expect(
			malformedRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context(),
			),
		).rejects.toThrow("Compaction output window is invalid");
		expect(malformed.compactCalls).toBe(1);

		const authRuntime = new FixtureRuntime();
		const authRegistration = register(authRuntime);
		await expect(
			authRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ authFailure: true }),
			),
		).rejects.toThrow("authentication");
		expect(authRuntime.compactCalls).toBe(0);
	});

	test("rejects concurrent manual operations and clears the coordinator after failure", async () => {
		const runtime = new FixtureRuntime();
		let release: (() => void) | undefined;
		runtime.compactImpl = () =>
			new Promise((resolve) => {
				release = () =>
					resolve({
						status: "completed",
						result: { output: [{ type: "compaction", encrypted_content: OPAQUE }] },
					});
			});
		const { handlers, coordinator } = register(runtime);
		const first = handlers.get("session_before_compact")?.[0]?.(compactEvent("manual"), context());
		while (release === undefined) await Promise.resolve();
		const second = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			context(),
		);
		expect(second).toEqual({ cancel: true });
		expect(coordinator.isBusy("session-fixture")).toBe(true);
		release?.();
		await first;
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});
});

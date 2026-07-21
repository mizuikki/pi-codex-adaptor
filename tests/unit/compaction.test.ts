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
import type { ResolveEffectiveCapabilities } from "../../src/application/resolve-effective-capabilities.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";
import type {
	CodexToolProfileCoordinator,
	CodexToolProfileReadiness,
} from "../../src/integration/pi/codex-tool-profile.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

const OPAQUE = "synthetic-opaque-content";
const COMPACTION_FAILURE_NOTIFICATION =
	"OpenAI Codex compaction failed; the session context was left unchanged.";

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
		authHeaders?: Record<string, string>;
		sessionId?: string;
		compact?: ExtensionContext["compact"];
		model?: Model<string> | undefined;
		notifications?: Array<{ message: string; type: string | undefined }>;
		notifyFailure?: boolean;
	} = {},
): ExtensionContext {
	return {
		model: Object.hasOwn(options, "model") ? options.model : model,
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				options.authFailure === true
					? { ok: false, error: "fixture authentication failure" }
					: { ok: true, apiKey: fixtureToken(), headers: options.authHeaders ?? {} },
		},
		ui: {
			notify: (message: string, type?: string) => {
				if (options.notifyFailure === true) throw new Error("synthetic UI failure");
				options.notifications?.push({ message, type });
			},
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
	profile: CodexToolProfileCoordinator = healthyProfile(),
	capabilities?: ResolveEffectiveCapabilities,
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
		capabilities,
		profile,
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
		coordinator.endPending("session-a", "cancel");
		expect(coordinator.isBusy("session-a")).toBe(true);
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

	test("terminally cancels malformed native output and authentication failures", async () => {
		const malformed = new FixtureRuntime();
		malformed.compactImpl = async () => ({
			status: "completed",
			result: { output: [{ type: "message" }] },
		});
		const malformedRegistration = register(malformed);
		const malformedNotifications: Array<{ message: string; type: string | undefined }> = [];
		expect(
			await malformedRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ notifications: malformedNotifications }),
			),
		).toEqual({ cancel: true });
		expect(malformed.compactCalls).toBe(1);
		expect(malformedRegistration.coordinator.isBusy("session-fixture")).toBe(false);
		expect(malformedRegistration.store.getForSession("session-fixture")).toBeUndefined();
		expect(malformedNotifications).toEqual([
			{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" },
		]);

		const authRuntime = new FixtureRuntime();
		const authRegistration = register(authRuntime);
		const authNotifications: Array<{ message: string; type: string | undefined }> = [];
		expect(
			await authRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ authFailure: true, notifications: authNotifications }),
			),
		).toEqual({ cancel: true });
		expect(authRuntime.compactCalls).toBe(0);
		expect(authRegistration.coordinator.isBusy("session-fixture")).toBe(false);
		expect(authNotifications).toEqual([
			{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" },
		]);
	});

	test("redacts native failures and preserves existing compaction state", async () => {
		const runtime = new FixtureRuntime();
		runtime.compactImpl = async () => {
			throw new Error(
				"synthetic https://private.invalid token-fixture session-fixture prompt-fixture",
			);
		};
		const store = new CodexCompactionStore();
		store.setManual(
			"session-fixture",
			"Synthetic stored summary",
			createCodexCompactionDetails(identity(), [{ type: "compaction", encrypted_content: OPAQUE }]),
			"stored-entry",
		);
		const before = structuredClone(store.getForSession("session-fixture"));
		const registration = register(runtime, configuration(), store);
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const result = await registration.handlers.get("session_before_compact")?.[0]?.(
			compactEvent("overflow"),
			context({ notifications }),
		);

		expect(result).toEqual({ cancel: true });
		expect(runtime.compactCalls).toBe(1);
		expect(registration.coordinator.isBusy("session-fixture")).toBe(false);
		expect(store.getForSession("session-fixture")).toEqual(before);
		expect(notifications).toEqual([{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" }]);
		expect(JSON.stringify(notifications)).not.toContain("private.invalid");
		expect(JSON.stringify(notifications)).not.toContain("token-fixture");
		expect(JSON.stringify(notifications)).not.toContain("prompt-fixture");
	});

	test("terminally cancels profile, capability, identity, and native status failures", async () => {
		const cases: Array<{
			name: string;
			create: (notifications: Array<{ message: string; type: string | undefined }>) => {
				registration: ReturnType<typeof register>;
				runtime: FixtureRuntime;
				ctx?: ExtensionContext;
			};
			expectedCalls: number;
		}> = [
			{
				name: "profile",
				create: () => {
					const runtime = new FixtureRuntime();
					return {
						runtime,
						registration: register(
							runtime,
							configuration(),
							new CodexCompactionStore(),
							new CodexCompactionCoordinator(),
							{ ...healthyProfile(), isHealthy: () => false },
						),
					};
				},
				expectedCalls: 0,
			},
			{
				name: "capability",
				create: () => {
					const runtime = new FixtureRuntime();
					runtime.readDiagnostics = async () => {
						throw new Error("synthetic capability failure");
					};
					return { runtime, registration: register(runtime) };
				},
				expectedCalls: 0,
			},
			{
				name: "configuration",
				create: () => {
					const runtime = new FixtureRuntime();
					const unavailableConfiguration = {
						load: async () => {
							throw new Error("synthetic configuration failure");
						},
					} as unknown as ConfigurationService;
					return {
						runtime,
						registration: register(runtime, unavailableConfiguration),
					};
				},
				expectedCalls: 0,
			},
			{
				name: "identity",
				create: (notifications) => {
					const runtime = new FixtureRuntime();
					return {
						runtime,
						registration: register(runtime),
						ctx: context({
							authHeaders: { "chatgpt-account-id": "mismatched-account" },
							notifications,
						}),
					};
				},
				expectedCalls: 0,
			},
			{
				name: "native status",
				create: () => {
					const runtime = new FixtureRuntime();
					runtime.compactImpl = async () => ({ status: "failed", result: {} });
					return { runtime, registration: register(runtime) };
				},
				expectedCalls: 1,
			},
		];

		for (const failureCase of cases) {
			const notifications: Array<{ message: string; type: string | undefined }> = [];
			const {
				registration,
				runtime,
				ctx = context({ notifications }),
			} = failureCase.create(notifications);
			const result = await registration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				ctx,
			);
			expect(result, failureCase.name).toEqual({ cancel: true });
			expect(runtime.compactCalls, failureCase.name).toBe(failureCase.expectedCalls);
			expect(registration.coordinator.isBusy("session-fixture"), failureCase.name).toBe(false);
			expect(registration.store.getForSession("session-fixture"), failureCase.name).toBeUndefined();
			expect(notifications, failureCase.name).toEqual([
				{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" },
			]);
		}
	});

	test("keeps cancellation, inactive-provider, and notification failures non-throwing", async () => {
		const runtime = new FixtureRuntime();
		const registration = register(runtime);
		const inactive = { ...model, provider: "fixture-inactive" };
		expect(
			await registration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ model: inactive }),
			),
		).toBeUndefined();

		const noModelNotifications: Array<{ message: string; type: string | undefined }> = [];
		expect(
			await registration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ model: undefined, notifications: noModelNotifications }),
			),
		).toEqual({ cancel: true });
		expect(noModelNotifications).toEqual([
			{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" },
		]);

		const failedNotification = new FixtureRuntime();
		failedNotification.compactImpl = async () => {
			throw new Error("synthetic native failure");
		};
		const notificationRegistration = register(failedNotification);
		expect(
			await notificationRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ notifyFailure: true }),
			),
		).toEqual({ cancel: true });
		expect(notificationRegistration.coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("does not notify for native cancellation or a late result after abort", async () => {
		const nativeAbort = new FixtureRuntime();
		nativeAbort.compactImpl = async () => ({ status: "aborted", result: {} });
		const nativeAbortRegistration = register(nativeAbort);
		const nativeAbortNotifications: Array<{ message: string; type: string | undefined }> = [];
		expect(
			await nativeAbortRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ notifications: nativeAbortNotifications }),
			),
		).toEqual({ cancel: true });
		expect(nativeAbortNotifications).toEqual([]);

		const controller = new AbortController();
		const lateRuntime = new FixtureRuntime();
		lateRuntime.compactImpl = async () => {
			controller.abort();
			return {
				status: "completed",
				result: { output: [{ type: "compaction", encrypted_content: OPAQUE }] },
			};
		};
		const lateRegistration = register(lateRuntime);
		const lateNotifications: Array<{ message: string; type: string | undefined }> = [];
		expect(
			await lateRegistration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual", 50_000, controller.signal),
				context({ notifications: lateNotifications }),
			),
		).toEqual({ cancel: true });
		expect(lateNotifications).toEqual([]);
		expect(lateRegistration.store.getForSession("session-fixture")).toBeUndefined();
		expect(lateRegistration.coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("does not dispatch when cancellation wins before native execution", async () => {
		const controller = new AbortController();
		const runtime = new FixtureRuntime();
		runtime.resolveTools = async () => {
			controller.abort();
			return {
				modelTools: [],
				dispatchTools: [],
				localToolNames: [],
				hostedToolNames: [],
				shellSurface: "shell-command",
				sessionSurface: "disabled",
				webSurface: "unsupported",
				imageGenerationSurface: "disabled",
				capabilities: {
					sessions: { status: "disabled", reason: "fixture" },
					applyPatch: { status: "unavailable", reason: "fixture" },
					viewImage: { status: "unavailable", reason: "fixture" },
					imageGeneration: { status: "unavailable", reason: "fixture" },
					webSearch: { status: "unavailable", reason: "fixture" },
				},
			};
		};
		const registration = register(runtime);
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		expect(
			await registration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual", 50_000, controller.signal),
				context({ notifications }),
			),
		).toEqual({ cancel: true });
		expect(runtime.compactCalls).toBe(0);
		expect(notifications).toEqual([]);
		expect(registration.coordinator.isBusy("session-fixture")).toBe(false);
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
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const first = handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			context({ notifications }),
		);
		while (release === undefined) await Promise.resolve();
		const second = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			context({ notifications }),
		);
		expect(second).toEqual({ cancel: true });
		expect(notifications).toEqual([]);
		expect(coordinator.isBusy("session-fixture")).toBe(true);
		release?.();
		await first;
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("does not let early cancellation or setup failure release another execution", async () => {
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
		let configurationLoads = 0;
		const config = createDefaultConfig();
		const service = {
			load: async () => {
				configurationLoads += 1;
				if (configurationLoads > 1) throw new Error("synthetic configuration failure");
				return config;
			},
		} as ConfigurationService;
		const { handlers, coordinator } = register(runtime, service);
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const handler = handlers.get("session_before_compact")?.[0];
		if (handler === undefined) throw new Error("compaction handler was not registered");
		const first = handler(compactEvent("manual"), context({ notifications }));
		while (release === undefined) await Promise.resolve();

		expect(await handler(compactEvent("threshold"), context({ notifications }))).toEqual({
			cancel: true,
		});
		const aborted = new AbortController();
		aborted.abort();
		expect(
			await handler(compactEvent("manual", 50_000, aborted.signal), context({ notifications })),
		).toEqual({ cancel: true });
		expect(await handler(compactEvent("manual"), context({ notifications }))).toEqual({
			cancel: true,
		});
		expect(coordinator.isBusy("session-fixture")).toBe(true);
		expect(runtime.compactCalls).toBe(1);
		expect(notifications).toEqual([{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" }]);

		release();
		await first;
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("keeps failure cleanup scoped to the owning session", async () => {
		const runtime = new FixtureRuntime();
		runtime.compactImpl = async () => {
			throw new Error("synthetic native failure");
		};
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.beginExecution("session-other")).toBe(true);
		const registration = register(
			runtime,
			configuration(),
			new CodexCompactionStore(),
			coordinator,
		);
		const notifications: Array<{ message: string; type: string | undefined }> = [];

		expect(
			await registration.handlers.get("session_before_compact")?.[0]?.(
				compactEvent("manual"),
				context({ sessionId: "session-owner", notifications }),
			),
		).toEqual({ cancel: true });
		expect(coordinator.isBusy("session-owner")).toBe(false);
		expect(coordinator.isBusy("session-other")).toBe(true);
		expect(notifications).toEqual([{ message: COMPACTION_FAILURE_NOTIFICATION, type: "error" }]);
		coordinator.end("session-other", "cancel");
	});
});

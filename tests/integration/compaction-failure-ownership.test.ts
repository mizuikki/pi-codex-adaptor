import { describe, expect, test } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	AgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type {
	CodexRuntime,
	CompactResponseOptions,
	CompactResponseResult,
	CreateResponseResult,
	ExecuteToolOptions,
	SummarizeContextResult,
} from "../../src/application/codex-runtime.ts";
import {
	CodexCompactionCoordinator,
	CodexCompactionStore,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";

const FAILURE_NOTIFICATION =
	"OpenAI Codex compaction failed; the session context was left unchanged.";

const model: Model<string> = {
	id: "failure-fixture-model",
	name: "Failure fixture model",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://invalid.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

class RejectingRuntime implements CodexRuntime {
	compactCalls = 0;

	async createResponse(): Promise<CreateResponseResult> {
		return { status: "completed", result: {} };
	}

	async summarizeContext(): Promise<SummarizeContextResult> {
		throw new Error("synthetic provider failure");
	}

	async compact(_options: CompactResponseOptions): Promise<CompactResponseResult> {
		this.compactCalls += 1;
		throw new Error("synthetic provider failure");
	}

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
				"responses_sse",
				"portable_context_summary",
				"remote_compaction_v2",
				"compact_endpoint",
			],
		};
	}

	async resolveModel(modelId: string): Promise<unknown> {
		return {
			model: { slug: modelId },
			shellSurface: "shell-command",
			autoCompactTokenLimit: 90_000,
			provider: {
				name: "Codex",
				supportsWebsockets: false,
				supportsRemoteCompaction: true,
				namespaceTools: false,
				imageGeneration: false,
				hostedWebSearch: false,
			},
		};
	}

	async resolveTools(): Promise<unknown> {
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
	}

	async executeTool(_options: ExecuteToolOptions): Promise<CreateResponseResult> {
		throw new Error("synthetic tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

function configuration(): ConfigurationService {
	return { load: async () => createDefaultConfig() } as ConfigurationService;
}

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function healthyProfile(): CodexToolProfileCoordinator {
	return {
		readiness: { kind: "healthy", capabilityKey: "failure-fixture" },
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

function appendCompactionInput(session: SessionManager): void {
	for (let index = 0; index < 6; index += 1) {
		session.appendMessage({
			role: "user",
			content: `Synthetic request ${index} ${"input ".repeat(200)}`,
			timestamp: index * 2 + 1,
		} as never);
		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: `Synthetic response ${index} ${"output ".repeat(200)}` }],
			usage: {
				input: 1_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: index * 2 + 2,
		} as never);
	}
}

async function createHarness(
	withInteractiveUi: boolean,
	legacyThrow = false,
): Promise<{
	session: AgentSession;
	runtime: RejectingRuntime;
	store: CodexCompactionStore;
	coordinator: CodexCompactionCoordinator;
	notifications: Array<{ message: string; type: string | undefined }>;
	extensionErrors: string[];
	getFallbackCalls(): number;
}> {
	const runtime = new RejectingRuntime();
	const store = new CodexCompactionStore();
	const coordinator = new CodexCompactionCoordinator();
	const config = configuration();
	const activation = new ProviderActivationPolicy(config);
	const resourceLoader = new DefaultResourceLoader({
		cwd: "<synthetic-cwd>",
		agentDir: "<synthetic-agent-dir>",
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			async (pi) => {
				if (legacyThrow) {
					pi.on("session_before_compact", () => {
						throw new Error("synthetic extension compaction failure");
					});
					return;
				}
				registerCodexCompaction(
					pi,
					runtime,
					config,
					store,
					activation,
					coordinator,
					undefined,
					healthyProfile(),
				);
			},
		],
		systemPrompt: "Synthetic system prompt",
		appendSystemPrompt: [],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory("<synthetic-cwd>", {
		id: "integration-failure-session",
	});
	appendCompactionInput(sessionManager);
	let fallbackCalls = 0;
	const fallbackStream = (): AssistantMessageEventStream => {
		fallbackCalls += 1;
		const stream = createAssistantMessageEventStream();
		stream.end({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "Synthetic fallback summary" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		return stream;
	};
	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: "off",
			systemPrompt: "Synthetic system prompt",
			messages: sessionManager.buildSessionContext().messages,
			tools: [],
		},
		streamFn: fallbackStream,
		sessionId: sessionManager.getSessionId(),
	});
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { apiKey: token() });
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const extensionErrors: string[] = [];
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
		}),
		cwd: "<synthetic-cwd>",
		resourceLoader: resourceLoader as never,
		modelRuntime,
		baseToolsOverride: {},
	});
	await session.bindExtensions({
		...(withInteractiveUi
			? {
					uiContext: {
						notify: (message: string, type?: string) => notifications.push({ message, type }),
					} as never,
					mode: "tui" as const,
				}
			: {}),
		onError: (error) => extensionErrors.push(error.error),
	});
	return {
		session,
		runtime,
		store,
		coordinator,
		notifications,
		extensionErrors,
		getFallbackCalls: () => fallbackCalls,
	};
}

describe("public Pi compaction failure ownership", () => {
	test("characterizes Pi fallback after a swallowed extension failure", async () => {
		const harness = await createHarness(false, true);

		await expect(harness.session.compact()).resolves.toMatchObject({
			summary: expect.stringContaining("Synthetic fallback summary"),
		});

		expect(harness.runtime.compactCalls).toBe(0);
		expect(harness.getFallbackCalls()).toBeGreaterThan(0);
		expect(harness.session.sessionManager.getLeafEntry()).toMatchObject({
			type: "compaction",
			fromHook: false,
		});
		expect(harness.extensionErrors).toEqual(["synthetic extension compaction failure"]);
	});

	test("manual failure is terminal before Pi fallback or persistence", async () => {
		const harness = await createHarness(true);
		const entriesBefore = structuredClone(harness.session.sessionManager.getEntries());
		const leafBefore = harness.session.sessionManager.getLeafId();

		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(harness.runtime.compactCalls).toBe(1);
		expect(harness.getFallbackCalls()).toBe(0);
		expect(harness.session.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.store.getForSession("integration-failure-session")).toBeUndefined();
		expect(harness.coordinator.isBusy("integration-failure-session")).toBe(false);
		expect(harness.notifications).toEqual([{ message: FAILURE_NOTIFICATION, type: "error" }]);
		expect(harness.extensionErrors).toEqual([]);
		expect(JSON.stringify(harness.extensionErrors)).not.toContain(
			"Codex provider route is unavailable for the current Pi session",
		);
	});

	test("overflow failure is terminal with Pi's headless no-op UI", async () => {
		const harness = await createHarness(false);
		const entriesBefore = structuredClone(harness.session.sessionManager.getEntries());
		const leafBefore = harness.session.sessionManager.getLeafId();
		const events: unknown[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event));
		const runAutoCompaction = harness.session as unknown as {
			_runAutoCompaction(reason: "overflow", willRetry: boolean): Promise<boolean>;
		};

		try {
			expect(await runAutoCompaction._runAutoCompaction("overflow", true)).toBe(false);
		} finally {
			unsubscribe();
		}

		expect(harness.runtime.compactCalls).toBe(1);
		expect(harness.getFallbackCalls()).toBe(0);
		expect(harness.session.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.store.getForSession("integration-failure-session")).toBeUndefined();
		expect(harness.coordinator.isBusy("integration-failure-session")).toBe(false);
		expect(harness.notifications).toEqual([]);
		expect(harness.extensionErrors).toEqual([]);
		expect(JSON.stringify(events)).not.toContain(
			"Codex provider route is unavailable for the current Pi session",
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "compaction_end",
				reason: "overflow",
				aborted: true,
			}),
		);
	});
});

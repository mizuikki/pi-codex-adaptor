import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Context,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type {
	CodexRuntime,
	CompactResponseOptions,
	CompactResponseResult,
	CreateResponseOptions,
	CreateResponseResult,
	ExecuteToolOptions,
	SummarizeContextResult,
} from "../../src/application/codex-runtime.ts";
import {
	CodexCompactionCoordinator,
	CodexCompactionStore,
	createCodexCompactionDetails,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { ResolveEffectiveCapabilities } from "../../src/application/resolve-effective-capabilities.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";
import {
	createCodexStreamSimple,
	encodeResponseItemSignature,
} from "../../src/integration/pi/codex-provider.ts";
import { CodexProviderRequestGuard } from "../../src/integration/pi/codex-provider-request-guard.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";
import {
	type BeforeProviderPayloadEventResult,
	onProviderPayloadSessionCompact,
	type ProviderPayloadAttribution,
} from "../../src/integration/pi/provider-payload-compaction-api.ts";

const OPAQUE = "synthetic-opaque-content";
const providerPayloadControllerModule = new URL(
	"./core/provider-payload-compaction.js",
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const providerPayloadCompactionAvailable = existsSync(
	fileURLToPath(providerPayloadControllerModule),
);
const providerPayloadTest = providerPayloadCompactionAvailable ? test : test.skip;

interface ProviderPayloadCompactionController {
	createAttribution(
		model: Model<string>,
		origin: "agent",
		signal: AbortSignal,
	): ProviderPayloadAttribution;
	commitPayload(
		model: Model<string>,
		result: BeforeProviderPayloadEventResult,
		attribution: ProviderPayloadAttribution,
	): Promise<unknown>;
}

async function createProviderPayloadCompactionController(
	session: SessionManager,
	settings: SettingsManager,
	extensionRunnerRef: unknown,
): Promise<ProviderPayloadCompactionController> {
	const module = (await import(providerPayloadControllerModule.href)) as {
		ProviderPayloadCompactionController?: new (
			session: SessionManager,
			settings: SettingsManager,
			extensionRunnerRef: unknown,
		) => ProviderPayloadCompactionController;
	};
	if (module.ProviderPayloadCompactionController === undefined) {
		throw new Error("Pi host does not expose provider payload compaction");
	}
	return new module.ProviderPayloadCompactionController(session, settings, extensionRunnerRef);
}

const model: Model<string> = {
	id: "integration-fixture-model",
	name: "Integration fixture model",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://invalid.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "integration-account" },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function service(): ConfigurationService {
	return { load: async () => createDefaultConfig() } as ConfigurationService;
}

function healthyProfile(): CodexToolProfileCoordinator {
	return {
		readiness: { kind: "healthy", capabilityKey: "integration-fixture" },
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

class IntegrationRuntime implements CodexRuntime {
	compactCalls = 0;
	summaryCalls = 0;
	responseCalls = 0;
	compactRequests: unknown[] = [];
	responseRequests: unknown[] = [];
	compactContexts: CompactResponseOptions["remoteCompactionV2Context"][] = [];
	responseContexts: CreateResponseOptions["remoteCompactionV2Context"][] = [];
	onSummary: (() => void) | undefined;
	onCompact: (() => void) | undefined;
	onResponse: (() => void) | undefined;
	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.responseCalls += 1;
		this.responseRequests.push(structuredClone(options.request));
		this.responseContexts.push(structuredClone(options.remoteCompactionV2Context));
		this.onResponse?.();
		return { status: "completed", result: { responseId: "integration-response" } };
	}

	async summarizeContext(): Promise<SummarizeContextResult> {
		this.summaryCalls += 1;
		this.onSummary?.();
		return {
			status: "completed",
			result: { summary: "fixture portable summary" },
		};
	}

	async compact(options: CompactResponseOptions): Promise<CompactResponseResult> {
		this.compactCalls += 1;
		this.compactRequests.push(structuredClone(options.request));
		this.compactContexts.push(structuredClone(options.remoteCompactionV2Context));
		this.onCompact?.();
		return {
			status: "completed",
			result: {
				output: [{ type: "compaction", encrypted_content: OPAQUE }],
			},
		};
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
		throw new Error("integration fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

function appendInitialMessages(session: SessionManager): void {
	session.appendMessage({ role: "user", content: "integration prompt", timestamp: 1 } as never);
	session.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "toolCall",
				id: "integration-call",
				name: "fixture_tool",
				arguments: { value: "synthetic" },
			},
		],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	} as never);
	session.appendMessage({
		role: "toolResult",
		toolCallId: "integration-call",
		toolName: "fixture_tool",
		content: [{ type: "text", text: "integration output" }],
		isError: false,
		timestamp: 3,
	} as never);
	// Later turns provide a multi-entry retained tail so firstKeptEntryId differs from the leaf.
	session.appendMessage({
		role: "user",
		content: "continue after tool result",
		timestamp: 4,
	} as never);
	session.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "acknowledged continuation" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 5,
	} as never);
	session.appendMessage({
		role: "user",
		content: "one more retained turn",
		timestamp: 6,
	} as never);
}

function extensionContext(
	session: SessionManager,
	signal: AbortSignal,
	compacted: { value: number },
): ExtensionContext {
	return {
		model,
		signal,
		sessionManager: session,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token(), headers: {} }),
		},
		getContextUsage: () => ({ tokens: 95_001, contextWindow: 100_000, percent: 95 }),
		getSystemPrompt: () => "integration system",
		compact: () => {
			compacted.value += 1;
		},
	} as unknown as ExtensionContext;
}

async function runRealProviderDispatch(options: { legacy?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-real-dispatch-"));
	const session = SessionManager.inMemory(directory, { id: "real-dispatch-session" });
	appendInitialMessages(session);
	if (options.legacy === true) {
		const firstKeptEntryId = session.getEntries().find((entry) => entry.type === "message")?.id;
		if (firstKeptEntryId === undefined) throw new Error("legacy fixture has no message entry");
		session.appendCompaction(
			"legacy summary",
			firstKeptEntryId,
			1_000,
			createCodexCompactionDetails(model.id, [
				{ type: "compaction", encrypted_content: "legacy-opaque" },
			]),
			true,
		);
	}
	session.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "high-context response" }],
		usage: {
			input: options.legacy === true ? 1 : 95_001,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: options.legacy === true ? 2 : 95_002,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 8,
	} as never);
	session.appendMessage({
		role: "user",
		content: "retained high-context suffix",
		timestamp: 9,
	} as never);
	const runtime = new IntegrationRuntime();
	const config = service();
	const activation = new ProviderActivationPolicy(config);
	const store = new CodexCompactionStore();
	const guard = new CodexProviderRequestGuard();
	const capabilities = new ResolveEffectiveCapabilities(runtime);
	const coordinator = new CodexCompactionCoordinator();
	const registration = fauxProvider({
		api: model.api,
		provider: model.provider,
		models: [model],
	});
	const provider = {
		...registration.provider,
		auth: {
			apiKey: {
				name: "Integration fixture",
				check: async ({ credential }: { credential?: { key?: string } }) =>
					credential?.key ? { type: "api_key" as const, source: "fixture" } : undefined,
				resolve: async ({ credential }: { credential?: { key?: string } }) =>
					credential?.key === undefined
						? undefined
						: { auth: { apiKey: credential.key }, source: "fixture" },
			},
		},
		stream: createCodexStreamSimple(
			runtime,
			config,
			activation,
			store,
			capabilities,
			healthyProfile(),
			guard,
		),
		streamSimple: createCodexStreamSimple(
			runtime,
			config,
			activation,
			store,
			capabilities,
			healthyProfile(),
			guard,
		),
	};
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: token() }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(provider);
	const settings = SettingsManager.inMemory({
		// Keep Pi's legacy pre-turn compaction disabled; the adaptor owns this inline transaction.
		compaction: { enabled: false, keepRecentTokens: 20 },
	});
	const compactEvents: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager: settings,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				registerCodexCompaction(
					pi,
					runtime,
					config,
					store,
					activation,
					coordinator,
					capabilities,
					healthyProfile(),
					guard,
				);
				onProviderPayloadSessionCompact(pi, (event) => {
					compactEvents.push(event.trigger);
				});
			},
		],
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime,
		model,
		noTools: "all",
		resourceLoader: loader,
		sessionManager: session,
		settingsManager: settings,
	});
	try {
		await created.session.prompt("dispatch the current request");
		return { runtime, session, store, compactEvents };
	} finally {
		created.session.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

async function runIntegration(
	options: {
		failAppend?: boolean;
		aborted?: boolean;
		abortDuringSummary?: boolean;
		abortDuringCompact?: boolean;
		abortBeforeCommit?: boolean;
		abortAfterAppend?: boolean;
		abortDuringResponse?: boolean;
	} = {},
) {
	const session = SessionManager.inMemory("<synthetic-cwd>", { id: "integration-session" });
	appendInitialMessages(session);
	const runtime = new IntegrationRuntime();
	const config = service();
	const activation = new ProviderActivationPolicy(config);
	const store = new CodexCompactionStore();
	const guard = new CodexProviderRequestGuard();
	const capabilities = new ResolveEffectiveCapabilities(runtime);
	const coordinator = new CodexCompactionCoordinator();
	const compacted = { value: 0 };
	const controller = new AbortController();
	if (options.aborted === true) controller.abort();
	if (options.abortDuringSummary === true) runtime.onSummary = () => controller.abort();
	if (options.abortDuringCompact === true) runtime.onCompact = () => controller.abort();
	if (options.abortDuringResponse === true) runtime.onResponse = () => controller.abort();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as never;
	registerCodexCompaction(
		pi,
		runtime,
		config,
		store,
		activation,
		coordinator,
		capabilities,
		healthyProfile(),
		guard,
	);
	const ctx = extensionContext(session, controller.signal, compacted);
	const messages = [
		...session.buildSessionContext().messages,
		{
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "text",
					text: "",
					textSignature: encodeResponseItemSignature({
						type: "custom_tool_call_output",
						call_id: "integration-call",
						output: { marker: "live" },
					}),
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 4,
		},
	] as never;
	const streamSimple = createCodexStreamSimple(
		runtime,
		config,
		activation,
		store,
		capabilities,
		healthyProfile(),
		guard,
	);
	const compactEvents: Array<{ trigger?: string; fromExtension?: boolean }> = [];
	const emitCompactionTransactionEvent = async (event: {
		type: string;
		trigger?: string;
		fromExtension?: boolean;
		compactionEntry?: unknown;
	}) => {
		if (event.type === "session_compact") {
			const compactEvent: { trigger?: string; fromExtension?: boolean } = {};
			if (event.trigger !== undefined) compactEvent.trigger = event.trigger;
			if (event.fromExtension !== undefined) compactEvent.fromExtension = event.fromExtension;
			compactEvents.push(compactEvent);
			for (const handler of handlers.get("session_compact") ?? []) {
				await handler(event, ctx);
			}
		} else if (event.type === "session_compact_indeterminate") {
			for (const handler of handlers.get("session_compact_indeterminate") ?? []) {
				await handler(event, ctx);
			}
		}
	};
	const extensionRunnerRef = {
		current: {
			emitCompactionTransactionEvent,
		},
	};
	const settingsManager = SettingsManager.inMemory({
		// Keep enough recent tokens for multiple retained messages while still leaving a prefix.
		compaction: { keepRecentTokens: 20 },
	});
	const payloadController = await createProviderPayloadCompactionController(
		session,
		settingsManager,
		extensionRunnerRef as never,
	);
	const stream = streamSimple(
		model,
		{ systemPrompt: "integration system", messages, tools: [] } as unknown as Context,
		{
			apiKey: token(),
			sessionId: session.getSessionId(),
			signal: controller.signal,
			onPayload: async (payload) => {
				const hook = handlers.get("before_provider_payload")?.[0];
				if (hook === undefined) throw new Error("integration hook missing");
				const attribution = payloadController.createAttribution(model, "agent", controller.signal);
				const result = (await hook(
					{ type: "before_provider_payload", model, payload, attribution },
					ctx,
				)) as BeforeProviderPayloadEventResult;
				if (result.compaction !== undefined) {
					if (options.abortBeforeCommit === true) {
						controller.abort();
						throw new Error("synthetic commit boundary failure");
					}
					if (options.failAppend === true) {
						const originalGetEntry = session.getEntry.bind(session);
						session.getEntry = (() => undefined) as typeof session.getEntry;
						try {
							await payloadController.commitPayload(model, result, attribution);
						} finally {
							session.getEntry = originalGetEntry;
						}
					}
					if (options.abortAfterAppend === true) {
						await payloadController.commitPayload(model, result, attribution);
						controller.abort();
						await emitCompactionTransactionEvent({
							type: "session_compact_indeterminate",
							trigger: "provider_inline",
						});
						throw new Error("synthetic append boundary failure");
					}
					await payloadController.commitPayload(model, result, attribution);
				}
				return result.payload;
			},
		},
	);
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return { events, runtime, session, store, compacted, compactEvents };
}

describe("public Pi automatic compaction continuation harness", () => {
	providerPayloadTest("uses the real coding-agent provider dispatch transaction", async () => {
		const result = await runRealProviderDispatch();
		expect(result.runtime.summaryCalls).toBe(1);
		expect(result.runtime.compactCalls).toBe(1);
		expect(result.runtime.responseCalls).toBe(1);
		expect(result.compactEvents).toEqual(["provider_inline"]);
		const checkpoint = result.session.getLeafEntry();
		expect(checkpoint).toMatchObject({ type: "message" });
		const compactEntry = result.session.getBranch().find((entry) => entry.type === "compaction");
		expect(compactEntry).toMatchObject({ type: "compaction" });
		if (compactEntry?.type !== "compaction") throw new Error("checkpoint was not appended");
		expect(compactEntry.firstKeptEntryId).not.toBe(compactEntry.parentId);
		expect(
			(compactEntry as typeof compactEntry & { readonly retainedTail?: readonly unknown[] })
				.retainedTail?.length,
		).toBeGreaterThan(0);
		expect((result.runtime.responseRequests[0] as { input: unknown[] }).input[0]).toEqual({
			type: "compaction",
			encrypted_content: OPAQUE,
		});
		expect(result.store.isReplayInvalid(result.session.getSessionId())).toBe(false);
	});

	providerPayloadTest(
		"migrates a legacy boundary through the real coding-agent provider dispatch",
		async () => {
			const result = await runRealProviderDispatch({ legacy: true });
			expect(result.runtime.summaryCalls).toBe(1);
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(1);
			expect(result.compactEvents).toEqual(["provider_inline"]);
			expect(
				result.session.getEntries().filter((entry) => entry.type === "compaction"),
			).toHaveLength(2);
			expect(result.store.isReplayInvalid(result.session.getSessionId())).toBe(false);
		},
	);

	providerPayloadTest(
		"rewrites a provider payload inline and lets the existing run finish",
		async () => {
			const result = await runIntegration();
			expect(result.events.at(-1)).toMatchObject({ type: "done" });
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(1);
			expect(result.compacted.value).toBe(0);
			expect(result.compactEvents).toEqual([{ trigger: "provider_inline", fromExtension: true }]);
			const checkpoint = result.session.getLeafEntry();
			expect(checkpoint).toMatchObject({
				type: "compaction",
			});
			if (checkpoint?.type !== "compaction") throw new Error("checkpoint was not appended");
			expect(checkpoint.parentId).not.toBeNull();
			expect(result.session.getEntry(checkpoint.parentId ?? "")).toBeDefined();
			expect(checkpoint.firstKeptEntryId).not.toBe(checkpoint.parentId);
			expect(
				(checkpoint as typeof checkpoint & { readonly retainedTail?: readonly unknown[] })
					.retainedTail?.length,
			).toBeGreaterThan(0);
			expect((result.runtime.responseRequests[0] as { input: unknown[] }).input[0]).toEqual({
				type: "compaction",
				encrypted_content: OPAQUE,
			});
			expect((result.runtime.responseRequests[0] as { input: unknown[] }).input.at(-1)).toEqual({
				type: "custom_tool_call_output",
				call_id: "integration-call",
				output: { marker: "live" },
			});
			expect(result.runtime.compactContexts).toEqual([undefined]);
			expect(result.runtime.responseContexts).toEqual([{ sessionId: "integration-session" }]);
		},
	);

	providerPayloadTest(
		"shows the public append failure boundary and poisons the extension instance",
		async () => {
			const result = await runIntegration({ failAppend: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.responseCalls).toBe(0);
			expect(result.store.isReplayInvalid(result.session.getSessionId())).toBe(true);
			expect(result.session.getLeafEntry()).toMatchObject({ type: "compaction" });
		},
	);

	providerPayloadTest(
		"does not invoke compact after the current Pi signal is already aborted",
		async () => {
			const result = await runIntegration({ aborted: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.summaryCalls).toBe(0);
			expect(result.runtime.compactCalls).toBe(0);
			expect(result.runtime.responseCalls).toBe(0);
		},
	);

	providerPayloadTest(
		"does not append, compact, or dispatch after cancellation wins during portable summary",
		async () => {
			const result = await runIntegration({ abortDuringSummary: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.summaryCalls).toBe(1);
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(0);
			expect(result.session.getLeafEntry()?.type).toBe("message");
		},
	);

	providerPayloadTest(
		"does not append or dispatch after cancellation wins after proposal and before commit",
		async () => {
			const result = await runIntegration({ abortBeforeCommit: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.summaryCalls).toBe(1);
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(0);
			expect(result.session.getLeafEntry()?.type).toBe("message");
		},
	);

	providerPayloadTest(
		"does not append or send Responses after compact invocation observes cancellation",
		async () => {
			const result = await runIntegration({ abortDuringCompact: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(0);
			expect(result.session.getLeafEntry()?.type).toBe("message");
		},
	);

	providerPayloadTest(
		"keeps append cancellation distinct from pre-append cancellation",
		async () => {
			const result = await runIntegration({ abortAfterAppend: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(0);
			expect(result.session.getLeafEntry()).toMatchObject({ type: "compaction" });
			expect(result.store.isReplayInvalid(result.session.getSessionId())).toBe(true);
		},
	);

	providerPayloadTest(
		"does not turn a post-Responses local abort into a successful stream",
		async () => {
			const result = await runIntegration({ abortDuringResponse: true });
			expect(result.events.at(-1)).toMatchObject({ type: "error" });
			expect(result.runtime.compactCalls).toBe(1);
			expect(result.runtime.responseCalls).toBe(1);
		},
	);

	test("records the public append failure boundary for a file-backed session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-session-"));
		try {
			const session = SessionManager.create("<synthetic-cwd>", directory, {
				id: "integration-file-session",
			});
			session.appendMessage({
				role: "user",
				content: "synthetic persistence probe",
				timestamp: 1,
			} as never);
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "synthetic response" }],
				timestamp: 2,
			} as never);
			const checkpointParentId = session.getLeafId();
			if (checkpointParentId === null) throw new Error("assistant parent was not appended");
			const appendEntry = () => {
				session.appendCompaction(
					"Synthetic persistence boundary",
					checkpointParentId,
					95_001,
					{
						kind: "pi-codex-adaptor.compaction",
						version: 3,
						portable: { summarySha256: "0".repeat(64) },
					},
					true,
				);
				throw new Error("synthetic append boundary failure");
			};

			expect(appendEntry).toThrow("synthetic append boundary failure");
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeString();
			if (sessionFile === undefined) throw new Error("session file was not created");
			expect(await readFile(sessionFile, "utf8")).toContain("Synthetic persistence boundary");
			expect(session.getLeafEntry()).toMatchObject({
				type: "compaction",
				parentId: checkpointParentId,
			});
			const reloaded = SessionManager.open(sessionFile);
			expect(reloaded.getLeafEntry()).toMatchObject({
				type: "compaction",
				parentId: checkpointParentId,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

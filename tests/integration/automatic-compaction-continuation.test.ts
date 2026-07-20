import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

import type {
	CodexRuntime,
	CompactResponseOptions,
	CreateResponseOptions,
	CreateResponseResult,
	ExecuteToolOptions,
} from "../../src/application/codex-runtime.ts";
import {
	CodexCompactionCoordinator,
	CodexCompactionStore,
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

const OPAQUE = "synthetic-opaque-content";

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
	responseCalls = 0;
	compactRequests: unknown[] = [];
	responseRequests: unknown[] = [];
	onCompact: (() => void) | undefined;
	onResponse: (() => void) | undefined;
	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.responseCalls += 1;
		this.responseRequests.push(structuredClone(options.request));
		this.onResponse?.();
		return { status: "completed", result: { responseId: "integration-response" } };
	}

	async compact(options: CompactResponseOptions): Promise<CreateResponseResult> {
		this.compactCalls += 1;
		this.compactRequests.push(structuredClone(options.request));
		this.onCompact?.();
		return {
			status: "completed",
			result: {
				output: [{ type: "compaction", encrypted_content: OPAQUE }],
			},
		};
	}

	async readDiagnostics(): Promise<unknown> {
		return { capabilities: ["responses_sse", "remote_compaction_v2", "compact_endpoint"] };
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

async function runIntegration(
	options: {
		failAppend?: boolean;
		aborted?: boolean;
		abortDuringCompact?: boolean;
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
	if (options.abortDuringCompact === true) runtime.onCompact = () => controller.abort();
	if (options.abortDuringResponse === true) runtime.onResponse = () => controller.abort();
	let hook:
		| ((
				event: { type: "before_provider_request"; payload: unknown },
				ctx: ExtensionContext,
		  ) => unknown)
		| undefined;
	const pi = {
		on: (event: string, handler: typeof hook) => {
			if (event === "before_provider_request") hook = handler;
		},
		appendEntry: (customType: string, data: unknown) => {
			session.appendCustomEntry(customType, data);
			if (options.abortAfterAppend === true) controller.abort();
			if (options.failAppend === true) throw new Error("synthetic persistence failure");
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
	const stream = streamSimple(
		model,
		{ systemPrompt: "integration system", messages, tools: [] } as unknown as Context,
		{
			apiKey: token(),
			sessionId: session.getSessionId(),
			signal: controller.signal,
			onPayload: async (payload) => {
				if (hook === undefined) throw new Error("integration hook missing");
				return hook({ type: "before_provider_request", payload }, ctx);
			},
		},
	);
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return { events, runtime, session, store, compacted };
}

describe("public Pi automatic compaction continuation harness", () => {
	test("rewrites a provider payload inline and lets the existing run finish", async () => {
		const result = await runIntegration();
		expect(result.events.at(-1)).toMatchObject({ type: "done" });
		expect(result.runtime.compactCalls).toBe(1);
		expect(result.runtime.responseCalls).toBe(1);
		expect(result.compacted.value).toBe(0);
		const checkpoint = result.session.getLeafEntry();
		expect(checkpoint).toMatchObject({
			type: "custom",
			customType: "pi-codex-adaptor.auto-compaction",
		});
		if (checkpoint?.type !== "custom") throw new Error("checkpoint was not appended");
		expect(checkpoint.parentId).not.toBeNull();
		expect(result.session.getEntry(checkpoint.parentId ?? "")).toBeDefined();
		expect((result.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{ type: "compaction", encrypted_content: OPAQUE },
			{ type: "custom_tool_call_output", call_id: "integration-call", output: { marker: "live" } },
		]);
	});

	test("shows the public append failure boundary and poisons the extension instance", async () => {
		const result = await runIntegration({ failAppend: true });
		expect(result.events.at(-1)).toMatchObject({ type: "error" });
		expect(result.runtime.responseCalls).toBe(0);
		expect(result.store.isReplayInvalid(result.session.getSessionId())).toBe(true);
		expect(result.session.getLeafEntry()).toMatchObject({ type: "custom" });
	});

	test("does not invoke compact after the current Pi signal is already aborted", async () => {
		const result = await runIntegration({ aborted: true });
		expect(result.events.at(-1)).toMatchObject({ type: "error" });
		expect(result.runtime.compactCalls).toBe(0);
		expect(result.runtime.responseCalls).toBe(0);
	});

	test("does not append or send Responses after compact invocation observes cancellation", async () => {
		const result = await runIntegration({ abortDuringCompact: true });
		expect(result.events.at(-1)).toMatchObject({ type: "error" });
		expect(result.runtime.compactCalls).toBe(1);
		expect(result.runtime.responseCalls).toBe(0);
		expect(result.session.getLeafEntry()?.type).toBe("message");
	});

	test("keeps append cancellation distinct from pre-append cancellation", async () => {
		const result = await runIntegration({ abortAfterAppend: true });
		expect(result.events.at(-1)).toMatchObject({ type: "error" });
		expect(result.runtime.compactCalls).toBe(1);
		expect(result.runtime.responseCalls).toBe(0);
		expect(result.session.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "pi-codex-adaptor.auto-compaction",
		});
		expect(result.store.isReplayInvalid(result.session.getSessionId())).toBe(true);
	});

	test("does not turn a post-Responses local abort into a successful stream", async () => {
		const result = await runIntegration({ abortDuringResponse: true });
		expect(result.events.at(-1)).toMatchObject({ type: "error" });
		expect(result.runtime.compactCalls).toBe(1);
		expect(result.runtime.responseCalls).toBe(1);
	});

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
				session.appendCustomEntry("pi-codex-adaptor.auto-compaction", {
					checkpointId: "synthetic-checkpoint",
					coveredEntryId: checkpointParentId,
				});
				throw new Error("synthetic append boundary failure");
			};

			expect(appendEntry).toThrow("synthetic append boundary failure");
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeString();
			if (sessionFile === undefined) throw new Error("session file was not created");
			expect(await readFile(sessionFile, "utf8")).toContain("synthetic-checkpoint");
			expect(session.getLeafEntry()).toMatchObject({
				type: "custom",
				parentId: checkpointParentId,
				customType: "pi-codex-adaptor.auto-compaction",
			});
			const reloaded = SessionManager.open(sessionFile);
			expect(reloaded.getLeafEntry()).toMatchObject({
				type: "custom",
				parentId: checkpointParentId,
				customType: "pi-codex-adaptor.auto-compaction",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

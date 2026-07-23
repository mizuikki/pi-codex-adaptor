import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { CodexCompactionStore } from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "../../src/integration/pi/codex-message-normalization.ts";
import {
	createCodexStreamSimple,
	encodeResponseItemSignature,
} from "../../src/integration/pi/codex-provider.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";

import {
	firstPostedResponsesRequest,
	fixtureModelSpec,
	startFakeResponsesServer,
} from "./helpers/fake-responses-server.ts";
import { createIntegrationRuntime } from "./helpers/native-bridge.ts";

const CALL_ID = "synthetic-interrupted-call";
const TOOL_NAME = "synthetic_tool";

function configuration(): ConfigurationService {
	return { load: async () => createDefaultConfig() } as ConfigurationService;
}

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function healthyProfile(): CodexToolProfileCoordinator {
	return {
		readiness: { kind: "healthy", capabilityKey: "interruption-integration" },
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

function appendInterruptedHistory(session: SessionManager, model: Model<string>): void {
	session.appendMessage({ role: "user", content: "synthetic initial request", timestamp: 1 });
	session.appendMessage({
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{
				type: "toolCall",
				id: CALL_ID,
				name: TOOL_NAME,
				arguments: { value: "synthetic" },
				thoughtSignature: encodeResponseItemSignature({
					type: "function_call",
					call_id: CALL_ID,
					name: TOOL_NAME,
					arguments: '{"value":"synthetic"}',
				}),
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
	});
}

describe("file-backed interrupted tool-call continuation", () => {
	test("recovers through Pi's public AgentSession and registered provider without mutating history", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-codex-interruption-"));
		const server = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "interruption-fixture-model", shellType: "shell_command" }),
		]);
		const { runtime } = await createIntegrationRuntime();
		let agentSession: AgentSession | undefined;
		try {
			const model: Model<string> = {
				id: "interruption-fixture-model",
				name: "Interruption fixture model",
				provider: "openai-codex",
				api: "openai-codex-responses",
				baseUrl: server.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 10_000,
			};
			const persisted = SessionManager.create("<synthetic-cwd>", directory, {
				id: "synthetic-interrupted-session",
			});
			appendInterruptedHistory(persisted, model);
			const sessionFile = persisted.getSessionFile();
			if (sessionFile === undefined) throw new Error("synthetic session file was not created");
			const bytesBeforeResume = await readFile(sessionFile, "utf8");
			const reloaded = SessionManager.open(sessionFile, directory, "<synthetic-cwd>");

			const service = configuration();
			const activation = new ProviderActivationPolicy(service);
			const streamSimple = createCodexStreamSimple(
				runtime,
				service,
				activation,
				new CodexCompactionStore(),
				undefined,
				healthyProfile(),
			);
			const resourceLoader = new DefaultResourceLoader({
				cwd: "<synthetic-cwd>",
				agentDir: "<synthetic-agent-dir>",
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					async (pi) => {
						pi.registerProvider(model.provider, { api: model.api, streamSimple });
					},
				],
				systemPrompt: "Synthetic system prompt",
				appendSystemPrompt: [],
			});
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({
				modelsPath: null,
				allowModelNetwork: false,
			});
			modelRuntime.registerProvider(model.provider, { apiKey: token() });
			const agent = new Agent({
				initialState: {
					model,
					thinkingLevel: "off",
					systemPrompt: "Synthetic system prompt",
					messages: reloaded.buildSessionContext().messages,
					tools: [],
				},
				convertToLlm,
				streamFn: (selectedModel, context, options) =>
					modelRuntime.streamSimple(selectedModel, context, options),
				sessionId: reloaded.getSessionId(),
			});
			agentSession = new AgentSession({
				agent,
				sessionManager: reloaded,
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
				cwd: "<synthetic-cwd>",
				resourceLoader: resourceLoader as never,
				modelRuntime,
				baseToolsOverride: {},
			});
			await agentSession.bindExtensions({ mode: "print" });
			expect(modelRuntime.getRegisteredProviderConfig(model.provider)?.streamSimple).toBeDefined();

			await agentSession.prompt("synthetic resumed request");

			const posted = firstPostedResponsesRequest(server.requests);
			const request = JSON.parse(posted.body) as { input?: unknown[] };
			const input = request.input ?? [];
			const callIndex = input.findIndex(
				(item) =>
					(item as { type?: unknown; call_id?: unknown }).type === "function_call" &&
					(item as { call_id?: unknown }).call_id === CALL_ID,
			);
			const outputIndex = input.findIndex(
				(item) =>
					(item as { type?: unknown; call_id?: unknown; output?: unknown }).type ===
						"function_call_output" &&
					(item as { call_id?: unknown }).call_id === CALL_ID &&
					(item as { output?: unknown }).output === INTERRUPTED_TOOL_RESULT_TEXT,
			);
			const resumedUserIndex = input.findIndex(
				(item) =>
					JSON.stringify(item).includes("synthetic resumed request") &&
					(item as { role?: unknown }).role === "user",
			);
			expect(callIndex).toBeGreaterThanOrEqual(0);
			expect(outputIndex).toBe(callIndex + 1);
			expect(resumedUserIndex).toBe(outputIndex + 1);

			const bytesAfterResume = await readFile(sessionFile, "utf8");
			expect(bytesAfterResume.startsWith(bytesBeforeResume)).toBe(true);
			expect(bytesAfterResume).not.toContain(INTERRUPTED_TOOL_RESULT_TEXT);
			const persistedRoles = reloaded
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message.role);
			expect(persistedRoles).toEqual(["user", "assistant", "user", "assistant"]);
			expect(persistedRoles).not.toContain("toolResult");
		} finally {
			agentSession?.dispose();
			await runtime.shutdown();
			server.stop();
			await rm(directory, { recursive: true, force: true });
		}
	}, 60_000);
});

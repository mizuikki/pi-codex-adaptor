import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
	CodexCompactionCoordinator,
	CodexCompactionStore,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";
import { createCodexStreamSimple } from "../../src/integration/pi/codex-provider.ts";
import { CodexProviderRequestGuard } from "../../src/integration/pi/codex-provider-request-guard.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";

import { fixtureModelSpec, startFakeResponsesServer } from "./helpers/fake-responses-server.ts";
import { createIntegrationRuntime } from "./helpers/native-bridge.ts";

const SESSION_ID = "synthetic-overflow-recovery";

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
		readiness: { kind: "healthy", capabilityKey: "overflow-integration" },
		skillLoader: undefined,
		registeredManagedTools: () => [],
		enterPending: () => {},
		installHealthy: () => true,
		installUnavailable: () => {},
		revalidateHealthyOwnership: () => true,
		isHealthy: () => true,
		restorePi: () => {},
		dispose: () => {},
	};
}

function seedHistory(session: SessionManager, model: Model<string>): void {
	for (let index = 0; index < 4; index += 1) {
		session.appendMessage({
			role: "user",
			content: `synthetic history request ${index}`,
			timestamp: index * 2 + 1,
		});
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: `synthetic history response ${index}` }],
			usage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 25,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: index * 2 + 2,
		};
		session.appendMessage(message);
	}
}

function contextErrorResponse(): Response {
	return Response.json({
		error: {
			code: "context_length_exceeded",
			message: "Your input exceeds the context window of this model.",
		},
	});
}

async function createScenario(options: {
	readonly failEveryResponse: boolean;
	readonly responseGate?: Promise<void>;
}) {
	const server = await startFakeResponsesServer(
		[fixtureModelSpec({ slug: "overflow-fixture-model", shellType: "shell_command" })],
		{
			responsesResponse: async (_request, responseIndex) => {
				if (options.responseGate !== undefined) await options.responseGate;
				return options.failEveryResponse || responseIndex === 0
					? contextErrorResponse()
					: undefined;
			},
		},
	);
	const { runtime } = await createIntegrationRuntime();
	const model: Model<string> = {
		id: "overflow-fixture-model",
		name: "Overflow fixture model",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: server.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
	const sessionManager = SessionManager.inMemory("<synthetic-cwd>", { id: SESSION_ID });
	seedHistory(sessionManager, model);
	const service = configuration();
	const activation = new ProviderActivationPolicy(service);
	const compactions = new CodexCompactionStore();
	const coordinator = new CodexCompactionCoordinator();
	const requestGuard = new CodexProviderRequestGuard();
	const profile = healthyProfile();
	const snapshot = {
		modelTools: [],
		providerSupportsWebsockets: false,
		compaction: { implementation: "compact_endpoint", threshold: 95_000 },
		shell: { sessionSurface: "official" },
	};
	const capabilities = { resolve: async () => snapshot } as never;
	const streamSimple = createCodexStreamSimple(
		runtime,
		service,
		activation,
		compactions,
		capabilities,
		profile,
		requestGuard,
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
				registerCodexCompaction(
					pi,
					runtime,
					service,
					compactions,
					activation,
					coordinator,
					capabilities,
					profile,
					requestGuard,
				);
				pi.registerProvider(model.provider, { api: model.api, streamSimple });
			},
		],
		systemPrompt: "Synthetic system prompt",
		appendSystemPrompt: [],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(model.provider, { apiKey: token() });
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		retry: { enabled: false },
	});
	const { session: agentSession } = await createAgentSession({
		sessionManager,
		settingsManager,
		cwd: "<synthetic-cwd>",
		agentDir: "<synthetic-agent-dir>",
		resourceLoader,
		modelRuntime,
		model,
		thinkingLevel: "off",
		noTools: "all",
	});
	await agentSession.bindExtensions({ mode: "print" });
	return {
		agentSession,
		server,
		sessionManager,
		async dispose() {
			agentSession.dispose();
			activation.dispose();
			requestGuard.dispose();
			await runtime.shutdown();
			server.stop();
		},
	};
}

function requestCounts(requests: readonly { method: string; path: string }[]) {
	return {
		responses: requests.filter(
			(request) => request.method === "POST" && request.path.endsWith("/responses"),
		).length,
		compactions: requests.filter(
			(request) => request.method === "POST" && request.path.endsWith("/responses/compact"),
		).length,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for provider request");
		await Bun.sleep(5);
	}
}

function createResponseGate(): { readonly wait: Promise<void>; release(): void } {
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

describe("provider overflow recovery", () => {
	test("commits one provider checkpoint and retries one fake-200 overflow", async () => {
		const scenario = await createScenario({ failEveryResponse: false });
		try {
			await scenario.agentSession.prompt("synthetic overflow request");
			expect(requestCounts(scenario.server.requests)).toEqual({ responses: 2, compactions: 1 });
			expect(
				scenario.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom" && entry.customType === "pi-codex-adaptor.remote-compaction",
					),
			).toHaveLength(1);
		} finally {
			await scenario.dispose();
		}
	}, 60_000);

	test("terminates after the retry also overflows", async () => {
		const scenario = await createScenario({ failEveryResponse: true });
		try {
			await scenario.agentSession.prompt("synthetic repeated overflow request");
			expect(requestCounts(scenario.server.requests)).toEqual({ responses: 2, compactions: 1 });
		} finally {
			await scenario.dispose();
		}
	}, 60_000);

	test("cancellation does not start overflow recovery", async () => {
		const gate = createResponseGate();
		const scenario = await createScenario({ failEveryResponse: true, responseGate: gate.wait });
		try {
			const prompt = scenario.agentSession.prompt("synthetic cancelled overflow request");
			await waitFor(() => requestCounts(scenario.server.requests).responses === 1);
			await scenario.agentSession.abort();
			gate.release();
			await prompt;
			expect(requestCounts(scenario.server.requests)).toEqual({ responses: 1, compactions: 0 });
		} finally {
			gate.release();
			await scenario.dispose();
		}
	}, 60_000);
});

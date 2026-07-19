import { afterEach, describe, expect, test } from "bun:test";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	getApiProvider,
	registerApiProvider,
	streamSimple as registryStreamSimple,
	resetApiProviders,
	streamSimpleOpenAICodexResponses,
	streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai/compat";

import type {
	CodexRuntime,
	CreateResponseOptions,
	CreateResponseResult,
} from "../../src/application/codex-runtime.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import {
	createCodexProviderDispatchers,
	piNativeOpenAiCodexResponsesStreamSimple,
	piNativeOpenAiResponsesStreamSimple,
} from "../../src/integration/pi/provider-dispatcher.ts";

afterEach(() => {
	resetApiProviders();
});

function model(provider: string, api: string): Model<string> {
	return {
		id: "fixture-model",
		name: "fixture-model",
		provider,
		api,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	} as Model<string>;
}

function configuration(initial: CodexConfig = createDefaultConfig()): {
	service: ConfigurationService;
	publish(config: CodexConfig): void;
} {
	let current = initial;
	const listeners = new Set<(config: CodexConfig) => void>();
	const service = {
		load: async () => current,
		onChange: (listener: (config: CodexConfig) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as ConfigurationService;
	return {
		service,
		publish(config) {
			current = config;
			for (const listener of listeners) listener(config);
		},
	};
}

class InactiveOnlyRuntime implements CodexRuntime {
	createResponseCalls = 0;

	async createResponse(_options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.createResponseCalls += 1;
		throw new Error("fixture runtime must not serve inactive fallback");
	}

	async compact(): Promise<CreateResponseResult> {
		throw new Error("fixture compaction is not configured");
	}

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
				"responses_sse",
				"responses_websocket",
				"remote_compaction_v2",
				"compact_endpoint",
				"unified_exec",
				"shell_command",
				"apply_patch",
				"view_image",
				"image_generation",
				"hosted_web_search",
			],
		};
	}

	async resolveModel(): Promise<unknown> {
		throw new Error("fixture model resolution is not configured");
	}

	async resolveTools(): Promise<unknown> {
		throw new Error("fixture tool resolution is not configured");
	}

	async executeTool(): Promise<CreateResponseResult> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

class ActiveRuntime implements CodexRuntime {
	createResponseCalls = 0;
	lastConnectionProviderId: string | undefined;

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.createResponseCalls += 1;
		this.lastConnectionProviderId = options.connection.providerId;
		await options.onEvent({ type: "response.output_text.delta", delta: "active" });
		return {
			status: "completed",
			result: {
				responseId: "response-active",
				tokenUsage: {
					input_tokens: 1,
					cached_input_tokens: 0,
					output_tokens: 1,
					reasoning_output_tokens: 0,
					total_tokens: 2,
				},
			},
		};
	}

	async compact(): Promise<CreateResponseResult> {
		throw new Error("fixture compaction is not configured");
	}

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
				"responses_sse",
				"responses_websocket",
				"remote_compaction_v2",
				"compact_endpoint",
				"unified_exec",
				"shell_command",
				"apply_patch",
				"view_image",
				"image_generation",
				"hosted_web_search",
			],
		};
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
			imageGenerationSurface: "standalone",
			capabilities: {
				sessions: { status: "available", source: "official" },
				applyPatch: { status: "available", source: "official" },
				viewImage: { status: "available", source: "official" },
				imageGeneration: { status: "available", source: "provider-contract" },
				webSearch: { status: "available", source: "provider-contract" },
			},
		};
	}

	async executeTool(): Promise<CreateResponseResult> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

function registerPoisonRegistry(
	openAi: (
		modelValue: Model<string>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream,
	codex: (
		modelValue: Model<string>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream,
	sourceId: string,
): void {
	registerApiProvider(
		{
			api: "openai-responses",
			stream: openAi,
			streamSimple: openAi,
		},
		sourceId,
	);
	registerApiProvider(
		{
			api: "openai-codex-responses",
			stream: codex,
			streamSimple: codex,
		},
		sourceId,
	);
}

describe("provider dispatcher native fallbacks", () => {
	test("wires distinct Pi-native fallbacks that never consult the API registry", () => {
		expect(piNativeOpenAiResponsesStreamSimple).toBe(
			streamSimpleOpenAIResponses as typeof piNativeOpenAiResponsesStreamSimple,
		);
		expect(piNativeOpenAiCodexResponsesStreamSimple).toBe(
			streamSimpleOpenAICodexResponses as typeof piNativeOpenAiCodexResponsesStreamSimple,
		);
		expect(piNativeOpenAiResponsesStreamSimple).not.toBe(piNativeOpenAiCodexResponsesStreamSimple);
		expect(piNativeOpenAiResponsesStreamSimple).not.toBe(
			registryStreamSimple as typeof piNativeOpenAiResponsesStreamSimple,
		);
		expect(piNativeOpenAiCodexResponsesStreamSimple).not.toBe(
			registryStreamSimple as typeof piNativeOpenAiCodexResponsesStreamSimple,
		);

		// After a registry override, native fallbacks remain the original implementations.
		const poison = (): AssistantMessageEventStream => {
			throw new Error("registry poison");
		};
		registerPoisonRegistry(poison, poison, "identity-poison");
		expect(getApiProvider("openai-responses")?.streamSimple).not.toBe(
			piNativeOpenAiResponsesStreamSimple,
		);
		expect(getApiProvider("openai-codex-responses")?.streamSimple).not.toBe(
			piNativeOpenAiCodexResponsesStreamSimple,
		);
		expect(piNativeOpenAiResponsesStreamSimple).toBe(
			streamSimpleOpenAIResponses as typeof piNativeOpenAiResponsesStreamSimple,
		);
		expect(piNativeOpenAiCodexResponsesStreamSimple).toBe(
			streamSimpleOpenAICodexResponses as typeof piNativeOpenAiCodexResponsesStreamSimple,
		);
	});

	test("inactive fallback returns the native child stream without re-entering the dispatcher", () => {
		const config = createDefaultConfig();
		const { service } = configuration(config);
		const runtime = new InactiveOnlyRuntime();
		const policy = new ProviderActivationPolicy(service);
		const dispatchers = createCodexProviderDispatchers(runtime, service, policy);

		let openAiDepth = 0;
		let openAiMaxDepth = 0;
		let codexDepth = 0;
		let codexMaxDepth = 0;
		let registryHits = 0;

		const trackedOpenAi = (
			modelValue: Model<string>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			openAiDepth += 1;
			openAiMaxDepth = Math.max(openAiMaxDepth, openAiDepth);
			try {
				if (openAiDepth > 1) {
					throw new Error("openai-responses dispatcher re-entered itself");
				}
				return dispatchers.openAiResponses(modelValue, context, options);
			} finally {
				openAiDepth -= 1;
			}
		};

		const trackedCodex = (
			modelValue: Model<string>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			codexDepth += 1;
			codexMaxDepth = Math.max(codexMaxDepth, codexDepth);
			try {
				if (codexDepth > 1) {
					throw new Error("openai-codex-responses dispatcher re-entered itself");
				}
				return dispatchers.codexResponses(modelValue, context, options);
			} finally {
				codexDepth -= 1;
			}
		};

		// Poison the mutable registry the same way a re-registered dispatcher would:
		// any fallback that consults streamSimple/getApiProvider re-enters or fails.
		registerPoisonRegistry(trackedOpenAi, trackedCodex, "pi-codex-adaptor-test");
		expect(getApiProvider("openai-responses")?.streamSimple).not.toBe(
			piNativeOpenAiResponsesStreamSimple,
		);
		expect(getApiProvider("openai-codex-responses")?.streamSimple).not.toBe(
			piNativeOpenAiCodexResponsesStreamSimple,
		);

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const options: SimpleStreamOptions = { apiKey: "fixture-key" };

		const inactiveResponses = model("unselected-gateway", "openai-responses");
		const inactiveCodex = model("unselected-codex", "openai-codex-responses");

		const responsesStream = trackedOpenAi(inactiveResponses, context, options);
		const codexStream = trackedCodex(inactiveCodex, context, options);

		expect(openAiMaxDepth).toBe(1);
		expect(codexMaxDepth).toBe(1);
		expect(runtime.createResponseCalls).toBe(0);
		expect(responsesStream).toBeDefined();
		expect(codexStream).toBeDefined();
		expect(responsesStream).not.toBe(codexStream);

		// A later registry replacement must still be ignored by production fallbacks.
		const countingOpenAi = (
			modelValue: Model<string>,
			contextValue: Context,
			optionsValue?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			registryHits += 1;
			return trackedOpenAi(modelValue, contextValue, optionsValue);
		};
		const countingCodex = (
			modelValue: Model<string>,
			contextValue: Context,
			optionsValue?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			registryHits += 1;
			return trackedCodex(modelValue, contextValue, optionsValue);
		};
		registerPoisonRegistry(countingOpenAi, countingCodex, "pi-codex-adaptor-test-wrap");

		openAiMaxDepth = 0;
		codexMaxDepth = 0;
		const againResponses = dispatchers.openAiResponses(inactiveResponses, context, options);
		const againCodex = dispatchers.codexResponses(inactiveCodex, context, options);
		expect(againResponses).toBeDefined();
		expect(againCodex).toBeDefined();
		expect(openAiMaxDepth).toBe(0);
		expect(codexMaxDepth).toBe(0);
		expect(registryHits).toBe(0);
		expect(runtime.createResponseCalls).toBe(0);

		policy.dispose();
	});

	test("active models keep the adaptor path while inactive models keep native identity", async () => {
		const config: CodexConfig = {
			...createDefaultConfig(),
			activation: { providers: ["custom-codex"] },
		};
		const { service, publish } = configuration(config);
		const runtime = new ActiveRuntime();
		const policy = new ProviderActivationPolicy(service);
		publish(config);
		expect(policy.isActive(model("custom-codex", "openai-responses"))).toBe(true);

		const dispatchers = createCodexProviderDispatchers(runtime, service, policy);

		let registryHits = 0;
		const poison = (): AssistantMessageEventStream => {
			registryHits += 1;
			throw new Error("registry must not serve inactive fallback");
		};
		registerPoisonRegistry(poison, poison, "poison-registry");

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};
		const options: SimpleStreamOptions = { apiKey: "fixture-key" };

		const active = model("custom-codex", "openai-responses");
		const inactive = model("other-provider", "openai-responses");
		const inactiveCodex = model("other-provider", "openai-codex-responses");

		const activeStream = dispatchers.openAiResponses(active, context, options);
		const inactiveResponsesStream = dispatchers.openAiResponses(inactive, context, options);
		const inactiveCodexStream = dispatchers.codexResponses(inactiveCodex, context, options);

		// Inactive path returns the exact native child stream without wrapping through the registry.
		const expectedResponses = piNativeOpenAiResponsesStreamSimple(inactive, context, options);
		const expectedCodex = piNativeOpenAiCodexResponsesStreamSimple(inactiveCodex, context, options);
		expect(Object.getPrototypeOf(inactiveResponsesStream)).toBe(
			Object.getPrototypeOf(expectedResponses),
		);
		expect(Object.getPrototypeOf(inactiveCodexStream)).toBe(Object.getPrototypeOf(expectedCodex));
		expect(inactiveResponsesStream).not.toBe(activeStream);
		expect(registryHits).toBe(0);

		const activeResult = await activeStream.result();
		expect(runtime.createResponseCalls).toBe(1);
		expect(runtime.lastConnectionProviderId).toBe("custom-codex");
		expect(activeResult.stopReason).not.toBe("error");
		expect(registryHits).toBe(0);

		policy.dispose();
	});
});

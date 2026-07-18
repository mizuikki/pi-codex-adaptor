import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@earendil-works/pi-ai";

import type {
	CodexProviderConnection,
	CodexRuntime,
	CreateResponseOptions,
	CreateResponseResult,
} from "../../src/application/codex-runtime.ts";
import { extractAccountId } from "../../src/application/codex-runtime.ts";
import {
	CodexCompactionStore,
	createCodexCompactionDetails,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { createCodexStreamSimple } from "../../src/integration/pi/codex-provider.ts";

class FixtureRuntime implements CodexRuntime {
	request: CreateResponseOptions | undefined;
	lastToolsParams: Record<string, unknown> | undefined;
	calls = 0;

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.calls += 1;
		this.request = options;
		await options.onEvent({ type: "response.output_text.delta", delta: "hello" });
		await options.onEvent({
			type: "response.output_item.done",
			item: { type: "message", id: "message-fixture", phase: "final_answer" },
		});
		await options.onEvent({
			type: "response.output_item.done",
			item: {
				type: "custom_tool_call",
				call_id: "patch-call",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
		});
		await options.onEvent({
			type: "response.output_item.done",
			item: {
				type: "function_call",
				call_id: "image-call",
				namespace: "image_gen",
				name: "imagegen",
				arguments: '{"prompt":"fixture"}',
			},
		});
		await options.onEvent({
			type: "response.output_item.done",
			item: {
				type: "function_call",
				call_id: "call-fixture",
				name: "update_plan",
				arguments: '{"plan":[]}',
			},
		});
		await options.onEvent({
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				id: "ws-fixture",
				status: "completed",
				action: { type: "search", query: "fixture weather" },
			},
		});
		await options.onEvent({ type: "response.server_model", model: "resolved-fixture" });
		return {
			status: "completed",
			result: {
				responseId: "response-fixture",
				tokenUsage: {
					input_tokens: 12,
					cached_input_tokens: 3,
					output_tokens: 4,
					reasoning_output_tokens: 1,
					total_tokens: 16,
				},
			},
		};
	}

	async compact(): Promise<CreateResponseResult> {
		throw new Error("fixture compaction is not configured");
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

	async resolveTools(params: unknown): Promise<unknown> {
		const root = params as Record<string, unknown>;
		const provider = root.provider as Record<string, unknown>;
		// Capture for assertions that tools.resolve no longer receives hard-coded host guesses only.
		this.lastToolsParams = root;
		return {
			modelTools: [
				{
					type: "function",
					name: "update_plan",
					description: "official fixture tool",
					parameters: { type: "object", properties: {} },
					strict: false,
				},
				...(provider.hostedWebSearch === true
					? [{ type: "web_search", indexed_web_access: true }]
					: []),
			],
		};
	}

	async executeTool(): Promise<CreateResponseResult> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

const model: Model<string> = {
	id: "fixture-model",
	name: "Fixture model",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://invalid.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

const context: Context = {
	systemPrompt: "fixture system",
	messages: [
		{ role: "user", content: "fixture input", timestamp: 1 },
		{
			role: "toolResult",
			toolCallId: "previous-call",
			toolName: "fixture_tool",
			content: [{ type: "text", text: "previous output" }],
			isError: false,
			timestamp: 2,
		},
		{
			role: "assistant",
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "fixture-model",
			content: [
				{
					type: "toolCall",
					id: "previous-patch",
					name: "apply_patch",
					arguments: { input: "*** Begin Patch\n*** End Patch" },
				},
				{
					type: "toolCall",
					id: "previous-image",
					name: "image_gen.imagegen",
					arguments: { prompt: "previous fixture" },
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
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "previous-image",
			toolName: "image_gen.imagegen",
			content: [{ type: "text", text: "generated" }],
			isError: false,
			timestamp: 5,
		},
		{
			role: "toolResult",
			toolCallId: "previous-patch",
			toolName: "apply_patch",
			content: [{ type: "text", text: "Done!" }],
			isError: false,
			timestamp: 4,
		},
	],
	tools: [
		{
			name: "update_plan",
			description: "fixture tool",
			parameters: { type: "object", properties: {} },
		},
	],
};

function configuration(config: CodexConfig = createDefaultConfig()): ConfigurationService {
	return {
		load: async () => config,
	} as ConfigurationService;
}

function fixtureToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("Pi Codex provider adapter", () => {
	test("maps Pi context through the native response stream", async () => {
		const runtime = new FixtureRuntime();
		const streamSimple = createCodexStreamSimple(
			runtime,
			configuration(),
			new CodexCompactionStore(),
			new ProviderActivationPolicy(configuration()),
		);
		const events = [];

		for await (const event of streamSimple(model, context, {
			apiKey: fixtureToken(),
			reasoning: "high",
			sessionId: "session-fixture",
		})) {
			events.push(event);
		}

		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("fixture stream did not finish");
		expect(done.message).toMatchObject({
			responseId: "response-fixture",
			responseModel: "resolved-fixture",
			stopReason: "toolUse",
			usage: { input: 12, cacheRead: 3, output: 4, reasoning: 1, totalTokens: 16 },
		});
		expect(done.message.content).toEqual([
			{
				type: "text",
				text: "hello",
				textSignature: JSON.stringify({ v: 1, id: "message-fixture", phase: "final_answer" }),
			},
			{
				type: "toolCall",
				id: "patch-call",
				name: "apply_patch",
				arguments: { input: "*** Begin Patch\n*** End Patch" },
			},
			{
				type: "toolCall",
				id: "image-call",
				name: "image_gen.imagegen",
				arguments: { prompt: "fixture" },
			},
			{
				type: "toolCall",
				id: "call-fixture",
				name: "update_plan",
				arguments: { plan: [] },
			},
			{
				type: "text",
				text: "Web search: fixture weather",
				textSignature: JSON.stringify({
					v: 1,
					kind: "web_search_call",
					id: "ws-fixture",
					status: "completed",
					action: { type: "search", query: "fixture weather" },
				}),
			},
		]);
		expect(runtime.request?.connection).toEqual({
			providerId: "openai-codex",
			baseUrl: "https://invalid.example",
			headers: {},
			authentication: { kind: "bearer", token: fixtureToken() },
			accountId: "account-fixture",
		} satisfies CodexProviderConnection);
		const request = runtime.request?.request as Record<string, unknown>;
		expect(request.model).toBe("fixture-model");
		expect(request.input).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "fixture input" }] },
			{ type: "function_call_output", call_id: "previous-call", output: "previous output" },
			{
				type: "custom_tool_call",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
				call_id: "previous-patch",
			},
			{
				type: "function_call",
				namespace: "image_gen",
				name: "imagegen",
				arguments: '{"prompt":"previous fixture"}',
				call_id: "previous-image",
			},
			{ type: "function_call_output", call_id: "previous-image", output: "generated" },
			{ type: "custom_tool_call_output", call_id: "previous-patch", output: "Done!" },
		]);
		expect(request.tools).toEqual([
			{
				type: "function",
				name: "update_plan",
				description: "official fixture tool",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
			{ type: "web_search", indexed_web_access: true },
		]);
		expect(runtime.request?.providerSupportsWebsockets).toBe(true);
		expect(runtime.lastToolsParams?.provider).toEqual({
			hostedWebSearch: true,
			namespaceTools: true,
			imageGeneration: true,
		});
		expect(runtime.lastToolsParams?.standaloneWebSearch).toEqual({
			featureEnabled: false,
			executorAvailable: true,
		});
	});

	test("treats non-JWT provider credentials as API keys", async () => {
		const runtime = new FixtureRuntime();
		const streamSimple = createCodexStreamSimple(
			runtime,
			configuration(),
			new CodexCompactionStore(),
			new ProviderActivationPolicy(configuration()),
		);
		const events = [];
		for await (const event of streamSimple(model, context, { apiKey: "opaque-fixture-api-key" })) {
			events.push(event);
		}

		expect(events.at(-1)?.type).toBe("done");
		expect(runtime.calls).toBe(1);
		expect(runtime.request?.connection).toEqual({
			providerId: "openai-codex",
			baseUrl: "https://invalid.example",
			headers: {},
			authentication: { kind: "bearer", token: "opaque-fixture-api-key" },
		} satisfies CodexProviderConnection);
		expect(extractAccountId("opaque-fixture-api-key")).toBeUndefined();
	});

	test("runs a selected ordinary Responses provider without a ChatGPT account id", async () => {
		const runtime = new FixtureRuntime();
		const config = {
			...createDefaultConfig(),
			activation: { providers: ["custom-codex"] },
		};
		const activation = new ProviderActivationPolicy(configuration(config));
		await activation.refresh();
		const streamSimple = createCodexStreamSimple(
			runtime,
			configuration(config),
			new CodexCompactionStore(),
			activation,
		);
		const customModel = { ...model, provider: "custom-codex", api: "openai-responses" };
		const events = [];
		for await (const event of streamSimple(customModel, context, {
			apiKey: "opaque-fixture-key",
		})) {
			events.push(event);
		}

		expect(events.at(-1)?.type).toBe("done");
		expect(runtime.request?.connection).toEqual({
			providerId: "custom-codex",
			baseUrl: "https://invalid.example",
			headers: {},
			authentication: { kind: "bearer", token: "opaque-fixture-key" },
		} satisfies CodexProviderConnection);
	});

	test("rejects missing provider credentials without reflecting values", async () => {
		const runtime = new FixtureRuntime();
		const streamSimple = createCodexStreamSimple(
			runtime,
			configuration(),
			new CodexCompactionStore(),
			new ProviderActivationPolicy(configuration()),
		);
		const events = [];
		for await (const event of streamSimple(model, context, { apiKey: "" })) {
			events.push(event);
		}

		const error = events.at(-1);
		expect(error).toMatchObject({ type: "error", reason: "error" });
		if (error?.type !== "error") throw new Error("expected error event");
		// Provider surface keeps a safe generic message; credentials must not appear.
		expect(error.error.errorMessage).toBe("OpenAI Codex request failed");
		expect(JSON.stringify(error)).not.toContain("opaque-fixture-api-key");
		expect(runtime.calls).toBe(0);
	});

	test("replays canonical compaction output instead of the display summary", async () => {
		const runtime = new FixtureRuntime();
		const compactions = new CodexCompactionStore();
		const summary = "Context compacted by the OpenAI Codex Responses API.";
		compactions.set(
			"session-fixture",
			summary,
			createCodexCompactionDetails("fixture-model", [
				{ type: "message", role: "assistant", content: [] },
			]),
		);
		const streamSimple = createCodexStreamSimple(
			runtime,
			configuration(),
			compactions,
			new ProviderActivationPolicy(configuration()),
		);
		for await (const _event of streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
						timestamp: 1,
					},
					{ role: "user", content: "kept input", timestamp: 2 },
				],
			},
			{ apiKey: fixtureToken(), sessionId: "session-fixture" },
		)) {
			// Consume the stream to completion.
		}
		const request = runtime.request?.request as Record<string, unknown>;
		expect(request.input).toEqual([
			{ type: "message", role: "assistant", content: [] },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "kept input" }],
			},
		]);
	});
});

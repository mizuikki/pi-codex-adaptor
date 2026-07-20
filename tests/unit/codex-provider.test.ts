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
import { SUPPLEMENTAL_SESSION_INSTRUCTIONS } from "../../src/application/resolve-effective-capabilities.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { providerCompactionIdentityFromValues } from "../../src/integration/pi/codex-compaction-replay.ts";
import {
	createCodexStreamSimple as createCodexStreamSimpleAdapter,
	decodeResponseItemSignature,
	encodeResponseItemSignature,
} from "../../src/integration/pi/codex-provider.ts";
import type {
	CodexToolProfileCoordinator,
	CodexToolProfileReadiness,
} from "../../src/integration/pi/codex-tool-profile.ts";
import { createProviderConnection } from "../../src/integration/pi/provider-connection.ts";

class FixtureRuntime implements CodexRuntime {
	request: CreateResponseOptions | undefined;
	lastToolsParams: Record<string, unknown> | undefined;
	calls = 0;
	shellSurface: "unified-exec" | "shell-command" = "unified-exec";

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

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
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
			],
		};
	}

	async resolveModel(modelId: string): Promise<unknown> {
		return {
			model: { slug: modelId },
			shellSurface: this.shellSurface,
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
		const provider = root.providerContract as Record<string, unknown>;
		const sessions = root.sessions as Record<string, unknown>;
		const supplemental = this.shellSurface === "shell-command" && sessions.enabled === true;
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
				...(supplemental
					? [
							{ type: "function", name: "shell_command" },
							{ type: "function", name: "exec_command" },
							{ type: "function", name: "write_stdin" },
						]
					: []),
			],
			dispatchTools: [{ type: "function", name: "shell_command" }],
			localToolNames: supplemental
				? ["update_plan", "shell_command", "exec_command", "write_stdin"]
				: ["update_plan", "exec_command", "write_stdin"],
			hostedToolNames: provider.hostedWebSearch === true ? ["web_search"] : [],
			shellSurface: this.shellSurface,
			sessionSurface: supplemental ? "supplemental" : "official",
			webSurface: provider.hostedWebSearch === true ? "hosted" : "unsupported",
			imageGenerationSurface: "disabled",
			capabilities: {
				sessions: { status: "available", source: "official" },
				applyPatch: { status: "unavailable", reason: "model_apply_patch_disabled" },
				viewImage: { status: "disabled", reason: "disabled_by_configuration" },
				imageGeneration: { status: "disabled", reason: "disabled_by_configuration" },
				webSearch: { status: "available", source: "provider-contract" },
			},
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

function unhealthyProfile(readiness: CodexToolProfileReadiness): CodexToolProfileCoordinator {
	return {
		readiness,
		skillLoader: undefined,
		enterPending: () => {},
		installHealthy: () => false,
		installUnavailable: () => {},
		revalidateHealthyOwnership: () => false,
		isHealthy: () => false,
		restorePi: () => {},
		dispose: () => {},
	};
}

function healthyProfile(): CodexToolProfileCoordinator {
	return {
		...unhealthyProfile({ kind: "healthy", capabilityKey: "fixture-key" }),
		isHealthy: () => true,
	};
}

function createFixtureStream(
	runtime: FixtureRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
	compactions = new CodexCompactionStore(),
): ReturnType<typeof createCodexStreamSimpleAdapter> {
	return createCodexStreamSimpleAdapter(
		runtime,
		configuration,
		activation,
		compactions,
		undefined,
		healthyProfile(),
	);
}

describe("Pi Codex provider adapter", () => {
	test("maps Pi context through the native response stream", async () => {
		const runtime = new FixtureRuntime();
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
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
		const content = done.message.content;
		expect(content[0]).toMatchObject({ type: "text", text: "hello" });
		expect(
			decodeResponseItemSignature(
				content[0]?.type === "text" ? content[0].textSignature : undefined,
			),
		).toEqual({
			type: "message",
			id: "message-fixture",
			phase: "final_answer",
			role: "assistant",
			content: [{ type: "output_text", text: "hello" }],
		});
		expect(content[1]).toMatchObject({
			type: "toolCall",
			id: "patch-call",
			name: "apply_patch",
			arguments: { input: "*** Begin Patch\n*** End Patch" },
		});
		expect(
			decodeResponseItemSignature(
				content[1]?.type === "toolCall" ? content[1].thoughtSignature : undefined,
			),
		).toEqual({
			type: "custom_tool_call",
			call_id: "patch-call",
			name: "apply_patch",
			input: "*** Begin Patch\n*** End Patch",
		});
		expect(content[2]).toMatchObject({ type: "toolCall", id: "image-call" });
		expect(content[3]).toMatchObject({ type: "toolCall", id: "call-fixture" });
		expect(content[4]).toMatchObject({ type: "text", text: "Web search: fixture weather" });
		expect(
			decodeResponseItemSignature(
				content[4]?.type === "text" ? content[4].textSignature : undefined,
			),
		).toEqual({
			type: "web_search_call",
			id: "ws-fixture",
			status: "completed",
			action: { type: "search", query: "fixture weather" },
		});
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
		expect(runtime.lastToolsParams?.providerContract).toMatchObject({
			hostedWebSearch: true,
			namespaceTools: true,
			imagesApi: true,
			searchApi: true,
		});
		expect(runtime.lastToolsParams?.sessions).toEqual({
			enabled: true,
			executorAvailable: true,
		});
		expect(runtime.lastToolsParams?.standaloneWebSearch).toEqual({
			featureEnabled: false,
			executorAvailable: true,
		});
	});

	test("excludes every Pi core slot and inactive managed definition from the request", async () => {
		const runtime = new FixtureRuntime();
		const tool = (name: string) => ({
			name,
			description: `fixture ${name}`,
			parameters: { type: "object", properties: {} },
		});
		const isolatedContext = {
			...context,
			tools: [
				...[
					"read",
					"bash",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"third_party",
					"update_plan",
					"view_image",
				].map(tool),
			],
		} as Context;
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
		);

		for await (const _event of streamSimple(model, isolatedContext, { apiKey: fixtureToken() })) {
			// Drain the response so the request is constructed and dispatched.
		}

		const request = runtime.request?.request as Record<string, unknown>;
		expect(request.tools).toEqual([
			{
				type: "function",
				name: "update_plan",
				description: "official fixture tool",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
			{ type: "web_search", indexed_web_access: true },
			{
				type: "function",
				name: "third_party",
				description: "fixture third_party",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
		]);
	});

	test("rejects every non-matching profile before native response dispatch", async () => {
		const profiles: CodexToolProfileReadiness[] = [
			{ kind: "pending", capabilityKey: "fixture-pending" },
			{ kind: "unavailable", capabilityKey: "fixture-unavailable" },
			{ kind: "inactive" },
			{ kind: "healthy", capabilityKey: "fixture-other-key" },
		];

		for (const readiness of profiles) {
			const runtime = new FixtureRuntime();
			const streamSimple = createCodexStreamSimpleAdapter(
				runtime,
				configuration(),
				new ProviderActivationPolicy(configuration()),
				new CodexCompactionStore(),
				undefined,
				unhealthyProfile(readiness),
			);
			const events = [];
			for await (const event of streamSimple(model, context, { apiKey: fixtureToken() })) {
				events.push(event);
			}
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
			expect(runtime.calls).toBe(0);
		}
	});

	test("adds supplemental session guidance exactly once", async () => {
		const runtime = new FixtureRuntime();
		runtime.shellSurface = "shell-command";
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
		);
		for await (const _event of streamSimple(model, context, { apiKey: fixtureToken() })) {
			// drain the response
		}
		const request = runtime.request?.request as Record<string, unknown>;
		const instructions = request.instructions as string;
		expect(instructions.split(SUPPLEMENTAL_SESSION_INSTRUCTIONS).length - 1).toBe(1);
		expect(request.tools).toEqual([
			{
				type: "function",
				name: "update_plan",
				description: "official fixture tool",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
			{ type: "web_search", indexed_web_access: true },
			{ type: "function", name: "shell_command" },
			{ type: "function", name: "exec_command" },
			{ type: "function", name: "write_stdin" },
		]);
	});

	test("treats non-JWT provider credentials as API keys", async () => {
		const runtime = new FixtureRuntime();
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
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
		const streamSimple = createFixtureStream(
			runtime,
			configuration(config),
			activation,
			new CodexCompactionStore(),
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
		expect(runtime.request?.providerSupportsWebsockets).toBe(false);
	});

	test("rejects missing provider credentials without reflecting values", async () => {
		const runtime = new FixtureRuntime();
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
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
		const connection = createProviderConnection(model, { apiKey: fixtureToken() });
		const identity = providerCompactionIdentityFromValues({
			sessionId: "session-fixture",
			model,
			connection,
		});
		if (identity === undefined) throw new Error("fixture identity unavailable");
		compactions.set(
			"session-fixture",
			summary,
			createCodexCompactionDetails(identity, [
				{ type: "compaction", encrypted_content: "synthetic-opaque-content" },
			]),
		);
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			compactions,
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
			{ type: "compaction", encrypted_content: "synthetic-opaque-content" },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "kept input" }],
			},
		]);
	});

	test("round-trips every supported typed response-item family through its envelope", () => {
		const metadata = { turn_id: "synthetic-turn" };
		const items = [
			{ type: "additional_tools", id: "tools-id", role: "system", tools: [] },
			{
				type: "message",
				id: "message-id",
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "synthetic message" }],
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "agent_message",
				id: "agent-id",
				author: "synthetic-author",
				recipient: "synthetic-recipient",
				content: [],
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "reasoning",
				id: "reasoning-id",
				summary: [{ type: "summary_text", text: "synthetic reasoning" }],
				content: [{ type: "reasoning_text", text: "synthetic detail" }],
				encrypted_content: "synthetic-reasoning-opaque",
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "local_shell_call",
				id: "shell-id",
				call_id: "shell-call",
				status: "completed",
				action: { type: "exec", command: "synthetic" },
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "function_call",
				id: "function-id",
				name: "synthetic_tool",
				namespace: "synthetic_namespace",
				arguments: '{"value":1}',
				call_id: "function-call",
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "tool_search_call",
				id: "search-call-id",
				call_id: "search-call",
				status: "completed",
				execution: "synthetic-execution",
				arguments: { query: "synthetic" },
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "function_call_output",
				id: "function-output-id",
				call_id: "function-call",
				output: [{ type: "input_text", text: "synthetic output" }],
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "custom_tool_call",
				id: "custom-call-id",
				status: "completed",
				call_id: "custom-call",
				name: "synthetic_custom_tool",
				namespace: "synthetic_namespace",
				input: "synthetic input",
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "custom_tool_call_output",
				id: "custom-output-id",
				call_id: "custom-call",
				name: "synthetic_custom_tool",
				output: "synthetic custom output",
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "tool_search_output",
				id: "search-output-id",
				call_id: "search-call",
				status: "completed",
				execution: "synthetic-execution",
				tools: [],
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "web_search_call",
				id: "web-id",
				status: "completed",
				action: { type: "search", query: "synthetic query" },
				internal_chat_message_metadata_passthrough: metadata,
			},
			{
				type: "image_generation_call",
				id: "image-id",
				status: "completed",
				revised_prompt: "synthetic revised prompt",
				result: "synthetic image result",
				internal_chat_message_metadata_passthrough: metadata,
			},
			{ type: "compaction", id: "compaction-id", encrypted_content: "synthetic-opaque-content" },
			{
				type: "context_compaction",
				id: "context-compaction-id",
				encrypted_content: "synthetic-context-opaque",
				internal_chat_message_metadata_passthrough: metadata,
			},
			{ type: "message", role: "user", content: [] },
		] as const;

		for (const item of items) {
			expect(decodeResponseItemSignature(encodeResponseItemSignature(item))).toEqual(item);
		}
	});
});

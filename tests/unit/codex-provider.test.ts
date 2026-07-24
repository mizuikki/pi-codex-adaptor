import { describe, expect, test } from "bun:test";
import {
	type AssistantMessage,
	type Context,
	isRetryableAssistantError,
	type Model,
} from "@earendil-works/pi-ai";

import type {
	CodexProviderConnection,
	CodexRuntime,
	CreateResponseOptions,
	CreateResponseResult,
} from "../../src/application/codex-runtime.ts";
import { extractAccountId } from "../../src/application/codex-runtime.ts";
import {
	CodexCompactionStore,
	createCodexAutoCompactionCheckpoint,
	createPortableCompactionDetails,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { SUPPLEMENTAL_SESSION_INSTRUCTIONS } from "../../src/application/resolve-effective-capabilities.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { BridgeRemoteError } from "../../src/infrastructure/codex-bridge/client.ts";
import { providerCompactionIdentityFromValues } from "../../src/integration/pi/codex-compaction-replay.ts";
import {
	INTERRUPTED_TOOL_RESULT_TEXT,
	normalizeCodexContextMessages,
} from "../../src/integration/pi/codex-message-normalization.ts";
import {
	createCodexStreamSimple as createCodexStreamSimpleAdapter,
	decodeResponseItemSignature,
	encodeResponseItemSignature,
	responseItemsFromMessages,
} from "../../src/integration/pi/codex-provider.ts";
import { sha256Hex } from "../../src/integration/pi/codex-provider-request-guard.ts";
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
	throwOnCreate: Error | undefined;

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.calls += 1;
		this.request = options;
		if (this.throwOnCreate !== undefined) {
			throw this.throwOnCreate;
		}
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

	async summarizeContext(): Promise<never> {
		throw new Error("fixture summary is not configured");
	}

	async compact(): Promise<never> {
		throw new Error("fixture compaction is not configured");
	}

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
				"responses_sse",
				"responses_websocket",
				"portable_context_summary",
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

function fixtureToken(accountId = "account-fixture"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
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

function assistantWithCalls(
	calls: ReadonlyArray<{
		id: string;
		name: string;
		arguments?: Record<string, unknown>;
		thoughtSignature?: string;
	}>,
	stopReason: "toolUse" | "stop" | "error" | "aborted" = "toolUse",
): Record<string, unknown> {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments ?? {},
			...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature }),
		})),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function toolResult(
	toolCallId: string,
	toolName: string,
	text = "synthetic output",
): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

describe("interrupted tool-call normalization", () => {
	test("preserves a complete history by identity and at the structured item boundary", () => {
		const messages = [
			assistantWithCalls([
				{ id: "ordinary-call", name: "fixture_tool" },
				{ id: "patch-call", name: "apply_patch", arguments: { input: "synthetic patch" } },
			]),
			toolResult("ordinary-call", "fixture_tool", "ordinary result"),
			toolResult("patch-call", "apply_patch", "patch result"),
		] as const;
		const before = structuredClone(messages);

		expect(normalizeCodexContextMessages(messages)).toBe(messages);
		expect(responseItemsFromMessages(messages)).toEqual([
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: "{}",
				call_id: "ordinary-call",
			},
			{
				type: "custom_tool_call",
				name: "apply_patch",
				input: "synthetic patch",
				call_id: "patch-call",
			},
			{ type: "function_call_output", call_id: "ordinary-call", output: "ordinary result" },
			{ type: "custom_tool_call_output", call_id: "patch-call", output: "patch result" },
		]);
		expect(messages).toEqual(before);
	});

	test("inserts one deterministic fixed error before a user boundary and at end of sequence", () => {
		const call = assistantWithCalls([{ id: "missing-call", name: "fixture_tool" }]);
		const user = { role: "user", content: "synthetic continuation", timestamp: 2 };
		const withUser = [call, user] as const;
		const source = structuredClone(withUser);
		const expectedOutput = {
			type: "function_call_output",
			call_id: "missing-call",
			output: INTERRUPTED_TOOL_RESULT_TEXT,
		};

		expect(responseItemsFromMessages(withUser)).toEqual([
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: "{}",
				call_id: "missing-call",
			},
			expectedOutput,
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "synthetic continuation" }],
			},
		]);
		expect(responseItemsFromMessages([call])).toEqual([
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: "{}",
				call_id: "missing-call",
			},
			expectedOutput,
		]);
		expect(responseItemsFromMessages(withUser)).toEqual(responseItemsFromMessages(withUser));
		expect(withUser).toEqual(source);
	});

	test("repairs only missing members of parallel ordinary, namespace, and custom batches", () => {
		const messages = [
			assistantWithCalls([
				{ id: "ordinary-call", name: "fixture_tool" },
				{ id: "namespace-call", name: "fixture.search" },
				{ id: "patch-call", name: "apply_patch", arguments: { input: "synthetic patch" } },
			]),
			toolResult("namespace-call", "fixture.search", "namespace result"),
			{ role: "custom", customType: "synthetic", content: "continue", timestamp: 3 },
		] as const;
		const items = responseItemsFromMessages(messages);

		expect(
			items.filter((item) => (item as { call_id?: string }).call_id === "namespace-call"),
		).toEqual([
			{
				type: "function_call",
				namespace: "fixture",
				name: "search",
				arguments: "{}",
				call_id: "namespace-call",
			},
			{ type: "function_call_output", call_id: "namespace-call", output: "namespace result" },
		]);
		expect(items).toContainEqual({
			type: "function_call_output",
			call_id: "ordinary-call",
			output: INTERRUPTED_TOOL_RESULT_TEXT,
		});
		expect(items).toContainEqual({
			type: "custom_tool_call_output",
			call_id: "patch-call",
			output: INTERRUPTED_TOOL_RESULT_TEXT,
		});
		const allMissing = responseItemsFromMessages([
			assistantWithCalls([
				{ id: "first-missing", name: "fixture_tool" },
				{ id: "second-missing", name: "fixture_tool" },
			]),
		]);
		expect(
			allMissing
				.filter((item) => (item as { type?: string }).type === "function_call_output")
				.map((item) => (item as { call_id?: string }).call_id),
		).toEqual(["first-missing", "second-missing"]);
	});

	test("flushes every raw Pi user-like boundary and ignores excluded bash boundaries", () => {
		const boundaries = [
			{ role: "custom", customType: "synthetic", content: "continue", timestamp: 2 },
			{
				role: "bashExecution",
				command: "synthetic command",
				output: "synthetic output",
				exitCode: 0,
				timestamp: 2,
			},
			{ role: "branchSummary", summary: "synthetic summary", fromId: "entry", timestamp: 2 },
			{ role: "compactionSummary", summary: "synthetic summary", tokensBefore: 1, timestamp: 2 },
			assistantWithCalls([], "stop"),
		] as const;

		for (const boundary of boundaries) {
			const normalized = normalizeCodexContextMessages([
				assistantWithCalls([{ id: "missing-call", name: "fixture_tool" }]),
				boundary,
			]);
			expect((normalized[1] as { role?: string }).role).toBe("toolResult");
			expect(normalized[2]).toBe(boundary);
		}

		const excluded = {
			role: "bashExecution",
			command: "synthetic command",
			output: "synthetic output",
			excludeFromContext: true,
			timestamp: 2,
		};
		const result = toolResult("complete-call", "fixture_tool");
		const normalized = normalizeCodexContextMessages([
			assistantWithCalls([{ id: "complete-call", name: "fixture_tool" }]),
			excluded,
			result,
		]);
		expect(normalized[1]).toBe(excluded);
		expect(normalized[2]).toBe(result);
		expect(normalized).toHaveLength(3);
	});

	test("excludes aborted and error assistants before tracking partial calls", () => {
		for (const stopReason of ["aborted", "error"] as const) {
			const incomplete = assistantWithCalls(
				[{ id: "partial-call", name: "fixture_tool" }],
				stopReason,
			);
			expect(
				responseItemsFromMessages([
					assistantWithCalls([{ id: "earlier-call", name: "fixture_tool" }]),
					incomplete,
				]),
			).toEqual([
				{
					type: "function_call",
					name: "fixture_tool",
					arguments: "{}",
					call_id: "earlier-call",
				},
				{
					type: "function_call_output",
					call_id: "earlier-call",
					output: INTERRUPTED_TOOL_RESULT_TEXT,
				},
			]);
		}
	});

	test("fails closed on duplicate ids, signed-id conflicts, and output-kind conflicts", () => {
		const sourceSecret = "source-content-must-not-appear";
		const conflicts = [
			assistantWithCalls([
				{ id: "duplicate-call", name: "fixture_tool" },
				{ id: "duplicate-call", name: "fixture_tool", arguments: { secret: sourceSecret } },
			]),
			assistantWithCalls([
				{
					id: "visible-call",
					name: "fixture_tool",
					thoughtSignature: encodeResponseItemSignature({
						type: "function_call",
						name: "fixture_tool",
						arguments: "{}",
						call_id: "signed-call",
					}),
				},
			]),
			[
				assistantWithCalls([{ id: "kind-call", name: "apply_patch" }]),
				toolResult("kind-call", "fixture_tool", sourceSecret),
			],
		] as const;

		for (const conflict of conflicts) {
			try {
				normalizeCodexContextMessages(Array.isArray(conflict) ? conflict : [conflict]);
				throw new Error("expected normalization failure");
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("OpenAI Codex message history is invalid");
				expect((error as Error).message).not.toContain(sourceSecret);
			}
		}
	});

	test("does not apply host image or cross-model transformations", () => {
		const image = { type: "image", data: "synthetic-image", mimeType: "image/png" };
		const messages = [
			{ role: "user", content: [image], timestamp: 1 },
			assistantWithCalls([{ id: "signed-call", name: "fixture_tool" }]),
			toolResult("signed-call", "fixture_tool"),
		] as const;
		expect(normalizeCodexContextMessages(messages)).toBe(messages);
		expect(messages[0].content[0] as unknown).toBe(image);
	});

	test("keeps concurrent projections operation-local and the fixed output free of source data", async () => {
		const first = [
			assistantWithCalls([
				{
					id: "first-private-id",
					name: "first_private_tool",
					arguments: { value: "first-private-argument" },
				},
			]),
		] as const;
		const second = [
			assistantWithCalls([
				{
					id: "second-private-id",
					name: "second_private_tool",
					arguments: { value: "second-private-argument" },
				},
			]),
		] as const;
		const [firstItems, secondItems] = await Promise.all([
			Promise.resolve().then(() => responseItemsFromMessages(first)),
			Promise.resolve().then(() => responseItemsFromMessages(second)),
		]);

		expect(firstItems.at(-1)).toEqual({
			type: "function_call_output",
			call_id: "first-private-id",
			output: INTERRUPTED_TOOL_RESULT_TEXT,
		});
		expect(secondItems.at(-1)).toEqual({
			type: "function_call_output",
			call_id: "second-private-id",
			output: INTERRUPTED_TOOL_RESULT_TEXT,
		});
		expect(INTERRUPTED_TOOL_RESULT_TEXT).not.toContain("private");
	});
});

describe("Pi Codex provider adapter", () => {
	test("repairs the complete activated-provider context once and blocks conflicts before dispatch", async () => {
		const runtime = new FixtureRuntime();
		const service = configuration();
		const streamSimple = createFixtureStream(
			runtime,
			service,
			new ProviderActivationPolicy(service),
		);
		for await (const _event of streamSimple(
			model,
			{
				messages: [
					assistantWithCalls([{ id: "interrupted-call", name: "fixture_tool" }]),
					{ role: "user", content: "resume safely", timestamp: 2 },
				] as unknown as Context["messages"],
			},
			{ apiKey: fixtureToken(), sessionId: "session-fixture" },
		)) {
			// Consume the stream to completion.
		}
		expect(runtime.calls).toBe(1);
		const recoveredRequest = runtime.request?.request as { input: unknown[] } | undefined;
		expect(recoveredRequest?.input).toEqual([
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: "{}",
				call_id: "interrupted-call",
			},
			{
				type: "function_call_output",
				call_id: "interrupted-call",
				output: INTERRUPTED_TOOL_RESULT_TEXT,
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "resume safely" }],
			},
		]);

		const blockedRuntime = new FixtureRuntime();
		const blockedStream = createFixtureStream(
			blockedRuntime,
			service,
			new ProviderActivationPolicy(service),
		);
		const events = [];
		for await (const event of blockedStream(
			model,
			{
				messages: [
					assistantWithCalls([
						{ id: "duplicate-call", name: "fixture_tool" },
						{ id: "duplicate-call", name: "fixture_tool" },
					]),
				] as unknown as Context["messages"],
			},
			{ apiKey: fixtureToken(), sessionId: "session-fixture" },
		)) {
			events.push(event);
		}
		expect(events.at(-1)).toMatchObject({
			type: "error",
			error: { errorMessage: "OpenAI Codex request failed" },
		});
		expect(blockedRuntime.calls).toBe(0);
	});

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
			createPortableCompactionDetails(sha256Hex(summary), {
				identity,
				output: [{ type: "compaction", encrypted_content: "synthetic-opaque-content" }],
			}),
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

	test("falls back to the portable summary text when a v3 accelerator identity no longer matches", async () => {
		const runtime = new FixtureRuntime();
		const compactions = new CodexCompactionStore();
		const summary = "Portable summary for a different identity";
		const mismatchedConnection = createProviderConnection(model, {
			apiKey: fixtureToken("other-account"),
		});
		const mismatchedIdentity = providerCompactionIdentityFromValues({
			sessionId: "session-fixture",
			model,
			connection: mismatchedConnection,
		});
		if (mismatchedIdentity === undefined) throw new Error("fixture identity unavailable");
		compactions.set(
			"session-fixture",
			summary,
			createPortableCompactionDetails(sha256Hex(summary), {
				identity: mismatchedIdentity,
				output: [{ type: "compaction", encrypted_content: "synthetic-opaque-content" }],
			}),
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
					{ role: "user", content: "keep using the portable checkpoint", timestamp: 2 },
				],
			},
			{ apiKey: fixtureToken(), sessionId: "session-fixture" },
		)) {
			// Consume the stream to completion.
		}
		const request = runtime.request?.request as Record<string, unknown>;
		expect(request.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
					},
				],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "keep using the portable checkpoint" }],
			},
		]);
	});

	test.each([
		{
			name: "matching v3 identity replays the opaque accelerator",
			storeSessionId: "session-fixture",
			storedTokenAccount: "account-fixture",
			requestTokenAccount: "account-fixture",
			expectedFirstType: "compaction",
		},
		{
			name: "changed auth identity falls back to portable text",
			storeSessionId: "session-fixture",
			storedTokenAccount: "other-account",
			requestTokenAccount: "account-fixture",
			expectedFirstType: "message",
		},
		{
			name: "changed session identity falls back to portable text",
			storeSessionId: "other-session",
			storedTokenAccount: "account-fixture",
			requestTokenAccount: "account-fixture",
			expectedFirstType: "message",
		},
	])("$name", async ({
		storeSessionId,
		storedTokenAccount,
		requestTokenAccount,
		expectedFirstType,
	}) => {
		const runtime = new FixtureRuntime();
		const compactions = new CodexCompactionStore();
		const summary = "Portable summary matrix";
		const storedConnection = createProviderConnection(model, {
			apiKey: fixtureToken(storedTokenAccount),
		});
		const storedIdentity = providerCompactionIdentityFromValues({
			sessionId: storeSessionId,
			model,
			connection: storedConnection,
		});
		if (storedIdentity === undefined) throw new Error("fixture identity unavailable");
		compactions.set(
			storeSessionId,
			summary,
			createPortableCompactionDetails(sha256Hex(summary), {
				identity: storedIdentity,
				output: [{ type: "compaction", encrypted_content: "synthetic-opaque-content" }],
			}),
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
				],
			},
			{ apiKey: fixtureToken(requestTokenAccount), sessionId: "session-fixture" },
		)) {
			// Consume the stream to completion.
		}
		const request = runtime.request?.request as Record<string, unknown>;
		expect((request.input as Array<{ type: string }>)[0]?.type).toBe(expectedFirstType);
	});

	test("falls back to portable text for provider, model, API, base URL, session, and auth mismatches", async () => {
		const summary = "Portable summary mismatch matrix";
		const baseConnection = createProviderConnection(model, { apiKey: fixtureToken() });
		const baseIdentity = providerCompactionIdentityFromValues({
			sessionId: "session-fixture",
			model,
			connection: baseConnection,
		});
		if (baseIdentity === undefined) throw new Error("fixture identity unavailable");
		const cases: Array<{
			name: string;
			storeSessionId: string;
			identity: typeof baseIdentity;
			requestModel?: typeof model;
			requestOptions?: { apiKey?: string; sessionId?: string };
		}> = [
			{
				name: "provider",
				storeSessionId: "session-fixture",
				identity: { ...baseIdentity, providerId: "other-provider" },
			},
			{
				name: "model",
				storeSessionId: "session-fixture",
				identity: { ...baseIdentity, modelId: "other-model" },
			},
			{
				name: "api",
				storeSessionId: "session-fixture",
				identity: { ...baseIdentity, api: "other-api" },
			},
			{
				name: "baseUrl",
				storeSessionId: "session-fixture",
				identity: { ...baseIdentity, baseUrl: "https://other.invalid" },
			},
			{
				name: "session",
				storeSessionId: "other-session",
				identity: baseIdentity,
			},
			{
				name: "authentication",
				storeSessionId: "session-fixture",
				identity: {
					...baseIdentity,
					authenticationBinding: { kind: "jwt_account", fingerprint: "sha256:other-account" },
				},
			},
		];

		for (const testCase of cases) {
			const runtime = new FixtureRuntime();
			const compactions = new CodexCompactionStore();
			compactions.set(
				testCase.storeSessionId,
				summary,
				createPortableCompactionDetails(sha256Hex(summary), {
					identity: testCase.identity,
					output: [{ type: "compaction", encrypted_content: "synthetic-opaque-content" }],
				}),
			);
			const streamSimple = createFixtureStream(
				runtime,
				configuration(),
				new ProviderActivationPolicy(configuration()),
				compactions,
			);
			for await (const _event of streamSimple(
				testCase.requestModel ?? model,
				{
					messages: [
						{
							role: "user",
							content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
							timestamp: 1,
						},
						{ role: "user", content: `continue ${testCase.name}`, timestamp: 2 },
					],
				},
				{
					apiKey: testCase.requestOptions?.apiKey ?? fixtureToken(),
					sessionId: testCase.requestOptions?.sessionId ?? "session-fixture",
				},
			)) {
				// Consume the stream to completion.
			}
			const request = runtime.request?.request as Record<string, unknown>;
			expect(request.input, testCase.name).toEqual([
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
						},
					],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: `continue ${testCase.name}` }],
				},
			]);
		}
	});

	test("does not treat automatic checkpoints as manual compaction markers", async () => {
		const runtime = new FixtureRuntime();
		const compactions = new CodexCompactionStore();
		const connection = createProviderConnection(model, { apiKey: fixtureToken() });
		const identity = providerCompactionIdentityFromValues({
			sessionId: "session-fixture",
			model,
			connection,
		});
		if (identity === undefined) throw new Error("fixture identity unavailable");
		compactions.setAutomatic(
			"session-fixture",
			createCodexAutoCompactionCheckpoint(identity, "checkpoint-fixture", "covered-entry-fixture", [
				{ type: "compaction", encrypted_content: "synthetic-opaque-content" },
			]),
		);
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			compactions,
		);
		const marker =
			"The conversation history before this point was compacted into the following summary:\n\n<summary>\n</summary>";
		for await (const _event of streamSimple(
			model,
			{
				messages: [{ role: "user", content: marker, timestamp: 1 }],
			},
			{ apiKey: fixtureToken(), sessionId: "session-fixture" },
		)) {
			// Consume the stream to completion.
		}
		const request = runtime.request?.request as Record<string, unknown>;
		expect(request.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: marker }],
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

	test("maps retryable BridgeRemoteError to a Pi-compatible assistant error without retrying", async () => {
		const runtime = new FixtureRuntime();
		const secretSource = "upstream body contains fixture-secret-token";
		runtime.throwOnCreate = new BridgeRemoteError({
			category: "NativeToolError",
			code: "openai_request_failed",
			message: secretSource,
			retryable: true,
		});
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
		);
		const events = [];
		for await (const event of streamSimple(model, context, {
			apiKey: fixtureToken(),
			sessionId: "session-fixture",
		})) {
			events.push(event);
		}

		const error = events.at(-1);
		expect(error).toMatchObject({ type: "error", reason: "error" });
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toBe("OpenAI provider service unavailable");
		expect(JSON.stringify(error)).not.toContain("fixture-secret-token");
		expect(JSON.stringify(error)).not.toContain(secretSource);
		expect(runtime.calls).toBe(1);
		expect(
			isRetryableAssistantError({
				stopReason: error.error.stopReason,
				errorMessage: error.error.errorMessage,
			} as AssistantMessage),
		).toBe(true);
	});

	test("does not promote non-retryable BridgeRemoteError messages", async () => {
		const runtime = new FixtureRuntime();
		runtime.throwOnCreate = new BridgeRemoteError({
			category: "NativeToolError",
			code: "openai_request_failed",
			message: "The OpenAI request failed",
			retryable: false,
		});
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
		);
		const events = [];
		for await (const event of streamSimple(model, context, {
			apiKey: fixtureToken(),
			sessionId: "session-fixture",
		})) {
			events.push(event);
		}

		const error = events.at(-1);
		expect(error).toMatchObject({ type: "error", reason: "error" });
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toBe("The OpenAI request failed");
		expect(error.error.errorMessage).not.toBe("OpenAI provider service unavailable");
		expect(runtime.calls).toBe(1);
		expect(
			isRetryableAssistantError({
				stopReason: error.error.stopReason,
				errorMessage: error.error.errorMessage,
			} as AssistantMessage),
		).toBe(false);
	});

	test("does not promote a spoofed ordinary Error as retryable", async () => {
		const runtime = new FixtureRuntime();
		const spoofed = new Error("OpenAI provider service unavailable");
		spoofed.name = "BridgeRemoteError";
		runtime.throwOnCreate = spoofed;
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
		);
		const events = [];
		for await (const event of streamSimple(model, context, {
			apiKey: fixtureToken(),
			sessionId: "session-fixture",
		})) {
			events.push(event);
		}

		const error = events.at(-1);
		expect(error).toMatchObject({ type: "error", reason: "error" });
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toBe("OpenAI Codex request failed");
		expect(runtime.calls).toBe(1);
		expect(
			isRetryableAssistantError({
				stopReason: error.error.stopReason,
				errorMessage: error.error.errorMessage,
			} as AssistantMessage),
		).toBe(false);
	});

	test("preserves abort output without the retry marker", async () => {
		const runtime = new FixtureRuntime();
		runtime.throwOnCreate = new DOMException("The OpenAI Codex request was aborted", "AbortError");
		const streamSimple = createFixtureStream(
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			new CodexCompactionStore(),
		);
		const controller = new AbortController();
		controller.abort();
		const events = [];
		for await (const event of streamSimple(model, context, {
			apiKey: fixtureToken(),
			sessionId: "session-fixture",
			signal: controller.signal,
		})) {
			events.push(event);
		}

		const error = events.at(-1);
		expect(error).toMatchObject({ type: "error", reason: "aborted" });
		if (error?.type !== "error") throw new Error("expected error event");
		expect(error.error.errorMessage).toBe("Request aborted");
		expect(error.error.errorMessage).not.toBe("OpenAI provider service unavailable");
		expect(runtime.calls).toBe(1);
	});
});

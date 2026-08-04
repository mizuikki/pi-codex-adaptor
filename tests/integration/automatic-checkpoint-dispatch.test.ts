import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
	ProviderPayloadCompactionController,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { CodexRuntime, CreateResponseOptions } from "../../src/application/codex-runtime.ts";
import {
	CODEX_REMOTE_COMPACTION_KIND,
	CodexCompactionCoordinator,
	CodexCompactionStore,
} from "../../src/application/compaction.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { BridgeRemoteError } from "../../src/infrastructure/codex-bridge/client.ts";
import { registerCodexCompactionReplay } from "../../src/integration/pi/codex-compaction-replay.ts";
import { createCodexStreamSimple } from "../../src/integration/pi/codex-provider.ts";
import { CodexProviderRequestGuard } from "../../src/integration/pi/codex-provider-request-guard.ts";
import type { BeforeProviderPayloadEventResult } from "../../src/integration/pi/provider-payload-compaction-api.ts";
import { createFakePi, fixtureModel, fixtureToken } from "./helpers/fake-pi.ts";

const SESSION_ID = "synthetic-checkpoint-session";
const COMPACTION_ITEM = {
	type: "compaction",
	encrypted_content: "opaque-synthetic-checkpoint",
} as const;

function usage(totalTokens: number) {
	return {
		input: totalTokens - 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function appendToolTurns(session: SessionManager, model: Model<string>): string[] {
	const callIds: string[] = [];
	for (let index = 1; index <= 4; index += 1) {
		const callId = `synthetic-call-${index}`;
		callIds.push(callId);
		session.appendMessage({
			role: "user",
			content: `synthetic request ${index}`,
			timestamp: index * 10,
		});
		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: callId,
					name: "synthetic_tool",
					arguments: { index },
				},
			],
			usage: usage(index * 25),
			stopReason: "toolUse",
			timestamp: index * 10 + 1,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: callId,
			toolName: "synthetic_tool",
			content: [{ type: "text", text: `${"界".repeat(4_000)}-${index}` }],
			isError: false,
			timestamp: index * 10 + 2,
		});
		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: `synthetic completion ${index}` }],
			usage: usage(index * 25 + 5),
			stopReason: "stop",
			timestamp: index * 10 + 3,
		});
	}
	return callIds;
}

describe("automatic provider checkpoint dispatch", () => {
	test("commits and dispatches the approved payload in the same turn, then replays it", async () => {
		const model = fixtureModel() as Model<string>;
		const session = SessionManager.inMemory("<synthetic-cwd>", { id: SESSION_ID });
		const callIds = appendToolTurns(session, model);
		const canonicalEntries = structuredClone(session.getEntries());
		const settings = SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		});
		const controller = new ProviderPayloadCompactionController(session, settings, {});
		const pi = createFakePi({ token: fixtureToken(), sessionId: SESSION_ID });
		const baseContext = pi.context(model, SESSION_ID);
		const extensionContext = {
			...baseContext,
			sessionManager: session,
			getContextUsage: () => ({ tokens: 20, contextWindow: 1_000, percent: 2 }),
		} as ExtensionContext;
		const config = createDefaultConfig();
		const snapshot = {
			modelTools: [],
			providerSupportsWebsockets: false,
			compaction: { implementation: "compact_endpoint", threshold: 100 },
			shell: { sessionSurface: "official" },
		};
		const compactRequests: unknown[] = [];
		const providerRequests: unknown[] = [];
		const estimateRequests: unknown[] = [];
		let compactFailure: BridgeRemoteError | undefined;
		const runtime = {
			estimateContext: async (options: unknown) => {
				estimateRequests.push(options);
				const index = estimateRequests.length - 1;
				return {
					activeContextTokens: index === 0 ? 90 : index <= 2 ? 90 : index === 3 ? 12 : 200,
					fullEstimatedTokens: index === 0 ? 90 : index <= 2 ? 110 : index === 3 ? 120 : 200,
					suffixEstimatedTokens: 0,
					accountingSource:
						index === 0 || index >= 4
							? ("full_estimate" as const)
							: ("server_usage_plus_suffix" as const),
					autoCompactTokenLimit: null,
					contextWindow: 1_000,
				};
			},
			compact: async (options: { request: unknown }) => {
				compactRequests.push(options.request);
				if (compactFailure !== undefined) throw compactFailure;
				return {
					status: "completed",
					result: {
						output: [COMPACTION_ITEM],
						usage: { inputTokens: 200, outputTokens: 5, cachedInputTokens: 20 },
					},
				};
			},
			createResponse: async (options: CreateResponseOptions) => {
				providerRequests.push(options.request);
				return {
					status: "completed",
					result: {
						responseId: `synthetic-response-${providerRequests.length}`,
						tokenUsage: {
							input_tokens: 10,
							output_tokens: 1,
							cached_input_tokens: 0,
							total_tokens: 11,
						},
					},
				};
			},
		} as unknown as CodexRuntime;
		const configuration = { load: async () => config } as never;
		const activation = new ProviderActivationPolicy(configuration);
		const capabilities = { resolve: async () => snapshot } as never;
		const profile = {
			registeredManagedTools: () => [],
			isHealthy: () => true,
		} as never;
		const guard = new CodexProviderRequestGuard();
		const store = new CodexCompactionStore();
		registerCodexCompactionReplay({
			pi: pi.api,
			runtime,
			configuration,
			activation,
			store,
			coordinator: new CodexCompactionCoordinator(),
			capabilities,
			profile,
			guard,
		});
		const handler = pi.handlers.get("before_provider_payload")?.[0];
		if (handler === undefined)
			throw new Error("before_provider_payload handler was not registered");

		const streamSimple = createCodexStreamSimple(
			runtime,
			configuration,
			activation,
			store,
			capabilities,
			profile,
			guard,
		);
		const runTurn = async (
			swallowHookError = false,
			systemPrompt = "Synthetic system prompt",
		): Promise<Array<{ type: string; error?: { errorMessage?: string } }>> => {
			const signal = new AbortController().signal;
			const context: Context = {
				systemPrompt,
				messages: convertToLlm(session.buildSessionContext().messages),
				tools: [],
			};
			const stream = streamSimple(model, context, {
				apiKey: fixtureToken(),
				sessionId: SESSION_ID,
				signal,
				onPayload: async (payload, payloadModel) => {
					const attribution = controller.createAttribution(payloadModel, "agent", signal);
					try {
						const result = (await handler(
							{
								type: "before_provider_payload",
								model: payloadModel,
								payload,
								attribution,
							},
							extensionContext,
						)) as BeforeProviderPayloadEventResult;
						return controller.commitPayload(payloadModel, result, attribution);
					} catch (error) {
						if (!swallowHookError) throw error;
						return payload;
					}
				},
			});
			const events: Array<{ type: string; error?: { errorMessage?: string } }> = [];
			for await (const event of stream) events.push(event as (typeof events)[number]);
			return events;
		};

		expect((await runTurn()).map((event) => event.type)).toContain("done");
		expect(compactRequests).toHaveLength(0);
		expect(providerRequests).toHaveLength(1);
		session.appendMessage({
			role: "user",
			content: "synthetic threshold continuation",
			timestamp: 89,
		});
		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: "synthetic-threshold-call",
					name: "synthetic_tool",
					arguments: { phase: "threshold" },
				},
			],
			usage: usage(95),
			stopReason: "toolUse",
			timestamp: 90,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "synthetic-threshold-call",
			toolName: "synthetic_tool",
			content: [{ type: "text", text: "synthetic threshold suffix" }],
			isError: false,
			timestamp: 91,
		});
		expect(
			controller.createAttribution(model, "agent", new AbortController().signal).compaction,
		).toBeUndefined();

		const thresholdEvents = await runTurn();
		expect(estimateRequests).toHaveLength(2);
		expect(
			thresholdEvents.find((event) => event.type === "error")?.error?.errorMessage,
		).toStartWith("context_length_exceeded:");
		expect(providerRequests).toHaveLength(1);
		expect(compactRequests).toHaveLength(0);
		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			usage: usage(0),
			stopReason: "error",
			errorMessage: "context_length_exceeded: synthetic local preflight",
			timestamp: 92,
		});

		expect((await runTurn()).map((event) => event.type)).toContain("done");
		expect(compactRequests).toHaveLength(1);
		expect(JSON.stringify(compactRequests[0])).toContain("界".repeat(4_000));
		expect(providerRequests).toHaveLength(2);
		expect((providerRequests[1] as { input?: unknown }).input).toEqual([COMPACTION_ITEM]);
		const checkpoints = session
			.getEntries()
			.filter(
				(entry) => entry.type === "custom" && entry.customType === CODEX_REMOTE_COMPACTION_KIND,
			);
		expect(checkpoints).toHaveLength(1);
		expect(session.getEntries().slice(0, canonicalEntries.length)).toEqual(canonicalEntries);
		const persistedCallIds = session
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [entry.message.toolCallId]
					: [],
			);
		expect(persistedCallIds).toEqual([...callIds, "synthetic-threshold-call"]);

		session.appendMessage({
			role: "user",
			content: "synthetic post-checkpoint continuation",
			timestamp: 93,
		});
		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: "synthetic-post-checkpoint-call",
					name: "synthetic_tool",
					arguments: { phase: "post-checkpoint" },
				},
			],
			usage: usage(12),
			stopReason: "toolUse",
			timestamp: 94,
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "synthetic-post-checkpoint-call",
			toolName: "synthetic_tool",
			content: [{ type: "text", text: "synthetic post-checkpoint suffix" }],
			isError: false,
			timestamp: 95,
		});
		expect((await runTurn()).map((event) => event.type)).toContain("done");
		expect(compactRequests).toHaveLength(1);
		expect(providerRequests).toHaveLength(3);
		expect(estimateRequests[3]).toMatchObject({
			instructions: "Synthetic system prompt",
			baseline: { totalTokens: 11, minimumModelGeneratedIndex: 1 },
		});
		expect((providerRequests[2] as { input?: unknown }).input).toEqual([
			COMPACTION_ITEM,
			expect.objectContaining({ type: "message", role: "user" }),
			expect.objectContaining({ type: "function_call", call_id: "synthetic-post-checkpoint-call" }),
			expect.objectContaining({
				type: "function_call_output",
				call_id: "synthetic-post-checkpoint-call",
			}),
		]);
		expect(
			session
				.getEntries()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === CODEX_REMOTE_COMPACTION_KIND,
				),
		).toHaveLength(1);

		session.appendMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "synthetic completed continuation" }],
			usage: usage(13),
			stopReason: "stop",
			timestamp: 96,
		});
		session.appendMessage({
			role: "user",
			content: "synthetic suffix after checkpoint",
			timestamp: 97,
		});
		compactFailure = new BridgeRemoteError({
			category: "CapabilityError",
			code: "compaction_context_limit_exceeded",
			message: "the compaction request exceeded the local model context limit",
			retryable: false,
		});
		const failedEvents = await runTurn(true, "Changed synthetic system prompt");
		expect(estimateRequests[4]).not.toHaveProperty("baseline");
		const errorEvent = failedEvents.find((event) => event.type === "error");
		expect(errorEvent?.error?.errorMessage).toBe(compactFailure.message);
		expect(providerRequests).toHaveLength(3);
		expect(compactRequests).toHaveLength(2);
		expect(
			session
				.getEntries()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === CODEX_REMOTE_COMPACTION_KIND,
				),
		).toHaveLength(1);

		guard.dispose();
		activation.dispose();
	});
});

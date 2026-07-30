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
			content: [{ type: "text", text: `bounded synthetic result ${index}` }],
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
			getContextUsage: () => ({ tokens: 200, contextWindow: 1_000, percent: 20 }),
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
		const runtime = {
			compact: async (options: { request: unknown }) => {
				compactRequests.push(options.request);
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
		const runTurn = async (): Promise<string[]> => {
			const signal = new AbortController().signal;
			const context: Context = {
				systemPrompt: "Synthetic system prompt",
				messages: convertToLlm(session.buildSessionContext().messages),
				tools: [],
			};
			const stream = streamSimple(model, context, {
				apiKey: fixtureToken(),
				sessionId: SESSION_ID,
				signal,
				onPayload: async (payload, payloadModel) => {
					const attribution = controller.createAttribution(payloadModel, "agent", signal);
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
				},
			});
			const events: string[] = [];
			for await (const event of stream) events.push(event.type);
			return events;
		};

		expect(await runTurn()).toContain("done");
		expect(compactRequests).toHaveLength(1);
		expect(providerRequests).toHaveLength(1);
		expect((providerRequests[0] as { input?: unknown }).input).toEqual([COMPACTION_ITEM]);
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
		expect(persistedCallIds).toEqual(callIds);

		expect(await runTurn()).toContain("done");
		expect(compactRequests).toHaveLength(1);
		expect(providerRequests).toHaveLength(2);
		expect((providerRequests[1] as { input?: unknown }).input).toEqual([COMPACTION_ITEM]);
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

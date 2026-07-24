import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
	buildContextEntries as buildPiContextEntries,
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
	sessionEntryToContextMessages,
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
	createCodexAutoCompactionCheckpoint,
	createCodexCompactionDetails,
	createPortableCompactionDetails,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { ResolveEffectiveCapabilities } from "../../src/application/resolve-effective-capabilities.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import {
	providerCompactionIdentityFromValues,
	registerCodexCompactionReplay,
} from "../../src/integration/pi/codex-compaction-replay.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "../../src/integration/pi/codex-message-normalization.ts";
import {
	createCodexStreamSimple,
	encodeResponseItemSignature,
} from "../../src/integration/pi/codex-provider.ts";
import {
	CodexProviderRequestGuard,
	sha256Hex,
} from "../../src/integration/pi/codex-provider-request-guard.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";
import { createProviderConnection } from "../../src/integration/pi/provider-connection.ts";

const OPAQUE = "synthetic-opaque-content";
const SESSION_ID = "session-replay-fixture";

const model: Model<string> = {
	id: "fixture-model",
	name: "Fixture model",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://invalid.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

function fixtureToken(accountId = "account-fixture"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function configuration(): ConfigurationService {
	const config = createDefaultConfig();
	return { load: async () => config } as ConfigurationService;
}

function profile(): CodexToolProfileCoordinator {
	return {
		readiness: { kind: "healthy", capabilityKey: "fixture-key" },
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

class FixtureRuntime implements CodexRuntime {
	readonly compactRequests: unknown[] = [];
	readonly responseRequests: unknown[] = [];
	compactCalls = 0;
	responseCalls = 0;
	summaryImpl: (() => Promise<SummarizeContextResult>) | undefined;
	compactImpl: ((options: CompactResponseOptions) => Promise<CompactResponseResult>) | undefined;

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.responseCalls += 1;
		this.responseRequests.push(structuredClone(options.request));
		return { status: "completed", result: { responseId: "synthetic-response" } };
	}

	async summarizeContext(): Promise<SummarizeContextResult> {
		if (this.summaryImpl !== undefined) return this.summaryImpl();
		return {
			status: "completed",
			result: { summary: "fixture portable summary" },
		};
	}

	async compact(options: CompactResponseOptions): Promise<CompactResponseResult> {
		this.compactCalls += 1;
		this.compactRequests.push(structuredClone(options.request));
		if (this.compactImpl !== undefined) return this.compactImpl(options);
		return {
			status: "completed",
			result: {
				output: [
					{
						type: "compaction",
						id: "synthetic-compaction-item",
						encrypted_content: OPAQUE,
						internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
					},
				],
			},
		};
	}

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
				"responses_sse",
				"responses_websocket",
				"portable_context_summary",
				"remote_compaction_v2",
				"compact_endpoint",
				"unified_exec",
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
			shellSurface: "unified-exec",
			sessionSurface: "official",
			webSurface: "unsupported",
			imageGenerationSurface: "disabled",
			capabilities: {
				sessions: { status: "available", source: "official" },
				applyPatch: { status: "unavailable", reason: "fixture" },
				viewImage: { status: "unavailable", reason: "fixture" },
				imageGeneration: { status: "unavailable", reason: "fixture" },
				webSearch: { status: "unavailable", reason: "fixture" },
			},
		};
	}

	async executeTool(_options: ExecuteToolOptions): Promise<CreateResponseResult> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

class SessionFixture {
	readonly entries: SessionEntry[] = [];
	readonly byId = new Map<string, SessionEntry>();
	#customEntryIndex = 0;
	#compactionEntryIndex = 0;
	leafId: string | null = null;
	appendThrows = false;
	contextTokens = 95_001;

	constructor() {
		this.appendMessage("user-1", {
			role: "user",
			content: "fixture prompt",
			timestamp: 1,
		});
		this.appendMessage("assistant-1", {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: "call-fixture",
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
		});
		this.appendMessage("tool-1", {
			role: "toolResult",
			toolCallId: "call-fixture",
			toolName: "fixture_tool",
			content: [{ type: "text", text: "fixture output" }],
			isError: false,
			timestamp: 3,
		});
	}

	appendEntry(customType: string, data: unknown): void {
		this.#customEntryIndex += 1;
		const entry: SessionEntry = {
			type: "custom",
			id: `auto-entry-${this.#customEntryIndex}`,
			parentId: this.leafId,
			timestamp: new Date(0).toISOString(),
			customType,
			data,
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (this.appendThrows) throw new Error("synthetic persistence failure");
	}

	appendCompaction(
		details: unknown,
		options: {
			summary?: string;
			firstKeptEntryId?: string;
			retainedTail?: readonly unknown[];
		} = {},
	): void {
		this.#compactionEntryIndex += 1;
		const entry = {
			type: "compaction",
			id: `manual-entry-${this.#compactionEntryIndex}`,
			parentId: this.leafId,
			timestamp: new Date(0).toISOString(),
			summary: options.summary ?? "Synthetic manual compaction",
			firstKeptEntryId: options.firstKeptEntryId ?? "tool-1",
			tokensBefore: 95_001,
			details,
			...(options.retainedTail === undefined ? {} : { retainedTail: options.retainedTail }),
		} as SessionEntry;
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		if (this.appendThrows) throw new Error("synthetic persistence failure");
	}

	appendUser(id: string, content: string): void {
		this.appendMessage(id, { role: "user", content, timestamp: 4 });
	}

	appendToolContinuation(): void {
		this.appendMessage("assistant-after-auto", {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: "call-after-auto",
					name: "fixture_tool",
					arguments: { value: "after-auto" },
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
			timestamp: 5,
		});
		this.appendMessage("tool-after-auto", {
			role: "toolResult",
			toolCallId: "call-after-auto",
			toolName: "fixture_tool",
			content: [{ type: "text", text: "fixture continuation output" }],
			isError: false,
			timestamp: 6,
		});
	}

	appendInterruptedContinuation(): void {
		this.appendMessage("assistant-interrupted", {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: "call-interrupted",
					name: "fixture_tool",
					arguments: { value: "interrupted" },
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
			timestamp: 7,
		});
		this.appendMessage("user-after-interruption", {
			role: "user",
			content: "resume interrupted work",
			timestamp: 8,
		});
	}

	branch(): SessionEntry[] {
		const path: SessionEntry[] = [];
		let current = this.leafId === null ? undefined : this.byId.get(this.leafId);
		while (current !== undefined) {
			path.push(current);
			current = current.parentId === null ? undefined : this.byId.get(current.parentId);
		}
		return path.reverse();
	}

	contextEntries(): SessionEntry[] {
		return buildPiContextEntries(this.entries, this.leafId, this.byId);
	}

	fullActivePath(): SessionEntry[] {
		return this.branch();
	}

	messages(includeLiveTail = true): readonly unknown[] {
		const messages = this.contextEntries().flatMap((entry) => {
			const retainedTail = (entry as SessionEntry & { retainedTail?: unknown }).retainedTail;
			if (
				entry.type === "compaction" &&
				retainedTail !== undefined &&
				!Array.isArray(retainedTail)
			) {
				// Keep fixture projection tolerant so malformed retained-tail entries still reach
				// the adaptor classifier instead of crashing Pi's summary projector.
				const { retainedTail: _ignored, ...rest } = entry as SessionEntry & {
					retainedTail?: unknown;
				};
				return sessionEntryToContextMessages(rest as SessionEntry);
			}
			return sessionEntryToContextMessages(entry);
		});
		if (!includeLiveTail) return messages;
		return [
			...messages,
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
							call_id: "call-fixture",
							output: { marker: "live-suffix" },
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
		];
	}

	private appendMessage(id: string, message: unknown): void {
		const entry: SessionEntry = {
			type: "message",
			id,
			parentId: this.leafId,
			timestamp: new Date(0).toISOString(),
			message: message as never,
		};
		this.entries.push(entry);
		this.byId.set(id, entry);
		this.leafId = id;
	}
}

function toolResultMessage() {
	return {
		role: "toolResult",
		toolCallId: "call-fixture",
		toolName: "fixture_tool",
		content: [{ type: "text", text: "fixture output" }],
		isError: false,
		timestamp: 3,
	};
}

function makeContext(session: SessionFixture, signal: AbortSignal): ExtensionContext {
	return {
		model,
		signal,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getBranch: () => session.branch(),
			getFullActivePathSnapshot: () => session.fullActivePath(),
			buildContextEntries: () => session.contextEntries(),
			getLeafId: () => session.leafId,
			getLeafEntry: () => (session.leafId === null ? undefined : session.byId.get(session.leafId)),
		},
		getContextUsage: () => ({
			tokens: session.contextTokens,
			contextWindow: 100_000,
			percent: session.contextTokens / 1_000,
		}),
		getSystemPrompt: () => "synthetic system",
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: fixtureToken(), headers: {} }),
		},
	} as unknown as ExtensionContext;
}

interface Harness {
	run(
		includeLiveTail?: boolean,
		onPayloadTail?: (payload: Record<string, unknown>) => unknown,
		attribution?: {
			origin: "agent" | "compaction_summary" | "branch_summary";
			sessionId: string;
			candidateRetainedTail?: readonly unknown[];
			includeCompactionToken?: boolean;
		},
	): Promise<unknown[]>;
	runtime: FixtureRuntime;
	session: SessionFixture;
	store: CodexCompactionStore;
	coordinator: CodexCompactionCoordinator;
	guard: CodexProviderRequestGuard;
}

function harness(options: { session?: SessionFixture } = {}): Harness {
	const runtime = new FixtureRuntime();
	const service = configuration();
	const activation = new ProviderActivationPolicy(service);
	const store = new CodexCompactionStore();
	const coordinator = new CodexCompactionCoordinator();
	const capabilities = new ResolveEffectiveCapabilities(runtime);
	const guard = new CodexProviderRequestGuard();
	const session = options.session ?? new SessionFixture();
	let hook:
		| ((
				event: {
					type: "before_provider_payload";
					model: typeof model;
					payload: unknown;
					attribution: {
						sessionId: string;
						origin: "agent" | "compaction_summary" | "branch_summary";
						signal: AbortSignal;
						compaction?: {
							token: object;
							candidateLeafId: string;
							candidateRetainedTail: readonly unknown[];
						};
					};
				},
				ctx: ExtensionContext,
		  ) => unknown)
		| undefined;
	const pi = {
		on: (event: string, handler: typeof hook) => {
			if (event === "before_provider_payload") hook = handler;
		},
	} as never;
	registerCodexCompactionReplay({
		pi,
		runtime,
		configuration: service,
		activation,
		store,
		coordinator,
		capabilities,
		profile: profile(),
		guard,
	});
	return {
		runtime,
		session,
		store,
		coordinator,
		guard,
		run: async (includeLiveTail = true, onPayloadTail, attribution) => {
			const signal = new AbortController().signal;
			const ctx = makeContext(session, signal);
			const streamSimple = createCodexStreamSimple(
				runtime,
				service,
				activation,
				store,
				capabilities,
				profile(),
				guard,
			);
			const stream = streamSimple(
				model,
				{
					systemPrompt: "synthetic system",
					messages: convertToLlm(
						session.messages(includeLiveTail) as Parameters<typeof convertToLlm>[0],
					),
					tools: [],
				} as unknown as Context,
				{
					apiKey: fixtureToken(),
					sessionId: SESSION_ID,
					signal,
					onPayload: async (payload) => {
						if (hook === undefined) throw new Error("synthetic hook was not registered");
						const payloadAttribution = {
							sessionId: attribution?.sessionId ?? SESSION_ID,
							origin: attribution?.origin ?? "agent",
							signal,
							...((attribution?.origin ?? "agent") !== "agent" ||
							attribution?.includeCompactionToken === false
								? {}
								: {
										compaction: {
											token: {},
											candidateLeafId: session.leafId ?? "tool-1",
											candidateRetainedTail: attribution?.candidateRetainedTail ?? [],
										},
									}),
						};
						const transformed = (await hook(
							{
								type: "before_provider_payload",
								model,
								payload,
								attribution: payloadAttribution,
							},
							ctx,
						)) as {
							payload: unknown;
							compaction?: { summary: string; tokensBefore: number; details?: unknown };
						};
						const committedPayload = transformed.payload;
						if (transformed.compaction !== undefined) {
							try {
								session.appendCompaction(transformed.compaction.details, {
									summary: transformed.compaction.summary,
									...(payloadAttribution.compaction?.candidateLeafId === undefined
										? {}
										: { firstKeptEntryId: payloadAttribution.compaction.candidateLeafId }),
									// Persist an explicit array so v3 readback always has a structural tail.
									retainedTail: payloadAttribution.compaction?.candidateRetainedTail ?? [],
								});
								store.setManual(
									SESSION_ID,
									transformed.compaction.summary,
									transformed.compaction.details as never,
									session.leafId ?? undefined,
								);
							} catch (error) {
								store.markReplayInvalid(SESSION_ID);
								throw error;
							}
						}
						return onPayloadTail === undefined
							? committedPayload
							: onPayloadTail(committedPayload as Record<string, unknown>);
					},
				},
			);
			const events: unknown[] = [];
			for await (const event of stream) events.push(event);
			return events;
		},
	};
}

test("leaves Pi-native fallback payloads unchanged without an adaptor request record", async () => {
	const runtime = new FixtureRuntime();
	const service = configuration();
	const activation = new ProviderActivationPolicy(service);
	const store = new CodexCompactionStore();
	const coordinator = new CodexCompactionCoordinator();
	const capabilities = new ResolveEffectiveCapabilities(runtime);
	const guard = new CodexProviderRequestGuard();
	let handler: ((event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>) | undefined;
	registerCodexCompactionReplay({
		pi: {
			on: (_event: string, callback: typeof handler) => {
				handler = callback;
			},
		} as never,
		runtime,
		configuration: service,
		activation,
		store,
		coordinator,
		capabilities,
		profile: profile(),
		guard,
	});
	if (handler === undefined) throw new Error("fallback hook was not registered");
	const payload = { model: "native-model", input: [] };
	const result = await handler(
		{
			type: "before_provider_payload",
			model,
			payload,
			attribution: {
				sessionId: "native-session",
				origin: "agent",
				signal: new AbortController().signal,
			},
		},
		{
			model: { ...model, provider: "unselected-provider", api: "openai-responses" },
			sessionManager: { getSessionId: () => "native-session" },
		} as unknown as ExtensionContext,
	);
	expect(result).toEqual({ payload });
});

describe("active-branch Codex compaction replay", () => {
	test("batches cross-entry call/result pairs without introducing a duplicate output", async () => {
		const value = harness();
		value.session.contextTokens = 1_000;
		const events = await value.run(false);

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(1);
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "fixture prompt" }],
			},
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: '{"value":"synthetic"}',
				call_id: "call-fixture",
			},
			{ type: "function_call_output", call_id: "call-fixture", output: "fixture output" },
		]);
	});

	test("keeps interrupted provider-ledger and active-branch projections structurally equal", async () => {
		const session = new SessionFixture();
		session.appendInterruptedContinuation();
		session.contextTokens = 1_000;
		const value = harness({ session });
		const events = await value.run(false);

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(1);
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input.slice(-3)).toEqual([
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: '{"value":"interrupted"}',
				call_id: "call-interrupted",
			},
			{
				type: "function_call_output",
				call_id: "call-interrupted",
				output: INTERRUPTED_TOOL_RESULT_TEXT,
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "resume interrupted work" }],
			},
		]);
	});

	test("approves attributed auxiliary payloads unchanged without automatic checkpoint replay", async () => {
		for (const origin of ["compaction_summary", "branch_summary"] as const) {
			const value = harness();
			const events = await value.run(true, undefined, { origin, sessionId: SESSION_ID });

			expect(events.at(-1), origin).toMatchObject({ type: "done" });
			expect(value.runtime.compactCalls, origin).toBe(0);
			expect(value.runtime.responseCalls, origin).toBe(1);
			expect(
				value.session.entries.map((entry) => entry.type),
				origin,
			).toEqual(["message", "message", "message"]);
			expect(value.store.getForSession(SESSION_ID), origin).toBeUndefined();
			expect(value.guard.activeRecordCount, origin).toBe(0);
		}
	});

	test("rejects attributed requests whose event session does not match the provider route", async () => {
		const value = harness();
		const events = await value.run(true, undefined, {
			origin: "compaction_summary",
			sessionId: "mismatched-session",
		});

		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(0);
		expect(value.store.getForSession(SESSION_ID)).toBeUndefined();
		expect(value.guard.activeRecordCount).toBe(0);
	});

	test("treats an ordinary Pi compaction as portable context instead of a blocked checkpoint", async () => {
		const session = new SessionFixture();
		session.appendCompaction(undefined);
		session.appendUser("user-after-portable", "continue after the portable checkpoint");
		session.contextTokens = 1_000;
		const value = harness({ session });
		const events = await value.run(false);

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(1);
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: expect.stringContaining("Synthetic manual compaction"),
					},
				],
			},
			{
				type: "function_call_output",
				call_id: "call-fixture",
				output: "fixture output",
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "continue after the portable checkpoint" }],
			},
		]);
	});

	test("treats non-adaptor compaction details as a portable boundary", async () => {
		const session = new SessionFixture();
		session.appendCompaction({ kind: "fixture.other-extension", version: 1 });
		session.contextTokens = 1_000;
		const value = harness({ session });
		const events = await value.run(false);

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(1);
	});

	test.each([
		{
			name: "ordinary Pi compaction -> portable request boundary",
			run: async () => {
				const session = new SessionFixture();
				session.appendCompaction(undefined);
				session.appendUser("user-after-portable", "continue after the portable checkpoint");
				session.contextTokens = 1_000;
				const value = harness({ session });
				const events = await value.run(false);
				return {
					lastEvent: events.at(-1),
					compactCalls: value.runtime.compactCalls,
					firstInputType: (value.runtime.responseRequests[0] as { input: Array<{ type: string }> })
						.input[0]?.type,
				};
			},
			expected: { compactCalls: 0, firstInputType: "message" },
		},
		{
			name: "matching v3 compaction -> opaque replay after reload",
			run: async () => {
				const connection = createProviderConnection(model, { apiKey: fixtureToken() });
				const identity = providerCompactionIdentityFromValues({
					sessionId: SESSION_ID,
					model,
					connection,
				});
				if (identity === undefined) throw new Error("fixture identity unavailable");
				const details = createPortableCompactionDetails(sha256Hex("reloaded summary"), {
					identity,
					output: [{ type: "compaction", encrypted_content: OPAQUE }],
				});
				const session = new SessionFixture();
				session.appendCompaction(details, {
					summary: "reloaded summary",
					retainedTail: [toolResultMessage()],
				});
				session.contextTokens = 1_000;
				const value = harness({ session });
				value.store.setManual(SESSION_ID, "reloaded summary", details, session.leafId ?? undefined);
				const events = await value.run(false);
				return {
					lastEvent: events.at(-1),
					compactCalls: value.runtime.compactCalls,
					firstInputType: (value.runtime.responseRequests[0] as { input: Array<{ type: string }> })
						.input[0]?.type,
				};
			},
			expected: { compactCalls: 0, firstInputType: "compaction" },
		},
		{
			name: "legacy opaque mismatch -> migration commit before dispatch",
			run: async () => {
				const session = new SessionFixture();
				const legacyIdentity = providerCompactionIdentityFromValues({
					sessionId: SESSION_ID,
					model,
					connection: createProviderConnection(model, { apiKey: fixtureToken("legacy-account") }),
				});
				if (legacyIdentity === undefined) throw new Error("fixture identity unavailable");
				session.appendCompaction(
					createCodexCompactionDetails(legacyIdentity, [
						{ type: "compaction", encrypted_content: "legacy-manual-opaque" },
					]),
				);
				session.contextTokens = 1_000;
				const value = harness({ session });
				const events = await value.run(false, undefined, {
					origin: "agent",
					sessionId: SESSION_ID,
					candidateRetainedTail: [toolResultMessage()],
				});
				return {
					lastEvent: events.at(-1),
					compactCalls: value.runtime.compactCalls,
					lastEntryType: value.session.entries.at(-1)?.type,
				};
			},
			expected: { compactCalls: 1, lastEntryType: "compaction" },
		},
		{
			name: "provider_inline -> real compaction entry and same-run continuation",
			run: async () => {
				const value = harness();
				const events = await value.run(true, undefined, { origin: "agent", sessionId: SESSION_ID });
				return {
					lastEvent: events.at(-1),
					compactCalls: value.runtime.compactCalls,
					lastEntryType: value.session.entries.at(-1)?.type,
				};
			},
			expected: { compactCalls: 1, lastEntryType: "compaction" },
		},
	])("covers Section 7.3 row: $name", async ({ run, expected }) => {
		const result = await run();
		expect(result.lastEvent).toMatchObject({ type: "done" });
		for (const [key, value] of Object.entries(expected)) {
			expect(result).toHaveProperty(key, value);
		}
	});

	test("migrates a legacy automatic checkpoint on identity change before dispatch", async () => {
		const session = new SessionFixture();
		const legacyIdentity = providerCompactionIdentityFromValues({
			sessionId: SESSION_ID,
			model,
			connection: createProviderConnection(model, { apiKey: fixtureToken("legacy-account") }),
		});
		if (legacyIdentity === undefined) throw new Error("fixture identity unavailable");
		session.appendEntry(
			"pi-codex-adaptor.auto-compaction",
			createCodexAutoCompactionCheckpoint(legacyIdentity, "legacy-checkpoint", "tool-1", [
				{ type: "compaction", encrypted_content: "legacy-opaque" },
			]),
		);
		session.contextTokens = 1_000;
		const value = harness({ session });
		const events = await value.run(false, undefined, {
			origin: "agent",
			sessionId: SESSION_ID,
			candidateRetainedTail: [toolResultMessage()],
		});

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		expect(value.session.entries.at(-1)).toMatchObject({
			type: "compaction",
			summary: "fixture portable summary",
		});
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
			{
				type: "function_call_output",
				call_id: "call-fixture",
				output: "fixture output",
			},
		]);
	});

	test("replays a legacy automatic checkpoint on exact identity without migrating", async () => {
		const session = new SessionFixture();
		const connection = createProviderConnection(model, { apiKey: fixtureToken() });
		const identity = providerCompactionIdentityFromValues({
			sessionId: SESSION_ID,
			model,
			connection,
		});
		if (identity === undefined) throw new Error("fixture identity unavailable");
		const checkpoint = createCodexAutoCompactionCheckpoint(
			identity,
			"legacy-checkpoint",
			"tool-1",
			[{ type: "compaction", encrypted_content: "legacy-opaque" }],
		);
		session.appendEntry("pi-codex-adaptor.auto-compaction", checkpoint);
		session.contextTokens = 1_000;
		const value = harness({ session });
		value.store.setAutomatic(SESSION_ID, checkpoint, session.leafId ?? undefined);
		const events = await value.run(false);

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(1);
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{ type: "compaction", encrypted_content: "legacy-opaque" },
		]);
	});

	test("migrates a legacy manual opaque checkpoint on identity change before dispatch", async () => {
		const session = new SessionFixture();
		const legacyIdentity = providerCompactionIdentityFromValues({
			sessionId: SESSION_ID,
			model,
			connection: createProviderConnection(model, { apiKey: fixtureToken("legacy-account") }),
		});
		if (legacyIdentity === undefined) throw new Error("fixture identity unavailable");
		session.appendCompaction(
			createCodexCompactionDetails(legacyIdentity, [
				{ type: "compaction", encrypted_content: "legacy-manual-opaque" },
			]),
		);
		session.contextTokens = 1_000;
		const value = harness({ session });
		const events = await value.run(false, undefined, {
			origin: "agent",
			sessionId: SESSION_ID,
			candidateRetainedTail: [toolResultMessage()],
		});

		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		expect(value.session.entries.at(-1)).toMatchObject({
			type: "compaction",
			summary: "fixture portable summary",
		});
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
			{
				type: "function_call_output",
				call_id: "call-fixture",
				output: "fixture output",
			},
		]);
	});

	test("fails closed when legacy migration has no Pi commit token", async () => {
		const session = new SessionFixture();
		const legacyIdentity = providerCompactionIdentityFromValues({
			sessionId: SESSION_ID,
			model,
			connection: createProviderConnection(model, { apiKey: fixtureToken("legacy-account") }),
		});
		if (legacyIdentity === undefined) throw new Error("fixture identity unavailable");
		session.appendCompaction(
			createCodexCompactionDetails(legacyIdentity, [
				{ type: "compaction", encrypted_content: "legacy-manual-opaque" },
			]),
		);
		session.contextTokens = 1_000;
		const value = harness({ session });
		const events = await value.run(false, undefined, {
			origin: "agent",
			sessionId: SESSION_ID,
			includeCompactionToken: false,
		});

		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(value.runtime.compactCalls).toBe(0);
		expect(value.runtime.responseCalls).toBe(0);
	});

	test("compacts inline before the request, appends a real compaction entry, and naturally continues", async () => {
		const value = harness();
		const events = await value.run(true, undefined, { origin: "agent", sessionId: SESSION_ID });
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		expect(value.session.entries.map((entry) => entry.type)).toEqual([
			"message",
			"message",
			"message",
			"compaction",
		]);
		const checkpoint = value.session.entries.at(-1);
		expect(checkpoint).toMatchObject({
			type: "compaction",
			parentId: "tool-1",
		});
		expect(value.store.getForSession(SESSION_ID)?.source).toBe("manual");
		const compactRequest = value.runtime.compactRequests[0] as { input: readonly unknown[] };
		const responseRequest = value.runtime.responseRequests[0] as { input: readonly unknown[] };
		expect(compactRequest.input.at(-1)).toEqual({
			type: "function_call_output",
			call_id: "call-fixture",
			output: "fixture output",
		});
		expect(responseRequest.input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
			{
				type: "custom_tool_call_output",
				call_id: "call-fixture",
				output: { marker: "live-suffix" },
			},
		]);
	});

	test("validates a token-bound retained tail and preserves the in-flight suffix after the paired commit", async () => {
		const value = harness();
		const retainedTail = [toolResultMessage()];
		const events = await value.run(true, undefined, {
			origin: "agent",
			sessionId: SESSION_ID,
			candidateRetainedTail: retainedTail,
		});
		expect(events.at(-1)).toMatchObject({ type: "done" });
		const checkpoint =
			value.session.leafId === null ? undefined : value.session.byId.get(value.session.leafId);
		expect(checkpoint).toMatchObject({ type: "compaction" });
		expect((checkpoint as unknown as Record<string, unknown>).retainedTail).toEqual(retainedTail);
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
			{
				type: "function_call_output",
				call_id: "call-fixture",
				output: "fixture output",
			},
			{
				type: "custom_tool_call_output",
				call_id: "call-fixture",
				output: { marker: "live-suffix" },
			},
		]);
	});

	test("rewrites the active request with a portable summary when opaque compaction fails", async () => {
		const value = harness();
		value.runtime.compactImpl = async () => ({ status: "failed" });
		const events = await value.run(true, undefined, { origin: "agent", sessionId: SESSION_ID });
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		const request = value.runtime.responseRequests[0] as { input: unknown[] };
		expect(request.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: expect.stringContaining("fixture portable summary"),
					},
				],
			},
			{
				type: "custom_tool_call_output",
				call_id: "call-fixture",
				output: { marker: "live-suffix" },
			},
		]);
	});

	test("observes an early compact rejection while portable summarization is pending", async () => {
		const value = harness();
		let releaseSummary!: () => void;
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		value.runtime.summaryImpl = async () => {
			await summaryReleased;
			return { status: "completed", result: { summary: "fixture portable summary" } };
		};
		value.runtime.compactImpl = async () => {
			throw new Error("synthetic compact failure");
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const pending = value.run(true);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			releaseSummary();
			const events = await pending;
			expect(events.at(-1)).toMatchObject({ type: "done" });
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("compacts branch-backed input when Pi includes the current turn in context entries", async () => {
		const value = harness();
		const events = await value.run(false);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		expect(value.session.entries.at(-1)).toMatchObject({
			type: "compaction",
			parentId: "tool-1",
		});
		expect((value.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
		]);
	});

	test("replays the checkpoint on the next high-usage request without compacting identical input again", async () => {
		const value = harness();
		await value.run(true);
		const events = await value.run(false);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(2);
		const replayInput = (value.runtime.responseRequests[1] as { input: unknown[] }).input;
		expect(replayInput[0]).toEqual({
			type: "compaction",
			id: "synthetic-compaction-item",
			encrypted_content: OPAQUE,
			internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
		});
		expect(
			replayInput.filter((item) => (item as { type?: unknown }).type === "compaction"),
		).toHaveLength(1);
	});

	test("reloads or forks a real compaction entry without creating a second inline compaction", async () => {
		const original = harness();
		await original.run(true);
		const stored = original.store.getForSession(SESSION_ID);
		const entry =
			original.session.leafId === null
				? undefined
				: original.session.byId.get(original.session.leafId);
		if (stored?.source !== "manual" || entry?.type !== "compaction") {
			throw new Error("automatic checkpoint was not installed");
		}

		const reloadedSession = new SessionFixture();
		const retainedTail =
			"retainedTail" in entry
				? ((entry as unknown as Record<string, unknown>).retainedTail as
						| readonly unknown[]
						| undefined)
				: undefined;
		reloadedSession.appendCompaction(stored.details, {
			summary: stored.summary,
			...(retainedTail === undefined ? {} : { retainedTail }),
		});
		reloadedSession.contextTokens = 1_000;
		const reloaded = harness({ session: reloadedSession });
		reloaded.store.setManual(SESSION_ID, stored.summary, stored.details, stored.entryId);

		const events = await reloaded.run(false);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(reloaded.runtime.compactCalls).toBe(0);
		const reloadInput = (reloaded.runtime.responseRequests[0] as { input: unknown[] }).input;
		expect(reloadInput[0]).toEqual({
			type: "compaction",
			id: "synthetic-compaction-item",
			encrypted_content: OPAQUE,
			internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
		});
		expect(
			reloadInput.filter((item) => (item as { type?: unknown }).type === "compaction"),
		).toHaveLength(1);
	});

	test("poisons replay after an indeterminate append and blocks later Responses dispatch", async () => {
		const value = harness();
		value.session.appendThrows = true;
		const first = await value.run(true);
		expect(first.at(-1)).toMatchObject({ type: "error" });
		expect(value.store.isReplayInvalid(SESSION_ID)).toBe(true);
		expect(value.runtime.responseCalls).toBe(0);
		value.session.appendThrows = false;
		const second = await value.run(false);
		expect(second.at(-1)).toMatchObject({ type: "error" });
		expect(value.runtime.responseCalls).toBe(0);
	});

	test("rejects a late compact completion after the request lease is invalidated", async () => {
		const value = harness();
		let releaseCompact!: () => void;
		let signalCompactStarted!: () => void;
		const compactStarted = new Promise<void>((resolve) => {
			signalCompactStarted = resolve;
		});
		const compactReleased = new Promise<void>((resolve) => {
			releaseCompact = resolve;
		});
		value.runtime.compactImpl = async () => {
			signalCompactStarted();
			await compactReleased;
			return {
				status: "completed",
				result: {
					output: [{ type: "compaction", encrypted_content: OPAQUE }],
				},
			};
		};
		const pending = value.run(true);
		await compactStarted;
		value.guard.invalidateSession(SESSION_ID);
		releaseCompact();
		const events = await pending;
		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(value.session.entries.some((entry) => entry.type === "custom")).toBe(false);
		expect(value.runtime.responseCalls).toBe(0);
		expect(value.store.isReplayInvalid(SESSION_ID)).toBe(false);
	});

	test("rejects malformed checkpoints and identity conflicts before compact or Responses", async () => {
		const malformed = new SessionFixture();
		malformed.appendEntry("pi-codex-adaptor.auto-compaction", {
			kind: "pi-codex-adaptor.auto-compaction",
			version: 1,
		});
		const malformedValue = harness({ session: malformed });
		const malformedEvents = await malformedValue.run(false);
		expect(malformedEvents.at(-1)).toMatchObject({ type: "error" });
		expect(malformedValue.runtime.compactCalls).toBe(0);
		expect(malformedValue.runtime.responseCalls).toBe(0);

		const badSummaryDigest = new SessionFixture();
		badSummaryDigest.appendCompaction(
			{
				...createPortableCompactionDetails(sha256Hex("Synthetic manual compaction")),
				portable: { summarySha256: "0".repeat(64) },
			},
			{
				summary: "Synthetic manual compaction",
				retainedTail: [toolResultMessage()],
			},
		);
		badSummaryDigest.contextTokens = 1_000;
		const badSummaryDigestValue = harness({ session: badSummaryDigest });
		const badSummaryDigestEvents = await badSummaryDigestValue.run(false);
		expect(badSummaryDigestEvents.at(-1)).toMatchObject({ type: "error" });
		expect(badSummaryDigestValue.runtime.responseCalls).toBe(0);

		const badRetainedTail = new SessionFixture();
		badRetainedTail.appendCompaction(
			createPortableCompactionDetails(sha256Hex("Synthetic manual compaction")),
			{
				summary: "Synthetic manual compaction",
				retainedTail: {} as never,
			},
		);
		badRetainedTail.contextTokens = 1_000;
		const badRetainedTailValue = harness({ session: badRetainedTail });
		const badRetainedTailEvents = await badRetainedTailValue.run(false);
		expect(badRetainedTailEvents.at(-1)).toMatchObject({ type: "error" });
		expect(badRetainedTailValue.runtime.responseCalls).toBe(0);

		const conflicting = harness();
		const result = await conflicting.run(true, (payload) => ({ ...payload, model: "other-model" }));
		expect(result.at(-1)).toMatchObject({ type: "error" });
		expect(conflicting.runtime.responseCalls).toBe(0);
	});

	test("blocks later replacement but permits a swallowed unchanged hook exception", async () => {
		const replacement = harness();
		const replaced = await replacement.run(true, (payload) => ({ ...payload, input: [] }));
		expect(replaced.at(-1)).toMatchObject({ type: "error" });
		expect(replacement.runtime.responseCalls).toBe(0);

		const unchanged = harness();
		const unchangedEvents = await unchanged.run(true, (payload) => {
			try {
				throw new Error("synthetic later-hook failure");
			} catch {
				return payload;
			}
		});
		expect(unchangedEvents.at(-1)).toMatchObject({ type: "done" });
		expect(unchanged.runtime.responseCalls).toBe(1);
	});

	test("preserves an exact response-item envelope through Pi message conversion", () => {
		const item = {
			type: "function_call",
			id: "item-id",
			namespace: "fixture",
			name: "tool",
			arguments: '{  "value": 1 }',
			call_id: "call-id",
			internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
		};
		const signature = encodeResponseItemSignature(item);
		expect(signature).toContain("pi-codex-adaptor.response-item");
	});
});

describe("branch projection", () => {
	test("uses Pi's public context entry projection for message-bearing entries", () => {
		const session = new SessionFixture();
		const entries = session.contextEntries();
		const messages = entries.flatMap(sessionEntryToContextMessages);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	test("does not carry credentials or opaque content in a safe error", async () => {
		const value = harness();
		const events = await value.run(true, (payload) => ({ ...payload, input: "invalid" }));
		const serialized = JSON.stringify(events.at(-1));
		expect(serialized).not.toContain(OPAQUE);
		expect(serialized).not.toContain("synthetic-credential");
	});
});

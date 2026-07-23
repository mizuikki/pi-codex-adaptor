import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
	type BeforeProviderRequestEvent,
	buildContextEntries as buildPiContextEntries,
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

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
	createCodexCompactionDetails,
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
import { CodexProviderRequestGuard } from "../../src/integration/pi/codex-provider-request-guard.ts";
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
	compactImpl: ((options: CompactResponseOptions) => Promise<CreateResponseResult>) | undefined;

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.responseCalls += 1;
		this.responseRequests.push(structuredClone(options.request));
		return { status: "completed", result: { responseId: "synthetic-response" } };
	}

	async compact(options: CompactResponseOptions): Promise<CreateResponseResult> {
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

	appendCompaction(details: unknown): void {
		const entry: SessionEntry = {
			type: "compaction",
			id: "manual-entry-1",
			parentId: this.leafId,
			timestamp: new Date(0).toISOString(),
			summary: "Synthetic manual compaction",
			firstKeptEntryId: "tool-1",
			tokensBefore: 95_001,
			details,
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
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

	messages(includeLiveTail = true): readonly unknown[] {
		const messages = this.contextEntries().flatMap((entry) => sessionEntryToContextMessages(entry));
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

function makeContext(session: SessionFixture, signal: AbortSignal): ExtensionContext {
	return {
		model,
		signal,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getBranch: () => session.branch(),
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
					type: "before_provider_request";
					payload: unknown;
					origin?: "agent" | "compaction_summary" | "branch_summary";
					sessionId?: string;
				},
				ctx: ExtensionContext,
		  ) => unknown)
		| undefined;
	const pi = {
		on: (event: string, handler: typeof hook) => {
			if (event === "before_provider_request") hook = handler;
		},
		appendEntry: (customType: string, data: unknown) => session.appendEntry(customType, data),
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
						const transformed = await hook(
							{
								type: "before_provider_request",
								payload,
								...attribution,
							},
							ctx,
						);
						return onPayloadTail === undefined
							? transformed
							: onPayloadTail(transformed as Record<string, unknown>);
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
	let handler:
		| ((event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown | Promise<unknown>)
		| undefined;
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
	const result = await handler({ type: "before_provider_request", payload }, {
		model: { ...model, provider: "unselected-provider", api: "openai-responses" },
		sessionManager: { getSessionId: () => "native-session" },
	} as unknown as ExtensionContext);
	expect(result).toBe(payload);
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

	test("compacts inline before the request, appends a custom checkpoint, and naturally continues", async () => {
		const value = harness();
		const events = await value.run(true, undefined, { origin: "agent", sessionId: SESSION_ID });
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		expect(value.session.entries.map((entry) => entry.type)).toEqual([
			"message",
			"message",
			"message",
			"custom",
		]);
		const checkpoint = value.session.entries.at(-1);
		expect(checkpoint).toMatchObject({
			type: "custom",
			parentId: "tool-1",
			customType: "pi-codex-adaptor.auto-compaction",
		});
		expect(value.store.getForSession(SESSION_ID)?.source).toBe("automatic");
		const compactRequest = value.runtime.compactRequests[0] as { input: readonly unknown[] };
		const responseRequest = value.runtime.responseRequests[0] as { input: readonly unknown[] };
		expect(compactRequest.input.at(-1)).toEqual({
			type: "custom_tool_call_output",
			call_id: "call-fixture",
			output: { marker: "live-suffix" },
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

	test("compacts branch-backed input when Pi includes the current turn in context entries", async () => {
		const value = harness();
		const events = await value.run(false);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.runtime.responseCalls).toBe(1);
		expect(value.session.entries.at(-1)).toMatchObject({
			type: "custom",
			parentId: "tool-1",
			customType: "pi-codex-adaptor.auto-compaction",
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
		expect((value.runtime.responseRequests[1] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
		]);
	});

	test("continues automatic compaction after an earlier manual compaction and reloads it", async () => {
		const session = new SessionFixture();
		const value = harness({ session });
		const connection = createProviderConnection(model, { apiKey: fixtureToken() });
		const identity = providerCompactionIdentityFromValues({
			sessionId: SESSION_ID,
			model,
			connection,
		});
		if (identity === undefined) throw new Error("fixture identity unavailable");
		const manualOutput = [{ type: "compaction", encrypted_content: "synthetic-manual-opaque" }];
		const manualDetails = createCodexCompactionDetails(identity, manualOutput);
		session.appendCompaction(manualDetails);
		session.appendUser("user-after-manual", "continue after the manual checkpoint");
		value.store.setManual(
			SESSION_ID,
			"Synthetic manual compaction",
			manualDetails,
			"manual-entry-1",
		);

		const first = await value.run(true);
		expect(first.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(1);
		expect(value.store.getForSession(SESSION_ID)?.source).toBe("automatic");

		session.appendToolContinuation();
		const second = await value.run(false);

		expect(second.at(-1)).toMatchObject({ type: "done" });
		expect(value.runtime.compactCalls).toBe(2);
		expect(value.runtime.responseCalls).toBe(2);
		expect((value.runtime.responseRequests[1] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
			{
				type: "function_call",
				name: "fixture_tool",
				arguments: '{"value":"after-auto"}',
				call_id: "call-after-auto",
			},
			{
				type: "function_call_output",
				call_id: "call-after-auto",
				output: "fixture continuation output",
			},
		]);

		const automatic = value.store.getForSession(SESSION_ID);
		if (automatic?.source !== "automatic") {
			throw new Error("automatic checkpoint was not installed");
		}
		const reloaded = harness({ session });
		reloaded.store.setAutomatic(SESSION_ID, automatic.checkpoint, automatic.entryId);
		session.contextTokens = 1_000;
		const resumed = await reloaded.run(false);

		expect(resumed.at(-1)).toMatchObject({ type: "done" });
		expect(reloaded.runtime.compactCalls).toBe(0);
		expect((reloaded.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{
				type: "compaction",
				id: "synthetic-compaction-item",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
		]);
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

	test("recomputes the active branch on reload/fork and lets a later manual checkpoint supersede auto", async () => {
		const original = harness();
		await original.run(true);
		const automatic = original.store.getForSession(SESSION_ID);
		if (automatic?.source !== "automatic")
			throw new Error("automatic checkpoint was not installed");

		const reloadedSession = new SessionFixture();
		reloadedSession.appendEntry("pi-codex-adaptor.auto-compaction", automatic.checkpoint);
		const reloaded = harness({ session: reloadedSession });
		const reloadedEvents = await reloaded.run(false);
		expect(reloadedEvents.at(-1)).toMatchObject({ type: "done" });
		expect(reloaded.runtime.compactCalls).toBe(0);
		expect((reloaded.runtime.responseRequests[0] as { input: unknown[] }).input[0]).toMatchObject({
			type: "compaction",
			encrypted_content: OPAQUE,
		});

		const fork = harness();
		const forkEvents = await fork.run(false);
		expect(forkEvents.at(-1)).toMatchObject({ type: "done" });
		expect(fork.runtime.compactCalls).toBe(1);
		expect((fork.runtime.responseRequests[0] as { input: unknown[] }).input[0]).toMatchObject({
			type: "compaction",
			encrypted_content: OPAQUE,
		});

		const manualSession = new SessionFixture();
		manualSession.appendEntry("pi-codex-adaptor.auto-compaction", automatic.checkpoint);
		const manualDetails = createCodexCompactionDetails(automatic.checkpoint, [
			{ type: "compaction", encrypted_content: "synthetic-manual-opaque" },
		]);
		manualSession.appendCompaction(manualDetails);
		const manual = harness({ session: manualSession });
		manual.store.setManual(
			SESSION_ID,
			"Synthetic manual compaction",
			manualDetails,
			"manual-entry-1",
		);
		manual.coordinator.beginExecution(SESSION_ID);
		manual.session.appendUser("user-after-compaction", "summarize the completed work");
		const manualEvents = await manual.run(false, (payload) => payload, {
			origin: "agent",
			sessionId: SESSION_ID,
		});
		manual.coordinator.end(SESSION_ID, "cancel");
		expect(manualEvents.at(-1)).toMatchObject({ type: "done" });
		expect(manual.runtime.compactCalls).toBe(0);
		expect((manual.runtime.responseRequests[0] as { input: unknown[] }).input).toEqual([
			{ type: "compaction", encrypted_content: "synthetic-manual-opaque" },
			{
				type: "function_call_output",
				call_id: "call-fixture",
				output: "fixture output",
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "summarize the completed work" }],
			},
		]);
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

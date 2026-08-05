import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CodexRuntime } from "../../src/application/codex-runtime.ts";
import {
	CODEX_REMOTE_COMPACTION_KIND,
	CodexCompactionCoordinator,
	CodexCompactionStore,
	createRemoteCompactionCheckpoint,
	parseRemoteCompactionCheckpoint,
	resolveCompactionThreshold,
	shouldCreateAutomaticCheckpoint,
	validateCompactionOutput,
} from "../../src/application/compaction.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";
import {
	checkpointPayload,
	projectCanonicalEntries,
	providerCompactionIdentityFromValues,
	registerCodexCompactionReplay,
	restoreProviderCheckpointUsageBoundary,
	scanRemoteCompactionCheckpoints,
} from "../../src/integration/pi/codex-compaction-replay.ts";
import { CodexProviderRequestGuard } from "../../src/integration/pi/codex-provider-request-guard.ts";
import { createProviderConnection } from "../../src/integration/pi/provider-connection.ts";
import type { ProviderCheckpointProposal } from "../../src/integration/pi/provider-payload-compaction-api.ts";
import { createFakePi, fixtureModel, fixtureToken } from "../integration/helpers/fake-pi.ts";

const identity = {
	sessionFingerprint: "session-fingerprint",
	providerId: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://api.example.test/v1",
	modelId: "fixture-model",
	authenticationBinding: { kind: "credential" as const, fingerprint: "credential-fingerprint" },
};

const compactionItem = {
	type: "compaction",
	encrypted_content: "opaque-fixture-output",
} as const;

function checkpoint() {
	return createRemoteCompactionCheckpoint(
		identity,
		"checkpoint-1",
		"entry-2",
		"remote_v2",
		[compactionItem],
		12_345,
		{ inputTokens: 12_000, outputTokens: 20, cachedInputTokens: 100 },
	);
}

function messageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	content: string,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-27T00:00:00.000Z",
		message:
			role === "user"
				? { role, content, timestamp: 1 }
				: ({
						role,
						content: [{ type: "text", text: content }],
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "fixture-model",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					} as never),
	};
}

describe("remote compaction checkpoint contract", () => {
	test("round-trips only the version-one remote schema with strict keys", () => {
		const value = checkpoint();
		expect(parseRemoteCompactionCheckpoint(structuredClone(value))).toEqual(value);
		expect(
			parseRemoteCompactionCheckpoint({
				...value,
				version: 2,
			}),
		).toBeUndefined();
		expect(
			parseRemoteCompactionCheckpoint({
				...value,
				unrecognized: true,
			}),
		).toBeUndefined();
	});

	test("requires exactly one supported compaction item", () => {
		expect(validateCompactionOutput([compactionItem])).toEqual([compactionItem]);
		expect(() => validateCompactionOutput([])).toThrow();
		expect(() => validateCompactionOutput([compactionItem, compactionItem])).toThrow(
			"exactly one compaction item",
		);
		expect(() => validateCompactionOutput([{ type: "unknown_item" }])).toThrow();
	});

	test("keeps historical auto and portable checkpoint schemas inert", () => {
		const historical = [
			{
				kind: "pi-codex-adaptor.auto-compaction",
				version: 1,
				...identity,
				output: [compactionItem],
				coveredEntryId: "entry-2",
			},
			{
				kind: "pi-codex-adaptor.compaction",
				version: 2,
				modelId: identity.modelId,
				output: [compactionItem],
			},
			{
				kind: "pi-codex-adaptor.compaction",
				version: 3,
				portable: { summarySha256: "0".repeat(64) },
				opaque: { ...identity, output: [compactionItem] },
			},
		];

		for (const value of historical) {
			expect(parseRemoteCompactionCheckpoint(value)).toBeUndefined();
		}
	});

	test("replays opaque output only for every exact identity axis and valid coverage", () => {
		const covered = messageEntry("entry-2", null, "user", "covered canonical input");
		const checkpointEntry: SessionEntry = {
			type: "custom",
			id: "checkpoint-entry",
			parentId: covered.id,
			timestamp: "2026-07-27T00:00:01.000Z",
			customType: CODEX_REMOTE_COMPACTION_KIND,
			data: checkpoint(),
		};
		const suffix = messageEntry("entry-3", checkpointEntry.id, "user", "canonical suffix");
		const branch = [covered, checkpointEntry, suffix];
		const exact = scanRemoteCompactionCheckpoints(branch, identity);

		if (exact.matching === undefined) {
			throw new Error("Expected an exact checkpoint match");
		}
		expect(checkpointPayload(exact.matching, branch)).toEqual([
			compactionItem,
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "canonical suffix" }],
			},
		]);

		const mismatches = [
			{ ...identity, sessionFingerprint: "different-session" },
			{ ...identity, providerId: "different-provider" },
			{ ...identity, api: "openai-responses" },
			{ ...identity, baseUrl: "https://different.example.test/v1" },
			{ ...identity, modelId: "different-model" },
			{
				...identity,
				authenticationBinding: { kind: "credential" as const, fingerprint: "different-credential" },
			},
			{
				...identity,
				authenticationBinding: {
					kind: "jwt_account" as const,
					fingerprint: "credential-fingerprint",
				},
			},
		];
		for (const mismatch of mismatches) {
			const scan = scanRemoteCompactionCheckpoints(branch, mismatch);
			expect(scan.matching).toBeUndefined();
			expect(scan.hasIdentityMismatch).toBe(true);
		}

		const invalidCoverage = [
			{ ...covered, id: "different-covered-entry" },
			checkpointEntry,
			suffix,
		];
		expect(scanRemoteCompactionCheckpoints(invalidCoverage, identity).matching).toBeUndefined();
	});

	test("selects the newest exact checkpoint fully covered by a requested prefix", () => {
		const first = messageEntry("entry-1", null, "user", "first canonical input");
		const olderCheckpoint: SessionEntry = {
			type: "custom",
			id: "checkpoint-old",
			parentId: first.id,
			timestamp: "2026-07-27T00:00:01.000Z",
			customType: CODEX_REMOTE_COMPACTION_KIND,
			data: { ...checkpoint(), checkpointId: "checkpoint-old", coveredEntryId: first.id },
		};
		const second = messageEntry("entry-2", olderCheckpoint.id, "user", "second canonical input");
		const newerCheckpoint: SessionEntry = {
			type: "custom",
			id: "checkpoint-new",
			parentId: second.id,
			timestamp: "2026-07-27T00:00:02.000Z",
			customType: CODEX_REMOTE_COMPACTION_KIND,
			data: { ...checkpoint(), checkpointId: "checkpoint-new", coveredEntryId: second.id },
		};
		const retained = messageEntry("entry-3", newerCheckpoint.id, "assistant", "retained input");
		const branch = [first, olderCheckpoint, second, newerCheckpoint, retained];

		const scan = scanRemoteCompactionCheckpoints(branch, identity, 2);
		if (scan.matching === undefined) throw new Error("Expected an eligible older checkpoint");
		const matching = scan.matching;
		expect(matching.entry.id).toBe("checkpoint-old");
		expect(checkpointPayload(matching, branch, 3)).toEqual([
			compactionItem,
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "second canonical input" }],
			},
		]);
		expect(() => checkpointPayload(matching, branch, 0)).toThrow();
	});

	test("serializes mismatch warnings once per exact identity and session", () => {
		const store = new CodexCompactionStore();
		expect(store.warnOnce("session-1", identity)).toBe(true);
		expect(store.warnOnce("session-1", identity)).toBe(false);
		expect(store.warnOnce("session-2", identity)).toBe(true);
		store.dispose("session-1");
		expect(store.warnOnce("session-1", identity)).toBe(true);
		expect(store.warnSessionOnce("session-2")).toBe(true);
		expect(store.warnSessionOnce("session-2")).toBe(false);
	});

	test("keeps context usage baselines generation-scoped and rejects stale completions", () => {
		const store = new CodexCompactionStore();
		const initial = store.contextAccounting("session-1", identity);
		expect(initial).toEqual({ generation: 0 });
		expect(
			store.recordContextUsage({
				sessionId: "session-1",
				identity,
				generation: initial.generation,
				requestGeneration: 2,
				totalTokens: 120,
				inputItemCount: 3,
				inputDigest: "digest-new",
				instructionsDigest: "instructions-new",
			}),
		).toBe(true);
		expect(
			store.recordContextUsage({
				sessionId: "session-1",
				identity,
				generation: initial.generation,
				requestGeneration: 1,
				totalTokens: 80,
				inputItemCount: 2,
				inputDigest: "digest-stale",
				instructionsDigest: "instructions-stale",
			}),
		).toBe(false);
		expect(store.contextAccounting("session-1", identity).baseline?.totalTokens).toBe(120);

		store.invalidateContextAccounting("session-1");
		const replacement = store.contextAccounting("session-1", identity);
		expect(replacement).toEqual({ generation: 1 });
		expect(
			store.recordContextUsage({
				sessionId: "session-1",
				identity,
				generation: initial.generation,
				requestGeneration: 3,
				totalTokens: 200,
				inputItemCount: 4,
				inputDigest: "digest-late",
				instructionsDigest: "instructions-late",
			}),
		).toBe(false);
		const changedIdentity = { ...identity, modelId: "replacement-model" };
		expect(store.contextAccounting("session-1", changedIdentity)).toEqual({ generation: 2 });
		expect(store.contextAccounting("session-1", identity)).toEqual({ generation: 3 });
	});

	test("keeps disposed-session generations ahead of in-flight completions", () => {
		const store = new CodexCompactionStore();
		const pending = store.contextAccounting("session-1", identity);

		store.dispose("session-1");

		const reloaded = store.contextAccounting("session-1", identity);
		expect(reloaded.generation).toBe(pending.generation + 1);
		expect(
			store.recordContextUsage({
				sessionId: "session-1",
				identity,
				generation: pending.generation,
				requestGeneration: 1,
				totalTokens: 100,
				inputItemCount: 1,
				inputDigest: "stale-after-dispose",
				instructionsDigest: "instructions-stale",
			}),
		).toBe(false);
		expect(
			store.recordContextUsage({
				sessionId: "session-1",
				identity,
				generation: reloaded.generation,
				requestGeneration: 2,
				totalTokens: 200,
				inputItemCount: 2,
				inputDigest: "current-after-dispose",
				instructionsDigest: "instructions-current",
			}),
		).toBe(true);
	});

	test("invalidates active sessions when the store is disposed globally", () => {
		const store = new CodexCompactionStore();
		const pending = store.contextAccounting("session-1", identity);

		store.disposeAll();

		expect(store.contextAccounting("session-1", identity).generation).toBe(pending.generation + 1);
		expect(
			store.recordContextUsage({
				sessionId: "session-1",
				identity,
				generation: pending.generation,
				requestGeneration: 1,
				totalTokens: 100,
				inputItemCount: 1,
				inputDigest: "stale-after-dispose-all",
				instructionsDigest: "instructions-stale",
			}),
		).toBe(false);
	});

	test("serializes checkpoint work and releases it after every terminal outcome", () => {
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.begin("session-1")).toBe(true);
		expect(coordinator.begin("session-1")).toBe(false);
		expect(coordinator.beginExecution("session-1")).toBe(false);
		coordinator.endPending("session-1", "error");
		expect(coordinator.requestExecution("session-1")).toBe(true);
		expect(coordinator.beginExecution("session-1")).toBe(true);
		expect(coordinator.beginExecution("session-1")).toBe(false);
		coordinator.end("session-1", "cancel");
		expect(coordinator.isBusy("session-1")).toBe(false);
	});

	test("threshold state requires a non-empty uncovered canonical suffix", () => {
		const config = createDefaultConfig().codex.compaction;
		const threshold = resolveCompactionThreshold(config, 90_000, 100_000);
		expect(threshold).toBe(90_000);
		expect(
			shouldCreateAutomaticCheckpoint({
				mode: "auto",
				contextTokens: 90_001,
				threshold,
				hasUncheckpointedInput: false,
				busy: false,
			}),
		).toBe(false);
		expect(
			shouldCreateAutomaticCheckpoint({
				mode: "auto",
				contextTokens: 90_001,
				threshold,
				hasUncheckpointedInput: true,
				busy: false,
			}),
		).toBe(true);
	});

	test("suppresses unchanged and below-threshold suffix compaction until the first over-threshold suffix", async () => {
		const pi = createFakePi({ token: fixtureToken(), sessionId: "checkpoint-state-session" });
		const model = fixtureModel() as Model<string>;
		const config = createDefaultConfig();
		const branch: SessionEntry[] = [messageEntry("entry-1", null, "user", "fixture input")];
		let leafId = "entry-1";
		let contextTokens = 200;
		const context = pi.context(model, "checkpoint-state-session");
		const sessionManager = context.sessionManager as unknown as {
			getBranch: () => readonly SessionEntry[];
			getEntries: () => readonly SessionEntry[];
			getLeafId: () => string;
		};
		sessionManager.getBranch = () => branch;
		sessionManager.getEntries = () => branch;
		sessionManager.getLeafId = () => leafId;
		(
			context as unknown as {
				getContextUsage: () => { tokens: number; contextWindow: number; percent: number };
			}
		).getContextUsage = () => ({
			tokens: contextTokens,
			contextWindow: 1_000,
			percent: contextTokens / 10,
		});

		const runtime = {
			compactCalls: 0,
			estimateContext: async () => ({
				activeContextTokens: contextTokens,
				fullEstimatedTokens: contextTokens,
				suffixEstimatedTokens: 0,
				accountingSource: "full_estimate" as const,
				autoCompactTokenLimit: null,
				contextWindow: 1_000,
			}),
			compact: async () => {
				runtime.compactCalls += 1;
				return { status: "completed", result: { output: [compactionItem] } };
			},
		} as unknown as CodexRuntime & { compactCalls: number };
		const snapshot = {
			compaction: { implementation: "compact_endpoint", threshold: 100 },
			providerSupportsWebsockets: false,
			shell: { sessionSurface: "official" },
		};
		const guard = new CodexProviderRequestGuard();
		const activation = new ProviderActivationPolicy({ load: async () => config });
		registerCodexCompactionReplay({
			pi: pi.api,
			runtime,
			configuration: { load: async () => config } as never,
			activation,
			store: new CodexCompactionStore(),
			coordinator: new CodexCompactionCoordinator(),
			capabilities: { resolve: async () => snapshot } as never,
			profile: { isHealthy: () => true, registeredManagedTools: () => [] } as never,
			guard,
		});
		const handler = pi.handlers.get("before_provider_payload")?.[0];
		if (handler === undefined)
			throw new Error("before_provider_payload handler was not registered");
		const signal = new AbortController().signal;
		const request = {
			model: model.id,
			instructions: "",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] },
			],
		};
		const record = guard.open({
			options: { sessionId: "checkpoint-state-session", signal },
			sessionId: "checkpoint-state-session",
			model,
			context: { messages: [] } as unknown as Context,
			request,
			inputLedger: request.input,
			connection: createProviderConnection(model, { apiKey: fixtureToken() }),
			config,
			capabilities: snapshot as never,
			signal,
		});
		const token = {} as never;
		const event = {
			type: "before_provider_payload",
			model,
			payload: request,
			attribution: {
				sessionId: "checkpoint-state-session",
				origin: "agent",
				signal,
				compaction: {
					token,
					candidateLeafId: leafId,
					candidateRetainedTail: [],
				},
			},
		};
		const invoke = () =>
			guard.run(record, () => handler(event, context)) as Promise<{
				payload: Record<string, unknown>;
				providerCheckpoint?: { checkpointId: string; customType: string; data: unknown };
			}>;
		const appendProposal = (result: Awaited<ReturnType<typeof invoke>>): void => {
			if (result.providerCheckpoint === undefined) return;
			const entryId = `checkpoint-${runtime.compactCalls}`;
			branch.push({
				type: "custom",
				id: entryId,
				parentId: leafId,
				timestamp: "2026-07-27T00:00:00.000Z",
				customType: result.providerCheckpoint.customType,
				data: result.providerCheckpoint.data,
			});
			leafId = entryId;
		};

		const first = await invoke();
		appendProposal(first);
		expect(runtime.compactCalls).toBe(1);
		expect(branch.filter((entry) => entry.type === "custom")).toHaveLength(1);
		expect(guard.assertApproved(record, first.payload)).toBe(first.payload);
		expect(() =>
			guard.assertApproved(record, { ...first.payload, model: "changed-model" }),
		).toThrow("approval");

		const unchanged = await invoke();
		expect(unchanged.providerCheckpoint).toBeUndefined();
		expect(runtime.compactCalls).toBe(1);
		expect(branch.filter((entry) => entry.type === "custom")).toHaveLength(1);

		branch.push(messageEntry("entry-2", leafId, "user", "small suffix"));
		leafId = "entry-2";
		contextTokens = 50;
		const belowThreshold = await invoke();
		expect(belowThreshold.providerCheckpoint).toBeUndefined();
		expect(runtime.compactCalls).toBe(1);
		expect(branch.filter((entry) => entry.type === "custom")).toHaveLength(1);

		contextTokens = 200;
		const firstOverThreshold = await invoke();
		appendProposal(firstOverThreshold);
		expect(firstOverThreshold.providerCheckpoint).toBeDefined();
		expect(runtime.compactCalls).toBe(2);
		expect(branch.filter((entry) => entry.type === "custom")).toHaveLength(2);
		activation.dispose();
	});

	test("restores a matching active-branch usage boundary and clears it on identity mismatch", async () => {
		const pi = createFakePi({ token: fixtureToken(), sessionId: "restore-boundary-session" });
		const model = fixtureModel() as Model<string>;
		const connection = createProviderConnection(model, { apiKey: fixtureToken() });
		const identity = providerCompactionIdentityFromValues({
			sessionId: "restore-boundary-session",
			model,
			connection,
		});
		if (identity === undefined) throw new Error("fixture identity was not created");
		const data = createRemoteCompactionCheckpoint(
			identity,
			"restore-checkpoint",
			"entry-1",
			"compact_endpoint",
			[compactionItem],
			1,
		);
		const branch: SessionEntry[] = [
			messageEntry("entry-1", null, "user", "covered"),
			{
				type: "custom",
				id: "checkpoint-entry",
				parentId: "entry-1",
				timestamp: "2026-07-27T00:00:00.000Z",
				customType: CODEX_REMOTE_COMPACTION_KIND,
				data,
			},
		];
		const context = pi.context(model, "restore-boundary-session");
		const sessionManager = context.sessionManager as unknown as {
			getBranch: () => readonly SessionEntry[];
			getEntries: () => readonly SessionEntry[];
		};
		sessionManager.getBranch = () => branch;
		sessionManager.getEntries = () => branch;
		const boundaryCalls: Array<string | undefined> = [];
		(
			pi.api as unknown as {
				setProviderCheckpointUsageBoundary: (entryId?: string) => boolean;
			}
		).setProviderCheckpointUsageBoundary = (entryId) => {
			boundaryCalls.push(entryId);
			return true;
		};
		const activation = new ProviderActivationPolicy({ load: async () => createDefaultConfig() });
		const store = new CodexCompactionStore();

		await restoreProviderCheckpointUsageBoundary({
			pi: pi.api,
			ctx: context,
			activation,
			store,
			connection,
		});
		expect(boundaryCalls).toEqual(["checkpoint-entry"]);
		expect(pi.notifications).toHaveLength(0);

		const mismatchModel = fixtureModel("different-model") as Model<string>;
		const mismatchContext = pi.context(mismatchModel, "restore-boundary-session");
		const mismatchSessionManager = mismatchContext.sessionManager as unknown as {
			getBranch: () => readonly SessionEntry[];
			getEntries: () => readonly SessionEntry[];
		};
		mismatchSessionManager.getBranch = () => branch;
		mismatchSessionManager.getEntries = () => branch;
		await restoreProviderCheckpointUsageBoundary({
			pi: pi.api,
			ctx: mismatchContext,
			activation,
			store,
			connection: createProviderConnection(mismatchModel, { apiKey: fixtureToken() }),
		});
		expect(boundaryCalls).toEqual(["checkpoint-entry", undefined]);
		expect(pi.notifications).toHaveLength(1);
		activation.dispose();
	});

	test("keeps the current usage boundary intact while a fork is still cancellable", () => {
		const pi = createFakePi({ token: fixtureToken() });
		registerCodexCompaction(
			pi.api,
			{} as never,
			{ load: async () => createDefaultConfig() } as never,
			new CodexCompactionStore(),
			{ isActive: () => true } as never,
		);

		expect(pi.handlers.has("session_before_fork")).toBe(false);
		expect(pi.handlers.has("session_start")).toBe(true);
	});

	test("rejects custom instructions before selecting a remote implementation", async () => {
		for (const implementation of ["remote_v2", "compact_endpoint"] as const) {
			const pi = createFakePi({ token: fixtureToken() });
			let capabilityResolutionCalled = false;
			registerCodexCompaction(
				pi.api,
				{} as never,
				{ load: async () => createDefaultConfig() } as never,
				new CodexCompactionStore(),
				{ isActive: () => true } as never,
				new CodexCompactionCoordinator(),
				{
					resolve: async () => {
						capabilityResolutionCalled = true;
						return { compaction: { implementation } };
					},
				} as never,
				{ isHealthy: () => true, registeredManagedTools: () => [] } as never,
			);

			const handler = pi.handlers.get("session_before_compact")?.[0];
			const result = await handler?.(
				{
					reason: "manual",
					customInstructions: "fixture instruction",
					signal: new AbortController().signal,
					branchEntries: [],
					preparation: { firstKeptEntryId: "fixture-entry" },
				},
				pi.context(fixtureModel()),
			);

			expect(result).toEqual({
				cancel: true,
				errorMessage: "Codex remote compaction does not support custom instructions",
			});
			expect(capabilityResolutionCalled).toBe(false);
		}
	});

	test("issues exactly one remote operation for each manual and overflow entry", async () => {
		const pi = createFakePi({ token: fixtureToken(), sessionId: "manual-overflow-session" });
		const model = fixtureModel() as Model<string>;
		const ctx = pi.context(model, "manual-overflow-session");
		const branch = [
			messageEntry("entry-1", null, "user", "covered input"),
			messageEntry("entry-2", "entry-1", "assistant", "retained assistant"),
		];
		const manager = ctx.sessionManager as unknown as {
			getLeafId: () => string;
		};
		manager.getLeafId = () => "entry-2";
		let compactCalls = 0;
		const runtime = {
			compact: async () => {
				compactCalls += 1;
				return {
					status: "completed",
					result: {
						output: [compactionItem],
						usage: { inputTokens: 120, outputTokens: 10, cachedInputTokens: 20 },
					},
				};
			},
		} as unknown as CodexRuntime;
		registerCodexCompaction(
			pi.api,
			runtime,
			{ load: async () => createDefaultConfig() } as never,
			new CodexCompactionStore(),
			{ isActive: () => true } as never,
			new CodexCompactionCoordinator(),
			{
				resolve: async () => ({
					compaction: { implementation: "compact_endpoint", threshold: 100 },
					providerSupportsWebsockets: false,
					shell: { sessionSurface: "official" },
				}),
			} as never,
			{ isHealthy: () => true, registeredManagedTools: () => [] } as never,
		);
		const handler = pi.handlers.get("session_before_compact")?.[0];
		if (handler === undefined) throw new Error("session_before_compact handler was not registered");
		const eventBase = {
			customInstructions: undefined,
			signal: new AbortController().signal,
			branchEntries: branch,
			preparation: { firstKeptEntryId: "entry-2" },
			checkpointToken: {} as never,
		};

		const manual = (await handler({ ...eventBase, reason: "manual" }, ctx)) as
			| { providerCheckpoint?: ProviderCheckpointProposal }
			| undefined;
		const overflow = (await handler({ ...eventBase, reason: "overflow" }, ctx)) as
			| { providerCheckpoint?: ProviderCheckpointProposal }
			| undefined;

		expect(compactCalls).toBe(2);
		expect(manual?.providerCheckpoint?.usage).toMatchObject({
			input: 100,
			output: 10,
			cacheRead: 20,
			totalTokens: 130,
		});
		expect(overflow?.providerCheckpoint).toBeDefined();
	});

	test("reuses only an exact checkpoint inside manual and overflow prefixes", async () => {
		const sessionId = "checkpointed-manual-session";
		const pi = createFakePi({ token: fixtureToken(), sessionId });
		const model = fixtureModel() as Model<string>;
		const ctx = pi.context(model, sessionId);
		const connection = createProviderConnection(model, { apiKey: fixtureToken() });
		const exactIdentity = providerCompactionIdentityFromValues({ sessionId, model, connection });
		if (exactIdentity === undefined) throw new Error("fixture identity was not created");
		const first = messageEntry("entry-1", null, "user", "covered canonical input");
		const checkpointEntry: SessionEntry = {
			type: "custom",
			id: "checkpoint-entry",
			parentId: first.id,
			timestamp: "2026-07-27T00:00:01.000Z",
			customType: CODEX_REMOTE_COMPACTION_KIND,
			data: createRemoteCompactionCheckpoint(
				exactIdentity,
				"checkpoint-exact",
				first.id,
				"compact_endpoint",
				[compactionItem],
				100,
			),
		};
		const second = messageEntry("entry-2", checkpointEntry.id, "user", "checkpoint suffix");
		const retained = messageEntry("entry-3", second.id, "assistant", "retained assistant");
		const exactBranch = [first, checkpointEntry, second, retained];
		const mismatchData = createRemoteCompactionCheckpoint(
			{ ...exactIdentity, modelId: "different-model" },
			"checkpoint-mismatch",
			first.id,
			"compact_endpoint",
			[compactionItem],
			100,
		);
		const mismatchBranch = exactBranch.map((entry) =>
			entry.id === checkpointEntry.id && entry.type === "custom"
				? { ...entry, data: mismatchData }
				: entry,
		);
		const manager = ctx.sessionManager as unknown as { getLeafId: () => string };
		manager.getLeafId = () => retained.id;
		const compactInputs: unknown[] = [];
		const runtime = {
			compact: async (options: { request: { input: unknown } }) => {
				compactInputs.push(structuredClone(options.request.input));
				return {
					status: "completed",
					result: { output: [compactionItem] },
				};
			},
		} as unknown as CodexRuntime;
		registerCodexCompaction(
			pi.api,
			runtime,
			{ load: async () => createDefaultConfig() } as never,
			new CodexCompactionStore(),
			{ isActive: () => true } as never,
			new CodexCompactionCoordinator(),
			{
				resolve: async () => ({
					compaction: { implementation: "compact_endpoint", threshold: 100 },
					providerSupportsWebsockets: false,
					shell: { sessionSurface: "official" },
				}),
			} as never,
			{ isHealthy: () => true, registeredManagedTools: () => [] } as never,
		);
		const handler = pi.handlers.get("session_before_compact")?.[0];
		if (handler === undefined) throw new Error("session_before_compact handler was not registered");
		const event = {
			customInstructions: undefined,
			signal: new AbortController().signal,
			preparation: { firstKeptEntryId: retained.id },
			checkpointToken: {} as never,
		};

		for (const reason of ["manual", "overflow"] as const) {
			const result = (await handler({ ...event, reason, branchEntries: exactBranch }, ctx)) as
				| { providerCheckpoint?: ProviderCheckpointProposal }
				| undefined;
			expect(result?.providerCheckpoint).toBeDefined();
		}
		await handler({ ...event, reason: "manual", branchEntries: mismatchBranch }, ctx);

		const expectedCheckpointInput = [
			compactionItem,
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "checkpoint suffix" }],
			},
		];
		expect(compactInputs.slice(0, 2)).toEqual([expectedCheckpointInput, expectedCheckpointInput]);
		expect(JSON.stringify(compactInputs[2])).not.toContain("opaque-fixture-output");
		expect(JSON.stringify(compactInputs[2])).toContain("covered canonical input");
		expect(pi.notifications).toHaveLength(1);
	});

	test("projects canonical entries without checkpoint or context-invisible metadata", () => {
		const entries: SessionEntry[] = [
			messageEntry("entry-1", null, "user", "canonical user"),
			{
				type: "custom",
				id: "checkpoint-entry",
				parentId: "entry-1",
				timestamp: "2026-07-27T00:00:00.000Z",
				customType: CODEX_REMOTE_COMPACTION_KIND,
				data: checkpoint(),
			},
			{
				type: "thinking_level_change",
				id: "settings-entry",
				parentId: "checkpoint-entry",
				timestamp: "2026-07-27T00:00:00.000Z",
				thinkingLevel: "high",
			},
			messageEntry("entry-3", "settings-entry", "assistant", "canonical assistant"),
		];
		const projected = projectCanonicalEntries(entries);
		expect(projected.some((item) => JSON.stringify(item).includes("opaque-fixture-output"))).toBe(
			false,
		);
		expect(projected.map((item) => item.type)).toEqual(["message", "message"]);
	});
});

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	parseCodexCompactionDetails,
	resolveCompactionThreshold,
	shouldAcceptCompactionEvent,
	shouldTriggerAutoCompaction,
} from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexCompaction } from "../../src/integration/pi/codex-compaction.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

class FixtureRuntime implements CodexRuntime {
	compaction: CompactResponseOptions | undefined;
	compactCalls = 0;
	compactImpl: ((options: CompactResponseOptions) => Promise<CreateResponseResult>) | undefined;
	modelResolution: unknown = {
		model: { slug: "fixture-model" },
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

	async createResponse(_options: CreateResponseOptions): Promise<CreateResponseResult> {
		throw new Error("fixture response execution is not configured");
	}

	async compact(options: CompactResponseOptions): Promise<CreateResponseResult> {
		this.compactCalls += 1;
		this.compaction = options;
		if (this.compactImpl !== undefined) {
			return this.compactImpl(options);
		}
		return {
			status: "completed",
			result: {
				output: [{ type: "message", role: "assistant", content: [] }],
			},
		};
	}

	async resolveModel(modelId: string): Promise<unknown> {
		const value = this.modelResolution as Record<string, unknown>;
		const model = value.model as Record<string, unknown>;
		return { ...value, model: { ...model, slug: modelId } };
	}

	async resolveTools(): Promise<unknown> {
		return {
			modelTools: [
				{
					type: "function",
					name: "update_plan",
					description: "Official fixture",
					parameters: { type: "object", properties: {} },
					strict: false,
				},
			],
		};
	}

	async executeTool(_options: ExecuteToolOptions): Promise<CreateResponseResult> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

function fixtureToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function configuration(
	overrides?: Partial<ReturnType<typeof createDefaultConfig>["codex"]["compaction"]>,
): ConfigurationService {
	const defaults = createDefaultConfig();
	return {
		load: async () => ({
			...defaults,
			codex: {
				...defaults.codex,
				compaction: {
					...defaults.codex.compaction,
					...overrides,
				},
			},
		}),
	} as ConfigurationService;
}

function context(options?: {
	tokens?: number;
	compact?: ExtensionContext["compact"];
	sessionId?: string;
	authFailure?: boolean;
}): ExtensionContext {
	const tokens = options?.tokens ?? 50_000;
	return {
		model: {
			id: "fixture-model",
			provider: "openai-codex",
			api: "openai-codex-responses",
			name: "Fixture",
			baseUrl: "https://invalid.example",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				options?.authFailure === true
					? { ok: false, error: "fixture authentication failure" }
					: { ok: true, apiKey: fixtureToken(), headers: {} },
		},
		sessionManager: {
			getSessionId: () => options?.sessionId ?? "session-fixture",
			getBranch: () => [],
		},
		getSystemPrompt: () => "fixture system",
		getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: tokens / 1000 }),
		compact: options?.compact ?? (() => {}),
	} as unknown as ExtensionContext;
}

function compactEvent(
	reason: "manual" | "threshold" | "overflow",
	tokensBefore = 50_000,
	signal: AbortSignal = new AbortController().signal,
): Record<string, unknown> {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [{ role: "user", content: "compact this", timestamp: 1 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore,
			fileOps: { read: [], written: [] },
			settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 5_000 },
		},
		branchEntries: [],
		reason,
		willRetry: false,
		signal,
	};
}

function register(
	runtime: FixtureRuntime,
	config: ConfigurationService = configuration(),
	store = new CodexCompactionStore(),
	coordinator = new CodexCompactionCoordinator(),
): {
	handlers: Map<string, EventHandler[]>;
	store: CodexCompactionStore;
	coordinator: CodexCompactionCoordinator;
} {
	const handlers = new Map<string, EventHandler[]>();
	registerCodexCompaction(
		{
			on: (name: string, handler: EventHandler) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			getActiveTools: () => ["third_party"],
			getAllTools: () => [
				{
					name: "third_party",
					description: "Third-party fixture",
					parameters: { type: "object", properties: {} },
					sourceInfo: { path: "fixture" },
				},
			],
			getThinkingLevel: () => "low",
		} as never,
		runtime,
		config,
		store,
		new ProviderActivationPolicy(config),
		coordinator,
	);
	return { handlers, store, coordinator };
}

describe("official compaction integration", () => {
	test("retains canonical output in versioned session details", async () => {
		const runtime = new FixtureRuntime();
		const { handlers, store } = register(runtime);

		const result = (await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			context(),
		)) as Record<string, unknown>;

		const compaction = result.compaction as Record<string, unknown>;
		expect(compaction).toMatchObject({
			firstKeptEntryId: "kept-entry",
			tokensBefore: 50_000,
		});
		expect(parseCodexCompactionDetails(compaction.details)?.output).toEqual([
			{ type: "message", role: "assistant", content: [] },
		]);
		await handlers.get("session_compact")?.[0]?.(
			{
				type: "session_compact",
				compactionEntry: {
					type: "compaction",
					id: "compaction-entry",
					parentId: "parent-entry",
					timestamp: new Date(0).toISOString(),
					summary: compaction.summary,
					firstKeptEntryId: "kept-entry",
					tokensBefore: 50_000,
					details: compaction.details,
				},
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			context(),
		);
		expect(store.get("session-fixture", "fixture-model")?.output).toEqual([
			{ type: "message", role: "assistant", content: [] },
		]);
		expect(runtime.compaction?.request).toMatchObject({
			model: "fixture-model",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "compact this" }],
				},
			],
		});
		expect(runtime.compaction?.implementation).toBe("remote_v2");
		expect(runtime.compaction?.providerSupportsWebsockets).toBe(true);
		expect(runtime.compaction?.transportMode).toBe("auto");
	});

	test("selects CompactClient when the provider lacks remote compaction", async () => {
		const runtime = new FixtureRuntime();
		runtime.modelResolution = {
			model: { slug: "fixture-model" },
			shellSurface: "shell-command",
			autoCompactTokenLimit: 90_000,
			provider: {
				name: "fixture-third-party",
				supportsWebsockets: false,
				supportsRemoteCompaction: false,
				namespaceTools: false,
				imageGeneration: false,
				hostedWebSearch: false,
			},
		};
		const { handlers } = register(runtime);

		await handlers.get("session_before_compact")?.[0]?.(compactEvent("manual"), context());

		expect(runtime.compaction?.implementation).toBe("compact_endpoint");
		expect(runtime.compaction?.providerSupportsWebsockets).toBe(false);
	});

	test("validates persisted detail markers before restoring them", () => {
		const details = createCodexCompactionDetails("fixture-model", [{ type: "message" }]);
		expect(parseCodexCompactionDetails(details)).toEqual(details);
		expect(parseCodexCompactionDetails({ ...details, version: 2 })).toBeUndefined();
	});

	test("resolves model metadata and numeric auto-compact thresholds", () => {
		expect(
			resolveCompactionThreshold({ mode: "auto", autoCompactTokenLimit: "model" }, 90_000, 100_000),
		).toBe(90_000);
		expect(
			resolveCompactionThreshold({ mode: "auto", autoCompactTokenLimit: 48_000 }, 90_000, 100_000),
		).toBe(48_000);
		expect(resolveCompactionThreshold({ mode: "off" }, 90_000, 100_000)).toBeUndefined();
		expect(
			resolveCompactionThreshold({ mode: "auto", autoCompactTokenLimit: "model" }, null, 100_000),
		).toBeUndefined();
		expect(
			resolveCompactionThreshold({ mode: "auto", autoCompactTokenLimit: 100_000 }, null, 100_000),
		).toBeUndefined();
	});

	test("triggers only on a rising edge past the configured threshold", () => {
		expect(
			shouldTriggerAutoCompaction({
				previousTokens: 40_000,
				currentTokens: 50_000,
				threshold: 48_000,
				compacting: false,
				mode: "auto",
			}),
		).toBe(true);
		expect(
			shouldTriggerAutoCompaction({
				previousTokens: undefined,
				currentTokens: 50_000,
				threshold: 48_000,
				compacting: false,
				mode: "auto",
			}),
		).toBe(false);
		expect(
			shouldTriggerAutoCompaction({
				previousTokens: 40_000,
				currentTokens: 47_000,
				threshold: 48_000,
				compacting: false,
				mode: "auto",
			}),
		).toBe(false);
		expect(
			shouldTriggerAutoCompaction({
				previousTokens: 40_000,
				currentTokens: 50_000,
				threshold: 48_000,
				compacting: true,
				mode: "auto",
			}),
		).toBe(false);
		expect(
			shouldTriggerAutoCompaction({
				previousTokens: 40_000,
				currentTokens: 50_000,
				threshold: 48_000,
				compacting: false,
				mode: "off",
			}),
		).toBe(false);
	});

	test("inactive providers skip Codex compaction without cancelling Pi fallback", async () => {
		const runtime = new FixtureRuntime();
		const { handlers, coordinator } = register(
			runtime,
			configuration({ mode: "auto", autoCompactTokenLimit: 48_000 }),
		);
		let compactCalls = 0;
		const inactiveCtx = context({
			tokens: 50_000,
			compact: () => {
				compactCalls += 1;
			},
		});
		const baseModel = inactiveCtx.model;
		expect(baseModel).toBeDefined();
		if (baseModel === undefined) return;
		inactiveCtx.model = {
			...baseModel,
			provider: "unselected-provider",
			api: "openai-responses",
			id: "other-model",
		};

		// Auto-threshold must not start a Codex compaction cycle for inactive providers.
		coordinator.setPreviousTokens("session-fixture", 40_000);
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, inactiveCtx);
		expect(compactCalls).toBe(0);
		expect(coordinator.isBusy("session-fixture")).toBe(false);
		expect(coordinator.getPreviousTokens("session-fixture")).toBeNull();

		// Manual and threshold before_compact must not cancel Pi or call the bridge.
		for (const reason of ["manual", "threshold"] as const) {
			const result = await handlers.get("session_before_compact")?.[0]?.(
				compactEvent(reason, 50_000),
				inactiveCtx,
			);
			expect(result).toBeUndefined();
			expect(runtime.compactCalls).toBe(0);
			expect(runtime.compaction).toBeUndefined();
			expect(coordinator.isBusy("session-fixture")).toBe(false);
		}
	});

	test("cancels off and non-crossing threshold events while keeping manual reuse", async () => {
		expect(
			shouldAcceptCompactionEvent({
				mode: "off",
				reason: "manual",
				tokensBefore: 50_000,
				threshold: 48_000,
			}),
		).toBe(false);
		expect(
			shouldAcceptCompactionEvent({
				mode: "auto",
				reason: "threshold",
				tokensBefore: 40_000,
				threshold: 48_000,
			}),
		).toBe(false);
		expect(
			shouldAcceptCompactionEvent({
				mode: "auto",
				reason: "threshold",
				tokensBefore: 50_000,
				threshold: 48_000,
			}),
		).toBe(true);
		expect(
			shouldAcceptCompactionEvent({
				mode: "auto",
				reason: "manual",
				tokensBefore: 10_000,
				threshold: 48_000,
			}),
		).toBe(true);

		const runtime = new FixtureRuntime();
		const { handlers, coordinator } = register(
			runtime,
			configuration({ mode: "auto", autoCompactTokenLimit: 48_000 }),
		);
		let compactCalls = 0;
		let tokens = 40_000;
		const ctx = {
			...context(),
			getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: tokens / 1000 }),
			compact: () => {
				compactCalls += 1;
			},
		} as unknown as ExtensionContext;

		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(compactCalls).toBe(0);
		tokens = 50_000;
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(compactCalls).toBe(1);
		expect(coordinator.isBusy("session-fixture")).toBe(true);

		const cancelled = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("threshold", 40_000),
			ctx,
		);
		expect(cancelled).toEqual({ cancel: true });

		const offHandlers = register(runtime, configuration({ mode: "off" })).handlers;
		const offResult = await offHandlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual"),
			ctx,
		);
		expect(offResult).toEqual({ cancel: true });

		// Clear the auto-initiated pending cycle so a later manual path can reuse the official route.
		coordinator.end("session-fixture", "cancel");
		const manual = (await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 12_000),
			ctx,
		)) as Record<string, unknown>;
		expect(manual.compaction).toMatchObject({
			firstKeptEntryId: "kept-entry",
			tokensBefore: 12_000,
		});
	});
});

describe("per-session compaction coordinator", () => {
	test("serializes auto and manual races onto one runtime.compact call", async () => {
		const runtime = new FixtureRuntime();
		let releaseCompact: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseCompact = resolve;
		});
		let enteredCompact: (() => void) | undefined;
		const sawCompact = new Promise<void>((resolve) => {
			enteredCompact = resolve;
		});
		runtime.compactImpl = async (options) => {
			enteredCompact?.();
			await gate;
			if (options.signal?.aborted) {
				return { status: "aborted", result: null };
			}
			return {
				status: "completed",
				result: { output: [{ type: "message", role: "assistant", content: [] }] },
			};
		};

		const { handlers, coordinator } = register(
			runtime,
			configuration({ mode: "auto", autoCompactTokenLimit: 48_000 }),
		);

		let compactInvocations = 0;
		const ctx = context({
			tokens: 50_000,
			compact: () => {
				compactInvocations += 1;
			},
		});

		// Establish rising-edge baseline, then cross the threshold.
		coordinator.setPreviousTokens("session-fixture", 40_000);
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(compactInvocations).toBe(1);
		expect(coordinator.isBusy("session-fixture")).toBe(true);

		// Manual initiator cannot begin while auto is pending.
		expect(coordinator.begin("session-fixture")).toBe(false);

		const firstPromise = handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 12_000),
			ctx,
		);
		await sawCompact;
		expect(runtime.compactCalls).toBe(1);

		const second = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 13_000),
			ctx,
		);
		expect(second).toEqual({ cancel: true });
		expect(runtime.compactCalls).toBe(1);

		releaseCompact?.();
		const first = (await firstPromise) as Record<string, unknown>;
		expect(first.compaction).toBeDefined();
		await handlers.get("session_compact")?.[0]?.(
			{
				type: "session_compact",
				compactionEntry: {
					type: "compaction",
					id: "compaction-entry",
					parentId: "parent-entry",
					timestamp: new Date(0).toISOString(),
					summary: "done",
					firstKeptEntryId: "kept-entry",
					tokensBefore: 12_000,
					details: createCodexCompactionDetails("fixture-model", []),
				},
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		);
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("rejects two concurrent before_compact executions", async () => {
		const runtime = new FixtureRuntime();
		let releaseCompact: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseCompact = resolve;
		});
		let enteredCompact: (() => void) | undefined;
		const sawCompact = new Promise<void>((resolve) => {
			enteredCompact = resolve;
		});
		runtime.compactImpl = async () => {
			enteredCompact?.();
			await gate;
			return {
				status: "completed",
				result: { output: [{ type: "message", role: "assistant", content: [] }] },
			};
		};
		const { handlers, coordinator } = register(runtime);
		const ctx = context();

		const firstPromise = handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 20_000),
			ctx,
		);
		await sawCompact;
		expect(coordinator.isBusy("session-fixture")).toBe(true);
		expect(runtime.compactCalls).toBe(1);

		const second = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("overflow", 30_000),
			ctx,
		);
		expect(second).toEqual({ cancel: true });
		expect(runtime.compactCalls).toBe(1);

		releaseCompact?.();
		const first = (await firstPromise) as Record<string, unknown>;
		expect(first.compaction).toBeDefined();
		coordinator.end("session-fixture", "success");
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("clears state on runtime errors and allows a subsequent retry", async () => {
		const runtime = new FixtureRuntime();
		runtime.compactImpl = async () => {
			throw new Error("fixture compact failure");
		};
		const { handlers, coordinator } = register(runtime);
		const ctx = context();

		await expect(
			handlers.get("session_before_compact")?.[0]?.(compactEvent("manual"), ctx),
		).rejects.toThrow("fixture compact failure");
		expect(coordinator.isBusy("session-fixture")).toBe(false);
		expect(runtime.compactCalls).toBe(1);

		runtime.compactImpl = undefined;
		const retry = (await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 15_000),
			ctx,
		)) as Record<string, unknown>;
		expect(retry.compaction).toMatchObject({ tokensBefore: 15_000 });
		expect(runtime.compactCalls).toBe(2);
		expect(coordinator.isBusy("session-fixture")).toBe(true);
		coordinator.end("session-fixture", "success");
	});

	test("clears a pending auto cycle when provider authentication fails", async () => {
		const runtime = new FixtureRuntime();
		const { handlers, coordinator } = register(
			runtime,
			configuration({ mode: "auto", autoCompactTokenLimit: 48_000 }),
		);
		const ctx = context({ tokens: 50_000, authFailure: true, compact: () => {} });

		coordinator.setPreviousTokens("session-fixture", 40_000);
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(coordinator.isBusy("session-fixture")).toBe(true);

		await expect(
			handlers.get("session_before_compact")?.[0]?.(compactEvent("threshold"), ctx),
		).rejects.toThrow("Provider authentication is unavailable");
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("clears state on cancellation and allows a subsequent retry", async () => {
		const runtime = new FixtureRuntime();
		const controller = new AbortController();
		runtime.compactImpl = async () => {
			controller.abort();
			return { status: "aborted", result: null };
		};
		const { handlers, coordinator } = register(runtime);
		const ctx = context();

		const cancelled = await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 18_000, controller.signal),
			ctx,
		);
		expect(cancelled).toEqual({ cancel: true });
		expect(coordinator.isBusy("session-fixture")).toBe(false);

		runtime.compactImpl = undefined;
		const retry = (await handlers.get("session_before_compact")?.[0]?.(
			compactEvent("manual", 19_000),
			ctx,
		)) as Record<string, unknown>;
		expect(retry.compaction).toMatchObject({ tokensBefore: 19_000 });
		expect(coordinator.isBusy("session-fixture")).toBe(true);
		coordinator.end("session-fixture", "cancel");
		expect(coordinator.isBusy("session-fixture")).toBe(false);
	});

	test("dispose drops in-flight session state", () => {
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.begin("session-a")).toBe(true);
		expect(coordinator.isBusy("session-a")).toBe(true);
		coordinator.setPreviousTokens("session-a", 42);
		coordinator.dispose("session-a");
		expect(coordinator.isBusy("session-a")).toBe(false);
		expect(coordinator.getPreviousTokens("session-a")).toBeUndefined();
		expect(coordinator.begin("session-a")).toBe(true);
	});

	test("isolates busy state across sessions", () => {
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.begin("session-a")).toBe(true);
		expect(coordinator.begin("session-b")).toBe(true);
		expect(coordinator.beginExecution("session-a")).toBe(true);
		expect(coordinator.beginExecution("session-b")).toBe(true);
		expect(coordinator.beginExecution("session-a")).toBe(false);
		coordinator.end("session-a", "success");
		expect(coordinator.begin("session-a")).toBe(true);
		expect(coordinator.isBusy("session-b")).toBe(true);
	});

	test("preserves rising-edge semantics across a successful auto cycle", async () => {
		const runtime = new FixtureRuntime();
		const { handlers, coordinator } = register(
			runtime,
			configuration({ mode: "auto", autoCompactTokenLimit: 48_000 }),
		);
		let compactCalls = 0;
		let tokens = 40_000;
		let compactDone: Promise<void> = Promise.resolve();
		const ctx = {
			...context(),
			getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: tokens / 1000 }),
			compact: (options?: { onComplete?: () => void; onError?: (error: Error) => void }) => {
				compactCalls += 1;
				// Simulate Pi completing the cycle after extension compaction succeeds.
				compactDone = (async () => {
					const result = await handlers.get("session_before_compact")?.[0]?.(
						compactEvent("manual", tokens),
						ctx,
					);
					if ((result as { cancel?: boolean } | undefined)?.cancel) {
						options?.onError?.(new Error("cancelled"));
						return;
					}
					await handlers.get("session_compact")?.[0]?.(
						{
							type: "session_compact",
							compactionEntry: {
								type: "compaction",
								id: "compaction-entry",
								parentId: "parent-entry",
								timestamp: new Date(0).toISOString(),
								summary: "done",
								firstKeptEntryId: "kept-entry",
								tokensBefore: tokens,
								details: createCodexCompactionDetails("fixture-model", []),
							},
							fromExtension: true,
							reason: "manual",
							willRetry: false,
						},
						ctx,
					);
					options?.onComplete?.();
				})();
			},
		} as unknown as ExtensionContext;

		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(compactCalls).toBe(0);

		tokens = 50_000;
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		await compactDone;
		expect(compactCalls).toBe(1);
		expect(runtime.compactCalls).toBe(1);
		expect(coordinator.isBusy("session-fixture")).toBe(false);
		// Success resets observation to null; the next reading is only a baseline.
		expect(coordinator.getPreviousTokens("session-fixture")).toBeNull();

		tokens = 60_000;
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(compactCalls).toBe(1);

		tokens = 70_000;
		// Still above threshold without a rising edge from at/below the limit.
		coordinator.setPreviousTokens("session-fixture", 55_000);
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(compactCalls).toBe(1);

		// Cross again after dipping to/below the threshold.
		coordinator.setPreviousTokens("session-fixture", 48_000);
		tokens = 52_000;
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		await compactDone;
		expect(compactCalls).toBe(2);
		expect(runtime.compactCalls).toBe(2);
	});
});

import { describe, expect, test } from "bun:test";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type {
	CodexRuntime,
	CreateResponseOptions,
	CreateResponseResult,
} from "../../src/application/codex-runtime.ts";
import { CodexCompactionStore } from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { ResolveEffectiveCapabilities } from "../../src/application/resolve-effective-capabilities.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { createCodexStreamSimple } from "../../src/integration/pi/codex-provider.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";

type RuntimeOutcome = {
	readonly status: CreateResponseResult["status"];
	readonly result: unknown;
	readonly event?: unknown;
	readonly thrown?: unknown;
};

class LifecycleRuntime implements CodexRuntime {
	readonly outcome: RuntimeOutcome;
	createResponseCalls = 0;
	#releasePromise: Promise<void>;
	#release!: () => void;

	constructor(outcome: RuntimeOutcome) {
		this.outcome = outcome;
		this.#releasePromise = new Promise<void>((resolve) => {
			this.#release = resolve;
		});
	}

	release(): void {
		this.#release();
	}

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		this.createResponseCalls += 1;
		await this.#releasePromise;
		if (this.outcome.thrown !== undefined) throw this.outcome.thrown;
		if (this.outcome.event !== undefined) await options.onEvent(this.outcome.event);
		return { status: this.outcome.status, result: this.outcome.result };
	}

	async compact(): Promise<never> {
		throw new Error("fixture compact is not configured");
	}

	async readDiagnostics(): Promise<unknown> {
		return { capabilities: ["responses_sse", "remote_compaction_v2", "compact_endpoint"] };
	}

	async resolveModel(modelId: string): Promise<unknown> {
		return {
			model: { slug: modelId, context_window: 100_000 },
			shellSurface: "disabled",
			autoCompactTokenLimit: null,
		};
	}

	async resolveTools(): Promise<unknown> {
		return {
			modelTools: [],
			dispatchTools: [],
			localToolNames: [],
			hostedToolNames: [],
			shellSurface: "disabled",
			sessionSurface: "disabled",
			webSurface: "disabled",
			imageGenerationSurface: "disabled",
			capabilities: {
				sessions: { status: "disabled", reason: "fixture" },
				applyPatch: { status: "disabled", reason: "fixture" },
				viewImage: { status: "disabled", reason: "fixture" },
				imageGeneration: { status: "disabled", reason: "fixture" },
				webSearch: { status: "disabled", reason: "fixture" },
			},
		};
	}

	async estimateContext(): Promise<never> {
		throw new Error("fixture context estimation is not configured");
	}

	async executeTool(): Promise<never> {
		throw new Error("fixture tool execution is not configured");
	}

	async shutdown(): Promise<void> {}
}

function model(): Model<string> {
	return {
		id: "fixture-model",
		name: "fixture-model",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
}

function context(): Context {
	return {
		systemPrompt: "",
		messages: [{ role: "user", content: "fixture input", timestamp: 1 }],
	};
}

function configuration(): { service: ConfigurationService; loadCalls: () => number } {
	let calls = 0;
	const service = {
		load: async (): Promise<CodexConfig> => {
			calls += 1;
			return createDefaultConfig();
		},
	} as unknown as ConfigurationService;
	return { service, loadCalls: () => calls };
}

function healthyProfile(): CodexToolProfileCoordinator {
	return {
		readiness: { kind: "healthy", capabilityKey: "fixture-key" },
		skillLoader: undefined,
		registeredManagedTools: () => [],
		enterPending: () => {},
		installHealthy: () => true,
		installUnavailable: () => {},
		revalidateHealthyOwnership: () => true,
		isHealthy: () => true,
		restorePi: () => {},
		dispose: () => {},
	};
}

function streamFor(
	runtime: LifecycleRuntime,
	configurationService: ConfigurationService,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return createCodexStreamSimple(
		runtime,
		configurationService,
		new ProviderActivationPolicy(configurationService),
		new CodexCompactionStore(),
		new ResolveEffectiveCapabilities(runtime),
		healthyProfile(),
	)(model(), context(), options ?? { apiKey: "fixture-api-key" });
}

async function collect(
	outcome: RuntimeOutcome,
	options?: SimpleStreamOptions,
): Promise<{ events: AssistantMessageEvent[]; runtime: LifecycleRuntime; loadCalls: number }> {
	const runtime = new LifecycleRuntime(outcome);
	const configurationState = configuration();
	const stream = streamFor(runtime, configurationState.service, options);
	const iterator = stream[Symbol.asyncIterator]();
	const first = await iterator.next();
	if (first.done || first.value.type !== "start") {
		throw new Error("provider stream did not emit start");
	}
	const events: AssistantMessageEvent[] = [first.value];
	expect(first.value.partial.stopReason).toBe("pending");
	runtime.release();
	while (true) {
		const next = await iterator.next();
		if (next.done) break;
		events.push(next.value);
		if (next.value.type === "done" || next.value.type === "error") break;
	}
	return { events, runtime, loadCalls: configurationState.loadCalls() };
}

function terminal(events: readonly AssistantMessageEvent[]): AssistantMessageEvent {
	const value = events[events.length - 1];
	if (value === undefined || (value.type !== "done" && value.type !== "error")) {
		throw new Error("provider stream did not emit a terminal event");
	}
	return value;
}

const usage = {
	input_tokens: 1,
	cached_input_tokens: 0,
	output_tokens: 2,
	reasoning_output_tokens: 0,
	total_tokens: 3,
};

describe("Codex provider lifecycle", () => {
	test("starts pending and completes text with no raw stop reason", async () => {
		const result = await collect({
			status: "completed",
			result: { responseId: "response-text", endTurn: true, tokenUsage: usage },
			event: { type: "response.output_text.delta", delta: "fixture" },
		});
		const done = terminal(result.events);
		if (done.type !== "done") throw new Error("expected successful terminal event");
		expect(done.reason).toBe("stop");
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.rawStopReason).toBeUndefined();
		expect(done.message.responseId).toBe("response-text");
		expect(done.message).not.toHaveProperty("endTurn");
	});

	test("maps a completed tool call to toolUse", async () => {
		const result = await collect({
			status: "completed",
			result: { responseId: "response-tool", endTurn: false, tokenUsage: usage },
			event: {
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					call_id: "call-fixture",
					name: "fixture_tool",
					input: '{"value":"fixture"}',
				},
			},
		});
		const done = terminal(result.events);
		if (done.type !== "done") throw new Error("expected successful terminal event");
		expect(done.reason).toBe("toolUse");
		expect(done.message.stopReason).toBe("toolUse");
		expect(done.message.rawStopReason).toBeUndefined();
		expect(done.message).not.toHaveProperty("endTurn");
	});

	test("maps incomplete responses to length even when no stop reason is supplied", async () => {
		const result = await collect({
			status: "incomplete",
			result: { responseId: "response-length", endTurn: false },
		});
		const done = terminal(result.events);
		if (done.type !== "done") throw new Error("expected successful terminal event");
		expect(done.reason).toBe("length");
		expect(done.message.stopReason).toBe("length");
		expect(done.message.rawStopReason).toBeUndefined();
		expect(done.message).not.toHaveProperty("endTurn");
	});

	test.each([
		["failed", "error"],
		["timed_out", "error"],
	] as const)("maps %s responses to error", async (status, expectedReason) => {
		const result = await collect({ status, result: { status } });
		const error = terminal(result.events);
		if (error.type !== "error") throw new Error("expected error terminal event");
		expect(error.reason).toBe(expectedReason);
		expect(error.error.stopReason).toBe(expectedReason);
		expect(error.error.rawStopReason).toBeUndefined();
	});

	test("maps native aborted responses and AbortError exceptions to aborted", async () => {
		const nativeResult = await collect({
			status: "aborted",
			result: { responseId: "response-aborted", endTurn: true },
		});
		const nativeError = terminal(nativeResult.events);
		if (nativeError.type !== "error") throw new Error("expected native abort error event");
		expect(nativeError.reason).toBe("aborted");
		expect(nativeError.error.stopReason).toBe("aborted");
		expect(nativeError.error.rawStopReason).toBeUndefined();
		expect(nativeError.error).not.toHaveProperty("endTurn");

		const thrownError = await collect({
			status: "failed",
			result: {},
			thrown: new DOMException("fixture abort", "AbortError"),
		});
		const exceptionError = terminal(thrownError.events);
		if (exceptionError.type !== "error") throw new Error("expected exception abort error event");
		expect(exceptionError.reason).toBe("aborted");
		expect(exceptionError.error.stopReason).toBe("aborted");
	});

	test("rejects custom fetch before configuration, payload approval, or native dispatch", async () => {
		let payloadCalls = 0;
		const result = await collect(
			{ status: "completed", result: {} },
			{
				apiKey: "fixture-api-key",
				fetch: globalThis.fetch,
				onPayload: () => {
					payloadCalls += 1;
					return undefined;
				},
			},
		);
		const error = terminal(result.events);
		if (error.type !== "error") throw new Error("expected custom fetch error event");
		expect(error.reason).toBe("error");
		expect(error.error.errorMessage).toBe(
			"Codex provider does not support custom fetch for native dispatch",
		);
		expect(error.error.errorMessage).not.toContain("function");
		expect(result.runtime.createResponseCalls).toBe(0);
		expect(result.loadCalls).toBe(0);
		expect(payloadCalls).toBe(0);
	});
});

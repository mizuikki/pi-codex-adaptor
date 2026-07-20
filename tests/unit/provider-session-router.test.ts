import { describe, expect, test } from "bun:test";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { createJiti } from "jiti/static";

import {
	createProviderSessionRouter,
	getProcessProviderSessionRouter,
	type ProviderSessionDispatchers,
} from "../../src/integration/pi/provider-session-router.ts";

const GLOBAL_KEY = Symbol.for("pi-codex-adaptor.provider-session-router.v1");

function model(api = "openai-responses"): Model<string> {
	return {
		id: "fixture-model",
		name: "fixture-model",
		provider: "fixture-provider",
		api,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	} as Model<string>;
}

function dispatchers(calls: string[], owner: string): ProviderSessionDispatchers {
	return {
		codexResponses: () => completedStream(calls, `${owner}:codex`),
		openAiResponses: () => completedStream(calls, `${owner}:openai`),
	};
}

function completedStream(calls: string[], value: string): AssistantMessageEventStream {
	calls.push(value);
	const stream = createAssistantMessageEventStream();
	stream.end();
	return stream;
}

async function events(stream: AssistantMessageEventStream): Promise<unknown[]> {
	const result: unknown[] = [];
	for await (const event of stream) result.push(event);
	return result;
}

describe("provider session router", () => {
	test("routes both APIs to the matching session after child registration", () => {
		const calls: string[] = [];
		const router = createProviderSessionRouter();
		const main = router.createLease(dispatchers(calls, "main"));
		const child = router.createLease(dispatchers(calls, "child"));
		main.bind("session-main");
		child.bind("session-child");

		router.openAiResponses(model(), { messages: [] }, { sessionId: "session-main" });
		router.codexResponses(
			model("openai-codex-responses"),
			{ messages: [] },
			{ sessionId: "session-child" },
		);

		expect(calls).toEqual(["main:openai", "child:codex"]);
	});

	test("rebinding removes the old association and release is idempotent", async () => {
		const calls: string[] = [];
		const router = createProviderSessionRouter();
		const lease = router.createLease(dispatchers(calls, "owner"));
		lease.bind("session-old");
		lease.bind("session-new");

		const stale = await router
			.openAiResponses(model(), { messages: [] }, { sessionId: "session-old" })
			.result();
		router.openAiResponses(model(), { messages: [] }, { sessionId: "session-new" });
		lease.release();
		lease.release();
		const released = await router
			.openAiResponses(model(), { messages: [] }, { sessionId: "session-new" })
			.result();

		expect(stale.stopReason).toBe("error");
		expect(released.stopReason).toBe("error");
		expect(calls).toEqual(["owner:openai"]);
	});

	test("old release cannot remove another binding with the same id", () => {
		const calls: string[] = [];
		const router = createProviderSessionRouter();
		const oldLease = router.createLease(dispatchers(calls, "old"));
		const replacement = router.createLease(dispatchers(calls, "replacement"));
		oldLease.bind("session-shared");
		replacement.bind("session-shared");
		oldLease.release();

		router.openAiResponses(model(), { messages: [] }, { sessionId: "session-shared" });
		expect(calls).toEqual(["replacement:openai"]);
	});

	test("duplicate live bindings fail closed without selecting either", async () => {
		const calls: string[] = [];
		const router = createProviderSessionRouter();
		const first = router.createLease(dispatchers(calls, "first"));
		const second = router.createLease(dispatchers(calls, "second"));
		first.bind("session-duplicate");
		second.bind("session-duplicate");

		const result = await router
			.openAiResponses(model(), { messages: [] }, { sessionId: "session-duplicate" })
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Codex provider route is ambiguous for the current Pi session",
		);
		expect(result.errorMessage).not.toContain("session-duplicate");
		expect(calls).toEqual([]);
	});

	test("missing, blank, unknown, released, and dead-only routes emit safe errors", async () => {
		const calls: string[] = [];
		const router = createProviderSessionRouter();
		const released = router.createLease(dispatchers(calls, "released"));
		released.bind("session-released");
		released.release();
		const deadRouter = createProviderSessionRouter({
			createWeakReference: () => ({ deref: () => undefined }),
		});
		deadRouter.createLease(dispatchers(calls, "dead")).bind("session-dead");

		const streams = [
			router.openAiResponses(model(), { messages: [] }),
			router.openAiResponses(model(), { messages: [] }, { sessionId: "   " }),
			router.openAiResponses(model(), { messages: [] }, { sessionId: "session-unknown" }),
			router.openAiResponses(model(), { messages: [] }, { sessionId: "session-released" }),
			deadRouter.openAiResponses(model(), { messages: [] }, { sessionId: "session-dead" }),
		];

		for (const stream of streams) {
			const emitted = (await events(stream)) as Array<{
				type?: string;
				error?: { errorMessage?: string };
			}>;
			expect(emitted.map((event) => event.type)).toEqual(["start", "error"]);
			expect(emitted[1]?.error?.errorMessage).toBe(
				"Codex provider route is unavailable for the current Pi session",
			);
			for (const syntheticId of ["session-unknown", "session-released", "session-dead"]) {
				expect(emitted[1]?.error?.errorMessage).not.toContain(syntheticId);
			}
		}
		expect(calls).toEqual([]);
	});

	test("rejects blank bindings and terminal rebinding", () => {
		const router = createProviderSessionRouter();
		const lease = router.createLease(dispatchers([], "owner"));
		expect(() => lease.bind("\t")).toThrow("requires a non-empty session id");
		lease.bind("session-owner");
		lease.release();
		expect(() => lease.bind("session-other")).toThrow("cannot be rebound");
	});

	test("uses stable process dispatcher identities", () => {
		const first = getProcessProviderSessionRouter();
		const second = getProcessProviderSessionRouter();
		expect(second).toBe(first);
		expect(second.openAiResponses).toBe(first.openAiResponses);
		expect(second.codexResponses).toBe(first.codexResponses);
	});

	test("shares stable dispatchers across uncached extension module graphs", async () => {
		type RouterModule = typeof import("../../src/integration/pi/provider-session-router.ts");
		const modulePath = new URL(
			"../../src/integration/pi/provider-session-router.ts",
			import.meta.url,
		).pathname;
		const firstLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
		const secondLoader = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
		const firstModule = await firstLoader.import<RouterModule>(modulePath);
		const secondModule = await secondLoader.import<RouterModule>(modulePath);
		expect(secondModule.getProcessProviderSessionRouter).not.toBe(
			firstModule.getProcessProviderSessionRouter,
		);
		const first = firstModule.getProcessProviderSessionRouter();
		const second = secondModule.getProcessProviderSessionRouter();
		expect(second.openAiResponses).toBe(first.openAiResponses);
		expect(second.codexResponses).toBe(first.codexResponses);
	});

	test("fails safely when the versioned global slot is incompatible", () => {
		const previous = Reflect.get(globalThis, GLOBAL_KEY);
		try {
			Reflect.set(globalThis, GLOBAL_KEY, { kind: "foreign-router", version: 1 });
			expect(() => getProcessProviderSessionRouter()).toThrow(
				"Codex provider session router global slot is incompatible",
			);
		} finally {
			if (previous === undefined) Reflect.deleteProperty(globalThis, GLOBAL_KEY);
			else Reflect.set(globalThis, GLOBAL_KEY, previous);
		}
	});
});

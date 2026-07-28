import { describe, expect, test } from "bun:test";
import type { ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

import type { CodexRuntime } from "../../src/application/codex-runtime.ts";
import piCodexAdaptor from "../../src/extension.ts";

describe("extension entry point", () => {
	test("tolerates a loader probe without a complete Pi API", async () => {
		const pi = Object.freeze({});

		await expect(piCodexAdaptor(pi as never)).resolves.toBeUndefined();
	});

	test("registers process-stable Responses dispatchers and lifecycle bindings", async () => {
		const first = registrationFixture();
		const second = registrationFixture();
		await piCodexAdaptor(first.api, { runtime: compatibleRuntime() });
		await piCodexAdaptor(second.api, { runtime: compatibleRuntime() });

		expect(first.commands).toEqual(["codex"]);
		const codexProvider = first.providers.find((provider) => provider.name === "openai-codex");
		expect(codexProvider?.config.api).toBe("openai-codex-responses");
		expect(codexProvider?.config.streamSimple).toBeFunction();
		for (const provider of first.providers.filter((entry) => entry.name !== "openai-codex")) {
			expect(provider.config.api).toBe("openai-responses");
			expect(provider.config.streamSimple).toBeFunction();
		}
		expect(first.events).toEqual(["session_start", "session_shutdown"]);
		expect(second.providers[0]?.config.streamSimple).toBe(first.providers[0]?.config.streamSimple);
		expect(second.providers.map((provider) => provider.name).sort()).toEqual(
			first.providers.map((provider) => provider.name).sort(),
		);

		await first.emit("session_start", "session-first");
		await second.emit("session_start", "session-second");
		await first.emit("session_shutdown", "session-first");
		await second.emit("session_shutdown", "session-second");
	});

	test("fails before provider registration when native Remote Compaction is unavailable", async () => {
		const fixture = registrationFixture();
		let shutdownCalls = 0;
		const runtime = {
			readDiagnostics: async () => ({ capabilities: ["responses_sse"] }),
			shutdown: async () => {
				shutdownCalls += 1;
			},
		} as unknown as CodexRuntime;

		await expect(piCodexAdaptor(fixture.api, { runtime })).rejects.toThrow(
			"Native bridge is incompatible: Remote Compaction is unavailable",
		);
		expect(fixture.providers).toHaveLength(0);
		expect(fixture.commands).toHaveLength(0);
		expect(shutdownCalls).toBe(1);
	});

	test("fails before provider registration when the native handshake rejects the client protocol", async () => {
		const fixture = registrationFixture();
		const runtime = {
			readDiagnostics: async () => {
				throw new Error("bridge protocol version 5 is unsupported; expected 6");
			},
			shutdown: async () => {},
		} as unknown as CodexRuntime;

		await expect(piCodexAdaptor(fixture.api, { runtime })).rejects.toThrow("protocol version 5");
		expect(fixture.providers).toHaveLength(0);
		expect(fixture.commands).toHaveLength(0);
	});

	test("fails closed when the Pi transaction capability is absent", async () => {
		await expect(
			piCodexAdaptor({
				extensionSdkApiVersion: 1,
				registerCommand: () => {},
			} as never),
		).rejects.toThrow(
			"Pi host is incompatible: requires provider payload compaction API version 1",
		);
	});

	test("fails closed when the Pi compaction failure result capability is absent", async () => {
		await expect(
			piCodexAdaptor({
				extensionSdkApiVersion: 1,
				providerPayloadCompactionApiVersion: 1,
				providerCheckpointCommitApiVersion: 1,
				setProviderCheckpointUsageBoundary: () => true,
				registerCommand: () => {},
			} as never),
		).rejects.toThrow("Pi host is incompatible: requires compaction failure result API version 1");
	});

	test("fails closed when the Pi checkpoint commit capability is absent", async () => {
		await expect(
			piCodexAdaptor({
				extensionSdkApiVersion: 1,
				providerPayloadCompactionApiVersion: 1,
				compactionFailureResultApiVersion: 1,
				registerCommand: () => {},
			} as never),
		).rejects.toThrow("Pi host is incompatible: requires provider checkpoint commit API version 1");
	});

	test("fails closed when the extension SDK capability is absent", async () => {
		let registrations = 0;
		await expect(
			piCodexAdaptor({ registerCommand: () => (registrations += 1) } as never),
		).rejects.toThrow("Pi host is incompatible: requires extension SDK API version 1");
		expect(registrations).toBe(0);
	});
});

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

function compatibleRuntime(): CodexRuntime {
	return {
		readDiagnostics: async () => ({
			capabilities: ["responses_sse", "remote_compaction_v2", "compact_endpoint"],
		}),
		shutdown: async () => {},
	} as unknown as CodexRuntime;
}

function registrationFixture(): {
	api: never;
	commands: string[];
	providers: Array<{ name: string; config: ProviderConfig }>;
	events: string[];
	emit(event: string, sessionId: string): Promise<void>;
} {
	const commands: string[] = [];
	const providers: Array<{ name: string; config: ProviderConfig }> = [];
	const events: string[] = [];
	const handlers = new Map<string, LifecycleHandler[]>();
	return {
		api: {
			extensionSdkApiVersion: 1,
			providerPayloadCompactionApiVersion: 1,
			providerCheckpointCommitApiVersion: 1,
			compactionFailureResultApiVersion: 1,
			setProviderCheckpointUsageBoundary: () => true,
			registerCommand: (name: string) => commands.push(name),
			registerProvider: (name: string, config: ProviderConfig) => {
				providers.push({ name, config });
			},
			on: (name: string, handler: LifecycleHandler) => {
				events.push(name);
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as never,
		commands,
		providers,
		events,
		async emit(event, sessionId) {
			const ctx = {
				sessionManager: { getSessionId: () => sessionId },
			} as unknown as ExtensionContext;
			for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
		},
	};
}

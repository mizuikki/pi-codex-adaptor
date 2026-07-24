import { describe, expect, test } from "bun:test";
import type { ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

import piCodexAdaptor from "../../src/extension.ts";

describe("extension entry point", () => {
	test("tolerates a loader probe without a complete Pi API", async () => {
		const pi = Object.freeze({});

		await expect(piCodexAdaptor(pi as never)).resolves.toBeUndefined();
	});

	test("registers process-stable Responses dispatchers and lifecycle bindings", async () => {
		const first = registrationFixture();
		const second = registrationFixture();
		await piCodexAdaptor(first.api);
		await piCodexAdaptor(second.api);

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

	test("fails closed when the Pi transaction capability is absent", async () => {
		await expect(
			piCodexAdaptor({
				registerCommand: () => {},
			} as never),
		).rejects.toThrow(
			"Pi host is incompatible: requires provider payload compaction API version 1",
		);
	});
});

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

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
			providerPayloadCompactionApiVersion: 1,
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

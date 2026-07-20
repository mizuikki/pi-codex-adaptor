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
		expect(first.providers).toHaveLength(2);
		expect(first.providers[0]?.name).toBe("openai-codex");
		expect(first.providers[0]?.config.api).toBe("openai-codex-responses");
		expect(first.providers[0]?.config.streamSimple).toBeFunction();
		expect(first.providers[1]?.name).toBe("pi-codex-adaptor-openai-responses");
		expect(first.providers[1]?.config.api).toBe("openai-responses");
		expect(first.providers[1]?.config.streamSimple).toBeFunction();
		expect(first.events).toEqual(["session_start", "session_shutdown"]);
		expect(second.providers[0]?.config.streamSimple).toBe(first.providers[0]?.config.streamSimple);
		expect(second.providers[1]?.config.streamSimple).toBe(first.providers[1]?.config.streamSimple);

		await first.emit("session_start", "session-first");
		await second.emit("session_start", "session-second");
		await first.emit("session_shutdown", "session-first");
		await second.emit("session_shutdown", "session-second");
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

import { describe, expect, test } from "bun:test";

import piCodexAdaptor from "../../src/extension.ts";

describe("extension entry point", () => {
	test("tolerates a loader probe without a complete Pi API", () => {
		const pi = Object.freeze({});

		expect(() => piCodexAdaptor(pi as never)).not.toThrow();
	});

	test("registers the Codex provider and single settings entry point", () => {
		const commands: string[] = [];
		const providers: string[] = [];
		const events: string[] = [];
		piCodexAdaptor({
			registerCommand: (name: string) => {
				commands.push(name);
			},
			registerProvider: (name: string) => {
				providers.push(name);
			},
			on: (name: string) => {
				events.push(name);
			},
		} as never);

		expect(commands).toEqual(["codex"]);
		expect(providers).toEqual(["openai-codex"]);
		expect(events).toEqual(["session_shutdown"]);
	});
});

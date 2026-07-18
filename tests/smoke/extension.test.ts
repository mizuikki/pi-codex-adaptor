import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

import piCodexAdaptor from "../../src/extension.ts";

describe("extension entry point", () => {
	test("tolerates a loader probe without a complete Pi API", () => {
		const pi = Object.freeze({});

		expect(() => piCodexAdaptor(pi as never)).not.toThrow();
	});

	test("registers the Codex provider and single settings entry point", () => {
		const commands: string[] = [];
		const providers: Array<{ name: string; config: ProviderConfig }> = [];
		const events: string[] = [];
		piCodexAdaptor({
			registerCommand: (name: string) => {
				commands.push(name);
			},
			registerProvider: (name: string, config: ProviderConfig) => {
				providers.push({ name, config });
			},
			on: (name: string) => {
				events.push(name);
			},
		} as never);

		expect(commands).toEqual(["codex"]);
		expect(providers).toHaveLength(1);
		expect(providers[0]?.name).toBe("openai-codex");
		expect(providers[0]?.config.api).toBe("openai-codex-responses");
		expect(providers[0]?.config.streamSimple).toBeFunction();
		expect(events).toEqual(["session_shutdown"]);
	});
});

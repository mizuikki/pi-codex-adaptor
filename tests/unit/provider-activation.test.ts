import { describe, expect, test } from "bun:test";
import type { AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";

import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { createProviderDispatcher } from "../../src/integration/pi/provider-dispatcher.ts";

function model(provider: string, api: string): Model<string> {
	return { provider, api } as Model<string>;
}

function service(initial: CodexConfig = createDefaultConfig()): {
	config: CodexConfig;
	load: () => Promise<CodexConfig>;
	onChange: (listener: (config: CodexConfig) => void) => () => void;
	setLoad(next: () => Promise<CodexConfig>): void;
	publish(config: CodexConfig): void;
} {
	let current = initial;
	let load = async () => current;
	const listeners = new Set<(config: CodexConfig) => void>();
	return {
		get config() {
			return current;
		},
		load: () => load(),
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setLoad: (next) => {
			load = next;
		},
		publish: (config) => {
			current = config;
			for (const listener of listeners) listener(config);
		},
	};
}

describe("provider activation", () => {
	test("uses the default and retains the last valid snapshot across invalid reloads", async () => {
		const repository = service();
		const policy = new ProviderActivationPolicy(repository);
		expect(policy.isActive(model("openai-codex", "openai-codex-responses"))).toBe(true);
		expect(policy.isActive(model("custom-codex", "openai-responses"))).toBe(false);

		const custom = {
			...createDefaultConfig(),
			activation: { providers: ["custom-codex"] },
		};
		repository.setLoad(async () => custom);
		await policy.refresh();
		expect(policy.isActive(model("custom-codex", "openai-responses"))).toBe(true);

		repository.setLoad(async () => {
			throw new Error("invalid fixture configuration");
		});
		await policy.refresh();
		expect(policy.isActive(model("custom-codex", "openai-responses"))).toBe(true);
		expect(policy.isActive(model("openai-codex", "openai-codex-responses"))).toBe(false);
		policy.dispose();
	});

	test("updates immediately after a successful configuration save", () => {
		const repository = service();
		const policy = new ProviderActivationPolicy(repository);
		const custom = {
			...createDefaultConfig(),
			activation: { providers: ["custom-codex"] },
		};
		repository.publish(custom);
		expect(policy.providers()).toEqual(["custom-codex"]);
		expect(policy.decision(model("custom-codex", "unsupported-api"))).toEqual({
			active: false,
			reason: "unsupported_pi_api",
		});
		policy.dispose();
	});

	test("routes both supported APIs synchronously and leaves unselected models native", () => {
		const repository = service({
			...createDefaultConfig(),
			activation: { providers: ["custom-codex"] },
		});
		const policy = new ProviderActivationPolicy(repository);
		repository.publish(repository.config);
		const adaptor = {} as AssistantMessageEventStream;
		const native = {} as AssistantMessageEventStream;
		const context = { messages: [] };
		const dispatcher = createProviderDispatcher(
			policy,
			() => adaptor,
			() => native,
		);

		expect(dispatcher(model("custom-codex", "openai-responses"), context)).toBe(adaptor);
		expect(dispatcher(model("custom-codex", "openai-codex-responses"), context)).toBe(adaptor);
		expect(dispatcher(model("other", "openai-responses"), context)).toBe(native);
		expect(dispatcher(model("custom-codex", "other-api"), context)).toBe(native);
		policy.dispose();
	});
});

import { describe, expect, test } from "bun:test";

import type { CodexRuntime } from "../../src/application/codex-runtime.ts";
import {
	capabilityContextFromSnapshot,
	ResolveEffectiveCapabilities,
} from "../../src/application/resolve-effective-capabilities.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";

class ResolverRuntime implements CodexRuntime {
	resolveToolsCalls = 0;
	readonly capabilities: string[];

	constructor(capabilities: string[]) {
		this.capabilities = capabilities;
	}

	async readDiagnostics(): Promise<unknown> {
		return { capabilities: this.capabilities };
	}

	async resolveModel(modelId: string): Promise<unknown> {
		return {
			model: { slug: modelId, shell_type: "shell_command", context_window: 272_000 },
			shellSurface: "shell-command",
			autoCompactTokenLimit: 244_800,
		};
	}

	async resolveTools(params: unknown): Promise<unknown> {
		this.resolveToolsCalls += 1;
		const input = params as Record<string, unknown>;
		const enabled = (input.sessions as Record<string, unknown>).enabled === true;
		return {
			modelTools: enabled
				? [
						{ type: "function", name: "shell_command" },
						{ type: "function", name: "exec_command" },
						{ type: "function", name: "write_stdin" },
					]
				: [{ type: "function", name: "shell_command" }],
			dispatchTools: [{ type: "function", name: "shell_command" }],
			localToolNames: enabled
				? ["shell_command", "exec_command", "write_stdin"]
				: ["shell_command"],
			hostedToolNames: ["web_search"],
			shellSurface: "shell-command",
			sessionSurface: enabled ? "supplemental" : "disabled",
			webSurface: "hosted",
			imageGenerationSurface: "standalone",
			capabilities: {
				sessions: enabled
					? { status: "available", source: "supplemental" }
					: { status: "disabled", reason: "disabled_by_configuration" },
				applyPatch: { status: "available", source: "official" },
				viewImage: { status: "available", source: "official" },
				imageGeneration: { status: "available", source: "provider-contract" },
				webSearch: { status: "available", source: "provider-contract" },
			},
		};
	}

	async createResponse(): Promise<never> {
		throw new Error("unused");
	}
	async summarizeContext(): Promise<never> {
		throw new Error("unused");
	}
	async compact(): Promise<never> {
		throw new Error("unused");
	}
	async executeTool(): Promise<never> {
		throw new Error("unused");
	}
	async shutdown(): Promise<void> {}
}

const capabilities = [
	"responses_sse",
	"responses_websocket",
	"portable_context_summary",
	"remote_compaction_v2",
	"compact_endpoint",
	"unified_exec",
	"shell_command",
	"apply_patch",
	"view_image",
	"image_generation",
	"hosted_web_search",
];

describe("effective capability application use case", () => {
	test("caches credential-free snapshots and distinguishes configuration fingerprints", async () => {
		const runtime = new ResolverRuntime(capabilities);
		const resolver = new ResolveEffectiveCapabilities(runtime);
		const config = createDefaultConfig();
		const first = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			config,
		});
		const same = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			config,
		});
		expect(same).toBe(first);
		expect(runtime.resolveToolsCalls).toBe(1);
		const unrelated = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			config: {
				...config,
				activation: { providers: ["custom-provider"] },
				security: { approvalPolicy: "bypass" },
				codex: {
					...config.codex,
					serviceTier: "priority",
					verbosity: "high",
					transport: { mode: "sse" },
				},
				ui: { status: false },
			},
		});
		expect(unrelated).toBe(first);
		expect(runtime.resolveToolsCalls).toBe(1);
		const changed = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			config: { ...config, tools: { ...config.tools, backgroundSessions: false } },
		});
		expect(changed).not.toBe(first);
		expect(changed.shell.sessions.status).toBe("disabled");
		expect(capabilityContextFromSnapshot(changed).backgroundSessionsAvailable).toBe(true);
		expect(runtime.resolveToolsCalls).toBe(2);
	});

	test("reports an unavailable candidate when session execution is absent", async () => {
		const runtime = new ResolverRuntime(capabilities.filter((name) => name !== "unified_exec"));
		const snapshot = await new ResolveEffectiveCapabilities(runtime).resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			config: createDefaultConfig(),
		});
		expect(snapshot.shell.sessions).toEqual({
			status: "unavailable",
			reason: "session_executor_unavailable",
		});
		expect(snapshot.shell.sessionSurface).toBe("unavailable");
		expect(capabilityContextFromSnapshot(snapshot).backgroundSessionsAvailable).toBe(false);
	});

	test("requires the portable context summary bridge capability for compaction", async () => {
		const runtime = new ResolverRuntime(
			capabilities.filter((name) => name !== "portable_context_summary"),
		);
		const snapshot = await new ResolveEffectiveCapabilities(runtime).resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			config: createDefaultConfig(),
		});
		expect(snapshot.compaction.implementation).toBeNull();
		expect(snapshot.compaction.manual).toEqual({
			status: "unavailable",
			reason: "compaction_executor_unavailable",
		});
		expect(capabilityContextFromSnapshot(snapshot).portableContextSummary).toBe(false);
	});
});

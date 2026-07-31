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
		const allowed = new Set(input.allowedLocalToolNames as string[]);
		const optional = input.optional as Record<string, unknown>;
		const viewImageEnabled = optional.viewImage === true && allowed.has("view_image");
		const imageGenerationEnabled =
			optional.imageGeneration === true && allowed.has("image_gen.imagegen");
		const modelTools = enabled
			? ["shell_command", "exec_command", "write_stdin"]
			: ["shell_command"];
		const localTools = [
			...modelTools,
			...(viewImageEnabled ? ["view_image"] : []),
			...(imageGenerationEnabled ? ["image_gen.imagegen"] : []),
		];
		return {
			modelTools: localTools
				.filter((name) => allowed.has(name))
				.map((name) => ({
					type: "function",
					name,
				})),
			dispatchTools: allowed.has("shell_command")
				? [{ type: "function", name: "shell_command" }]
				: [],
			localToolNames: localTools.filter((name) => allowed.has(name)),
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
				viewImage: viewImageEnabled
					? { status: "available", source: "official" }
					: optional.viewImage === true
						? { status: "unavailable", reason: "view_image_route_unavailable" }
						: { status: "disabled", reason: "disabled_by_configuration" },
				imageGeneration: imageGenerationEnabled
					? { status: "available", source: "provider-contract" }
					: optional.imageGeneration === true
						? { status: "unavailable", reason: "image_generation_route_unavailable" }
						: { status: "disabled", reason: "disabled_by_configuration" },
				webSearch: { status: "available", source: "provider-contract" },
			},
		};
	}

	async createResponse(): Promise<never> {
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
			modelInputModalities: ["text", "image"],
			config,
		});
		const same = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			modelInputModalities: ["text", "image"],
			config,
		});
		expect(same).toBe(first);
		expect(runtime.resolveToolsCalls).toBe(1);
		const unrelated = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			modelInputModalities: ["text", "image"],
			config: {
				...config,
				activation: { providers: ["custom-provider"] },
				security: { ...config.security, approvalPolicy: "never" },
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
			modelInputModalities: ["text", "image"],
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
			modelInputModalities: ["text", "image"],
			config: createDefaultConfig(),
		});
		expect(snapshot.shell.sessions).toEqual({
			status: "unavailable",
			reason: "session_executor_unavailable",
		});
		expect(snapshot.shell.sessionSurface).toBe("unavailable");
		expect(capabilityContextFromSnapshot(snapshot).backgroundSessionsAvailable).toBe(false);
	});

	test("keys cached snapshots by the host-managed tool policy", async () => {
		const runtime = new ResolverRuntime(capabilities);
		const resolver = new ResolveEffectiveCapabilities(runtime);
		const config = createDefaultConfig();
		const toolLess = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			modelInputModalities: ["text", "image"],
			config,
			hostToolNames: [],
		});
		const same = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			modelInputModalities: ["text", "image"],
			config,
			hostToolNames: [],
		});
		const shellOnly = await resolver.resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			modelInputModalities: ["text", "image"],
			config,
			hostToolNames: ["shell_command"],
		});

		expect(same).toBe(toolLess);
		expect(toolLess.localTools).toEqual([]);
		expect(shellOnly.localTools).toEqual(["shell_command"]);
		expect(runtime.resolveToolsCalls).toBe(2);
	});

	test("narrows image tools and cache identity from selected model input modalities", async () => {
		const runtime = new ResolverRuntime(capabilities);
		const resolver = new ResolveEffectiveCapabilities(runtime);
		const config = createDefaultConfig();
		const textOnly = await resolver.resolve({
			modelId: "custom-model",
			providerId: "custom-provider",
			modelInputModalities: ["text"],
			config,
		});
		const multimodal = await resolver.resolve({
			modelId: "custom-model",
			providerId: "custom-provider",
			modelInputModalities: ["text", "image"],
			config,
		});

		expect(textOnly.localTools).not.toContain("view_image");
		expect(textOnly.localTools).not.toContain("image_gen.imagegen");
		expect(textOnly.viewImage.status).toBe("unavailable");
		expect(textOnly.imageGeneration.status).toBe("unavailable");
		expect(multimodal.localTools).toContain("view_image");
		expect(multimodal.localTools).toContain("image_gen.imagegen");
		expect(multimodal).not.toBe(textOnly);
		expect(runtime.resolveToolsCalls).toBe(2);
	});

	test("requires an official remote compaction bridge capability", async () => {
		const runtime = new ResolverRuntime(
			capabilities.filter((name) => name !== "remote_compaction_v2" && name !== "compact_endpoint"),
		);
		const snapshot = await new ResolveEffectiveCapabilities(runtime).resolve({
			modelId: "gpt-5.5",
			providerId: "openai-codex",
			modelInputModalities: ["text", "image"],
			config: createDefaultConfig(),
		});
		expect(snapshot.compaction.implementation).toBeNull();
		expect(snapshot.compaction.manual).toEqual({
			status: "unavailable",
			reason: "compaction_executor_unavailable",
		});
	});
});

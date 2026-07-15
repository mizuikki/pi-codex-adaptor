import { describe, expect, test } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type {
	CodexAuthentication,
	CodexRuntime,
	CreateResponseOptions,
	CreateResponseResult,
	ExecuteToolOptions,
} from "../../src/application/codex-runtime.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { registerCodexTools } from "../../src/integration/pi/codex-tools.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

class FixtureRuntime implements CodexRuntime {
	shellSurface: "unified-exec" | "shell-command" | "disabled" = "unified-exec";
	execution: ExecuteToolOptions | undefined;
	approvalDecision: string | undefined;

	async createResponse(_options: CreateResponseOptions): Promise<CreateResponseResult> {
		throw new Error("fixture response execution is not configured");
	}

	async compact(): Promise<CreateResponseResult> {
		throw new Error("fixture compaction is not configured");
	}

	async resolveModel(_authentication: CodexAuthentication, modelId: string): Promise<unknown> {
		return {
			model: {
				slug: modelId,
				input_modalities: ["text", "image"],
				apply_patch_tool_type: "freeform",
				shell_type: this.shellSurface === "unified-exec" ? "unified_exec" : "shell_command",
			},
			shellSurface: this.shellSurface,
			autoCompactTokenLimit: 90_000,
			provider: {
				name: "OpenAI",
				supportsWebsockets: true,
				supportsRemoteCompaction: true,
				namespaceTools: true,
				imageGeneration: true,
				hostedWebSearch: true,
			},
		};
	}

	async resolveTools(_authentication: CodexAuthentication, params: unknown): Promise<unknown> {
		const root = params as Record<string, unknown>;
		const provider = root.provider as Record<string, unknown>;
		const standalone = root.standaloneWebSearch as Record<string, unknown>;
		const model = root.model as Record<string, unknown>;
		const useLite = model.use_responses_lite === true;
		const standaloneAvailable =
			provider.namespaceTools === true &&
			(useLite || standalone.featureEnabled === true) &&
			standalone.executorAvailable === true;
		const webSurface = standaloneAvailable
			? "standalone"
			: provider.hostedWebSearch === true
				? "hosted"
				: "unsupported";
		return {
			modelTools: [],
			dispatchTools:
				this.shellSurface === "unified-exec" ? [{ type: "function", name: "shell_command" }] : [],
			shellSurface: this.shellSurface,
			imageGenerationSurface:
				provider.namespaceTools === true && provider.imageGeneration === true
					? "standalone"
					: "disabled",
			webSurface,
		};
	}

	async executeTool(options: ExecuteToolOptions): Promise<CreateResponseResult> {
		this.execution = options;
		if (options.tool === "view_image" || options.tool === "image_gen.imagegen") {
			return {
				status: "completed",
				result: {
					image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
					detail: "high",
				},
			};
		}
		await options.onEvent?.({ type: "tool.output.delta", text: "fixture output" });
		this.approvalDecision = await options.onApproval?.({
			approvalId: "approval-fixture",
			operation: "command",
			summary: "fixture command",
			details: { workdir: options.workdir },
			availableDecisions: ["allow_once", "decline", "cancel"],
		});
		return { status: "completed", result: { output: "fixture output", exit_code: 0 } };
	}

	async shutdown(): Promise<void> {}
}

function fixtureToken(): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function configuration(): ConfigurationService {
	return { load: async () => createDefaultConfig() } as ConfigurationService;
}

function context(provider = "openai-codex"): {
	ctx: ExtensionContext;
	widgets: Map<string, string[] | undefined>;
} {
	const widgets = new Map<string, string[] | undefined>();
	return {
		ctx: {
			model: {
				id: "fixture-model",
				provider,
				api: "fixture-api",
				name: "Fixture",
				baseUrl: "https://invalid.example",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 10_000,
			},
			cwd: "/workspace",
			hasUI: false,
			mode: "print",
			modelRegistry: {
				getApiKeyForProvider: async () => fixtureToken(),
			},
			ui: {
				setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
				notify: () => {},
				select: async (_title: string, choices: string[]) => choices[0],
			},
			sessionManager: {
				getSessionId: () => "fixture-session",
				getBranch: () => [],
				getEntries: () => [],
			},
			getSystemPrompt: () => "",
		} as unknown as ExtensionContext,
		widgets,
	};
}

describe("Pi core tool activation", () => {
	test("recomputes the managed shell surface without deleting third-party tools", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = ["third_party", "shell_command"];
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			configuration(),
		);

		expect([...tools.keys()]).toEqual([
			"update_plan",
			"exec_command",
			"write_stdin",
			"shell_command",
			"apply_patch",
			"view_image",
			"image_gen.imagegen",
			"web.run",
		]);
		const selected = context().ctx;
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, selected);
		expect(active).toEqual([
			"third_party",
			"update_plan",
			"apply_patch",
			"exec_command",
			"write_stdin",
			"view_image",
			"image_gen.imagegen",
		]);

		const other = context("other-provider").ctx;
		await handlers.get("model_select")?.[0]?.({ type: "model_select" }, other);
		expect(active).toEqual(["third_party"]);
	});

	test("publishes plan state and gates native execution through Pi approval", async () => {
		const runtime = new FixtureRuntime();
		const tools = new Map<string, ToolDefinition>();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as never,
			runtime,
			configuration(),
		);
		const { ctx, widgets } = context();
		const plan = await tools
			.get("update_plan")
			?.execute(
				"plan-call",
				{ plan: [{ step: "Fixture step", status: "in_progress" }] } as never,
				undefined,
				undefined,
				ctx,
			);
		expect(plan?.content).toEqual([{ type: "text", text: "Plan updated" }]);
		expect(widgets.get("codex-plan")).toEqual(["Plan", "[>] Fixture step"]);

		const updates: unknown[] = [];
		const command = await tools
			.get("exec_command")
			?.execute(
				"exec-call",
				{ cmd: "fixture command", workdir: "/workspace" } as never,
				undefined,
				(update) => updates.push(update),
				ctx,
			);
		expect(runtime.execution).toEqual({
			authentication: expect.any(Object),
			tool: "exec_command",
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
			argumentsValue: {
				cmd: "fixture command",
				allow_background_sessions: true,
			},
			onEvent: expect.any(Function),
			onApproval: expect.any(Function),
		});
		expect(runtime.approvalDecision).toBe("decline");
		expect(updates).toHaveLength(1);
		expect(command?.details).toMatchObject({ status: "completed", exit_code: 0 });

		const image = await tools
			.get("view_image")
			?.execute(
				"image-call",
				{ path: "/workspace/fixture.png" } as never,
				undefined,
				undefined,
				ctx,
			);
		expect(image?.content).toEqual([
			{ type: "image", mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" },
		]);
		expect(image?.details).toEqual({ status: "completed", detail: "high" });

		const generated = await tools
			.get("image_gen.imagegen")
			?.execute("imagegen-call", { prompt: "fixture image" } as never, undefined, undefined, ctx);
		expect(generated?.content).toEqual([
			{ type: "image", mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" },
		]);
		expect(generated?.details).toEqual({ status: "completed" });

		const web = await tools
			.get("web.run")
			?.execute(
				"web-call",
				{ search_query: [{ q: "fixture" }] } as never,
				undefined,
				undefined,
				ctx,
			);
		expect(web?.content).toEqual([{ type: "text", text: "fixture output" }]);
		expect(web?.details).toEqual({ status: "completed" });
	});

	test("rejects update_plan while Pi plan-mode is active", async () => {
		const runtime = new FixtureRuntime();
		const tools = new Map<string, ToolDefinition>();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as never,
			runtime,
			configuration(),
		);
		const { ctx } = context();
		(ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
			{ type: "custom", customType: "plan-mode", data: { enabled: true } },
		];
		await expect(
			tools
				.get("update_plan")
				?.execute(
					"plan-call",
					{ plan: [{ step: "Fixture step", status: "pending" }] } as never,
					undefined,
					undefined,
					ctx,
				),
		).rejects.toMatchObject({ code: "update_plan_not_allowed" });
	});

	test("keeps shell_command as hidden dispatch under Unified Exec", async () => {
		const runtime = new FixtureRuntime();
		runtime.shellSurface = "unified-exec";
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = ["third_party"];
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			configuration(),
		);
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, context().ctx);
		expect(active).toContain("exec_command");
		expect(active).toContain("write_stdin");
		expect(active).not.toContain("shell_command");
		expect(tools.has("shell_command")).toBe(true);

		const result = await tools
			.get("shell_command")
			?.execute(
				"shell-call",
				{ command: "printf fixture", workdir: "/workspace" } as never,
				undefined,
				undefined,
				context().ctx,
			);
		expect(runtime.execution).toMatchObject({
			tool: "shell_command",
			workdir: "/workspace",
		});
		expect(result?.details).toMatchObject({ status: "completed" });
	});

	test("defaults approval decisions to decline outside interactive TUI", async () => {
		const runtime = new FixtureRuntime();
		const tools = new Map<string, ToolDefinition>();
		const choicesSeen: string[][] = [];
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as never,
			runtime,
			configuration(),
		);
		const { ctx } = context();
		(ctx as { hasUI: boolean }).hasUI = true;
		(ctx as { mode: string }).mode = "rpc";
		(
			ctx.ui as { select: (title: string, choices: string[]) => Promise<string | undefined> }
		).select = async (_title, choices) => {
			choicesSeen.push(choices);
			return choices[0];
		};
		await tools
			.get("exec_command")
			?.execute(
				"exec-call",
				{ cmd: "fixture command", workdir: "/workspace" } as never,
				undefined,
				undefined,
				ctx,
			);
		expect(choicesSeen[0]?.[0]).toBe("Decline");
		expect(runtime.approvalDecision).toBe("decline");
	});

	test("strips model-injected testBaseUrl and unknown execution fields", async () => {
		const runtime = new FixtureRuntime();
		const tools = new Map<string, ToolDefinition>();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as never,
			runtime,
			configuration(),
		);
		const { ctx } = context();
		await tools.get("exec_command")?.execute(
			"exec-call",
			{
				cmd: "printf fixture",
				shell: "/bin/bash",
				workdir: "/workspace",
				testBaseUrl: "http://127.0.0.1:9/v1",
				test_base_url: "http://127.0.0.1:9/v1",
				env: { AUTHORIZATION: "Bearer model-injected" },
				authorization: "Bearer model-injected",
			} as never,
			undefined,
			undefined,
			ctx,
		);
		expect(runtime.execution?.argumentsValue).toEqual({
			cmd: "printf fixture",
			shell: "/bin/bash",
			allow_background_sessions: true,
		});
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("testBaseUrl");
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("test_base_url");
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("env");
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("authorization");
		expect(JSON.stringify(runtime.execution?.argumentsValue)).not.toContain("Authorization");
		expect(JSON.stringify(runtime.execution?.argumentsValue)).not.toContain("127.0.0.1:9");

		await tools.get("image_gen.imagegen")?.execute(
			"imagegen-call",
			{
				prompt: "fixture image",
				testBaseUrl: "http://127.0.0.1:9/v1",
				extra: "drop-me",
			} as never,
			undefined,
			undefined,
			ctx,
		);
		expect(runtime.execution?.argumentsValue).toEqual({ prompt: "fixture image" });
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("testBaseUrl");
	});
});

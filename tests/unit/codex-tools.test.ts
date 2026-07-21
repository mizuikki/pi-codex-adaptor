import { describe, expect, test } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type {
	CodexRuntime,
	CreateResponseOptions,
	CreateResponseResult,
	ExecuteToolOptions,
} from "../../src/application/codex-runtime.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import type { CodexToolProfileCoordinator } from "../../src/integration/pi/codex-tool-profile.ts";
import { PI_CORE_AGENT_TOOL_NAMES } from "../../src/integration/pi/codex-tool-profile.ts";
import {
	nativeAuthorizationFor,
	registerCodexTools,
} from "../../src/integration/pi/codex-tools.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

class FixtureRuntime implements CodexRuntime {
	shellSurface: "unified-exec" | "shell-command" | "disabled" = "unified-exec";
	resolveModelError: Error | undefined;
	execution: ExecuteToolOptions | undefined;
	approvalDecision: string | undefined;
	onExecute: (() => void | Promise<void>) | undefined;

	async createResponse(_options: CreateResponseOptions): Promise<CreateResponseResult> {
		throw new Error("fixture response execution is not configured");
	}

	async compact(): Promise<CreateResponseResult> {
		throw new Error("fixture compaction is not configured");
	}

	async readDiagnostics(): Promise<unknown> {
		return {
			capabilities: [
				"responses_sse",
				"responses_websocket",
				"remote_compaction_v2",
				"compact_endpoint",
				"update_plan",
				"unified_exec",
				"shell_command",
				"apply_patch",
				"view_image",
				"image_generation",
				"standalone_web_search",
				"hosted_web_search",
			],
		};
	}

	async resolveModel(modelId: string): Promise<unknown> {
		if (this.resolveModelError !== undefined) throw this.resolveModelError;
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
				name: "Codex",
				supportsWebsockets: true,
				supportsRemoteCompaction: true,
				namespaceTools: true,
				imageGeneration: true,
				hostedWebSearch: true,
			},
		};
	}

	async resolveTools(params: unknown): Promise<unknown> {
		const root = params as Record<string, unknown>;
		const provider = root.providerContract as Record<string, unknown>;
		const standalone = root.standaloneWebSearch as Record<string, unknown>;
		const sessions = root.sessions as Record<string, unknown>;
		const optional = root.optional as Record<string, unknown>;
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
		const sessionEnabled = sessions.enabled === true;
		const shellTools =
			this.shellSurface === "unified-exec"
				? ["exec_command", "write_stdin"]
				: this.shellSurface === "shell-command"
					? ["shell_command", ...(sessionEnabled ? ["exec_command", "write_stdin"] : [])]
					: [];
		const localToolNames = [
			"update_plan",
			"apply_patch",
			...shellTools,
			...(optional.viewImage === true ? ["view_image"] : []),
			...(provider.imagesApi === true && optional.imageGeneration === true
				? ["image_gen.imagegen"]
				: []),
			...(webSurface === "standalone" ? ["web.run"] : []),
		];
		return {
			modelTools: [],
			dispatchTools:
				this.shellSurface === "unified-exec" ? [{ type: "function", name: "shell_command" }] : [],
			shellSurface: this.shellSurface,
			sessionSurface:
				this.shellSurface === "unified-exec"
					? "official"
					: sessionEnabled
						? "supplemental"
						: "disabled",
			localToolNames,
			hostedToolNames: webSurface === "hosted" ? ["web_search"] : [],
			imageGenerationSurface:
				provider.namespaceTools === true && provider.imagesApi === true ? "standalone" : "disabled",
			webSurface,
			capabilities: {
				sessions: sessionEnabled
					? {
							status: "available",
							source: this.shellSurface === "unified-exec" ? "official" : "supplemental",
						}
					: { status: "disabled", reason: "disabled_by_configuration" },
				applyPatch: { status: "available", source: "official" },
				viewImage:
					optional.viewImage === true
						? { status: "available", source: "official" }
						: { status: "disabled", reason: "disabled_by_configuration" },
				imageGeneration:
					optional.imageGeneration === true
						? { status: "available", source: "provider-contract" }
						: { status: "disabled", reason: "disabled_by_configuration" },
				webSearch:
					webSurface === "unsupported"
						? { status: "unavailable", reason: "web_search_route_unavailable" }
						: { status: "available", source: "provider-contract" },
			},
		};
	}

	async executeTool(options: ExecuteToolOptions): Promise<CreateResponseResult> {
		this.execution = options;
		await this.onExecute?.();
		if (options.tool === "view_image") {
			const detail = options.argumentsValue.detail === "original" ? "original" : "high";
			return {
				status: "completed",
				result: {
					image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
					detail,
				},
			};
		}
		if (options.tool === "image_gen.imagegen") {
			return {
				status: "completed",
				result: {
					image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
					detail: "high",
				},
			};
		}
		await options.onEvent?.({ type: "tool.output.delta", text: "fixture output" });
		if (options.authorization === "require_approval") {
			this.approvalDecision = await options.onApproval?.({
				approvalId: "approval-fixture",
				operation: "command",
				summary: "fixture command",
				details: { workdir: options.workdir },
				availableDecisions: ["allow_once", "decline", "cancel"],
			});
		}
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

type TestConfigurationService = ConfigurationService & {
	config: CodexConfig;
	publish(config: CodexConfig): Promise<void>;
};

function configuration(initial = createDefaultConfig()): TestConfigurationService {
	let current = initial;
	const listeners = new Set<(config: CodexConfig) => void | Promise<void>>();
	const service: TestConfigurationService = {
		get config() {
			return current;
		},
		load: async () => current,
		onChange: (listener: (config: CodexConfig) => void | Promise<void>) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async publish(config: CodexConfig) {
			current = config;
			await Promise.all([...listeners].map((listener) => Promise.resolve(listener(config))));
		},
	} as unknown as TestConfigurationService;
	return service;
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
				api: "openai-codex-responses",
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
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: fixtureToken(), headers: {} }),
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
	test("maps each persistent policy to one explicit native authorization", () => {
		expect(nativeAuthorizationFor("prompt")).toBe("require_approval");
		expect(nativeAuthorizationFor("bypass")).toBe("preauthorized");
	});

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
				getAllTools: () => [
					{ name: "third_party" },
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
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
		expect([...tools.values()].every((tool) => typeof tool.promptSnippet === "string")).toBe(true);
		expect(tools.get("apply_patch")?.promptSnippet).toBe(
			"Apply a patch to files; prefer workspace-relative paths",
		);
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

	test("isolates before delayed configuration and stays isolated on active resolution failure", async () => {
		const runtime = new FixtureRuntime();
		runtime.resolveModelError = new Error("fixture capability failure");
		const base = configuration();
		let release: ((config: CodexConfig) => void) | undefined;
		const delayedConfig = new Promise<CodexConfig>((resolve) => {
			release = resolve;
		});
		const service = {
			...base,
			load: async () => delayedConfig,
		} as TestConfigurationService;
		const policy = new ProviderActivationPolicy(service);
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = [...PI_CORE_AGENT_TOOL_NAMES, "third_party"];
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...PI_CORE_AGENT_TOOL_NAMES.map((name) => ({ name })),
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			policy,
		);

		const { ctx } = context();
		const activation = handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		await Promise.resolve();
		expect(active).toEqual(["third_party"]);
		release?.(base.config);
		await activation;
		expect(active).toEqual(["third_party"]);
	});

	test("appends healthy Codex skill guidance after Pi's assembled prompt", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const profile: CodexToolProfileCoordinator = {
			readiness: { kind: "healthy", capabilityKey: "fixture-key" },
			skillLoader: "exec_command",
			enterPending: () => {},
			installHealthy: () => true,
			installUnavailable: () => {},
			revalidateHealthyOwnership: () => true,
			isHealthy: () => true,
			restorePi: () => {},
			dispose: () => {},
		};
		registerCodexTools(
			{
				registerTool: () => {},
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: () => {},
			} as never,
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
			undefined,
			profile,
		);
		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				systemPrompt:
					"custom prompt\nappend prompt\n<project_context>fixture context</project_context>\n/skill:review-skill",
				systemPromptOptions: {
					skills: [
						{
							name: "review-skill",
							description: "Review fixture files",
							filePath: "<synthetic>/skills/review/SKILL.md",
							disableModelInvocation: false,
						},
					],
				},
			} as never,
			context().ctx,
		);
		const prompt = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
		expect(prompt?.startsWith("custom prompt\nappend prompt")).toBe(true);
		expect(prompt).toContain("<project_context>fixture context</project_context>");
		expect(prompt).toContain("/skill:review-skill");
		expect(prompt).toContain("Use exec_command to load a matching skill file");
		expect(prompt).toContain("<location>&lt;synthetic&gt;/skills/review/SKILL.md</location>");
	});

	test("rejects a stale active capability result after an inactive transition", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = [...PI_CORE_AGENT_TOOL_NAMES, "third_party"];
		let signalStarted: (() => void) | undefined;
		let releaseResolution: ((value: unknown) => void) | undefined;
		const resolutionStarted = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const capabilities = {
			resolve: async () => {
				signalStarted?.();
				return new Promise((resolve) => {
					releaseResolution = resolve;
				});
			},
			invalidate: () => {},
		};
		const service = configuration();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...PI_CORE_AGENT_TOOL_NAMES.map((name) => ({ name })),
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			new ProviderActivationPolicy(service),
			capabilities as never,
		);

		const activeContext = context().ctx;
		const firstActivation = handlers.get("session_start")?.[0]?.(
			{ type: "session_start" },
			activeContext,
		);
		await resolutionStarted;
		const inactiveContext = context("other-provider").ctx;
		await handlers.get("model_select")?.[0]?.({ type: "model_select" }, inactiveContext);
		expect(active).toEqual([...PI_CORE_AGENT_TOOL_NAMES, "third_party"]);

		releaseResolution?.({ localTools: [] });
		await firstActivation;
		expect(active).toEqual([...PI_CORE_AGENT_TOOL_NAMES, "third_party"]);
	});

	test("restores an inactive profile before configuration load and rejects its stale completion", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = [...PI_CORE_AGENT_TOOL_NAMES, "third_party"];
		const base = configuration();
		let load = (): Promise<CodexConfig> => Promise.resolve(base.config);
		const service = {
			...base,
			load: () => load(),
		} as TestConfigurationService;
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...PI_CORE_AGENT_TOOL_NAMES.map((name) => ({ name })),
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			new ProviderActivationPolicy(service),
		);

		const activeContext = context().ctx;
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, activeContext);
		expect(active).toContain("exec_command");

		let releaseInactive: ((config: CodexConfig) => void) | undefined;
		load = () =>
			new Promise<CodexConfig>((resolve) => {
				releaseInactive = resolve;
			});
		const inactiveContext = context("other-provider").ctx;
		const inactiveTransition = handlers.get("model_select")?.[0]?.(
			{ type: "model_select" },
			inactiveContext,
		);
		expect(active).toEqual([...PI_CORE_AGENT_TOOL_NAMES, "third_party"]);

		load = () => Promise.resolve(base.config);
		await handlers.get("model_select")?.[0]?.({ type: "model_select" }, activeContext);
		expect(active).toContain("exec_command");
		releaseInactive?.(base.config);
		await inactiveTransition;
		expect(active).toContain("exec_command");
		expect(active).not.toContain("read");
	});

	test("enters pending and clears status before loading a same-id model from another provider", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = [...PI_CORE_AGENT_TOOL_NAMES, "third_party"];
		const status = new Map<string, string | undefined>();
		const config = {
			...createDefaultConfig(),
			activation: { providers: ["openai-codex", "custom-codex"] },
		};
		const base = configuration(config);
		let load = (): Promise<CodexConfig> => Promise.resolve(base.config);
		const service = {
			...base,
			load: () => load(),
		} as TestConfigurationService;
		const policy = new ProviderActivationPolicy(service);
		await policy.refresh();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...PI_CORE_AGENT_TOOL_NAMES.map((name) => ({ name })),
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			policy,
		);

		const first = context().ctx;
		(first.ui as { setStatus?: (key: string, value: string | undefined) => void }).setStatus = (
			key,
			value,
		) => status.set(key, value);
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, first);
		expect(status.get("codex-adaptor")).toBe("Codex exec bg web");

		let release: ((config: CodexConfig) => void) | undefined;
		load = () =>
			new Promise<CodexConfig>((resolve) => {
				release = resolve;
			});
		const second = context("custom-codex").ctx;
		(second.ui as { setStatus?: (key: string, value: string | undefined) => void }).setStatus = (
			key,
			value,
		) => status.set(key, value);
		const transition = handlers.get("model_select")?.[0]?.({ type: "model_select" }, second);
		expect(active).toEqual(["third_party"]);
		expect(status.get("codex-adaptor")).toBeUndefined();
		release?.(base.config);
		await transition;
		expect(active).toContain("exec_command");
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
			new ProviderActivationPolicy(configuration()),
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
			tool: "exec_command",
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
			authorization: "require_approval",
			argumentsValue: {
				cmd: "fixture command",
				allow_background_sessions: true,
			},
			onEvent: expect.any(Function),
			onApproval: expect.any(Function),
		});
		expect(runtime.approvalDecision).toBe("decline");
		// Running seed partial plus streamed output delta.
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates[0]).toMatchObject({ details: { status: "running" } });
		expect(command?.content).toEqual([
			{
				type: "text",
				text: 'fixture output\n{"status":"completed","exit_code":0}',
			},
		]);
		expect(command?.details).toMatchObject({ status: "completed", exit_code: 0 });

		const image = await tools
			.get("view_image")
			?.execute(
				"image-call",
				{ path: "/workspace/fixture.png", detail: "original" } as never,
				undefined,
				undefined,
				ctx,
			);
		expect(tools.get("view_image")?.parameters).toMatchObject({
			additionalProperties: false,
			properties: {
				detail: { type: "string", enum: ["high", "original"] },
			},
			required: ["path"],
		});
		expect(runtime.execution).toMatchObject({
			tool: "view_image",
			argumentsValue: { path: "/workspace/fixture.png", detail: "original" },
		});
		expect(image?.content).toEqual([
			{ type: "image", mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" },
		]);
		expect(image?.details).toEqual({ status: "completed", detail: "original" });

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

	test("snapshots bypass authorization at native tool dispatch", async () => {
		const runtime = new FixtureRuntime();
		const tools = new Map<string, ToolDefinition>();
		const service = configuration({
			...createDefaultConfig(),
			security: { approvalPolicy: "bypass" },
		});
		runtime.onExecute = () =>
			service.publish({ ...createDefaultConfig(), security: { approvalPolicy: "prompt" } });
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as never,
			runtime,
			service,
			new ProviderActivationPolicy(service),
		);
		const { ctx } = context();

		await tools
			.get("exec_command")
			?.execute(
				"exec-call",
				{ cmd: "fixture command", workdir: "/workspace" } as never,
				undefined,
				undefined,
				ctx,
			);

		expect(runtime.execution).toMatchObject({
			tool: "exec_command",
			authorization: "preauthorized",
		});
		expect(runtime.approvalDecision).toBeUndefined();
		expect(service.config.security.approvalPolicy).toBe("prompt");
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
			new ProviderActivationPolicy(configuration()),
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
				getAllTools: () => [
					{ name: "third_party" },
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			configuration(),
			new ProviderActivationPolicy(configuration()),
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
			new ProviderActivationPolicy(configuration()),
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

	test("strips model-injected provider connection and unknown execution fields", async () => {
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
			new ProviderActivationPolicy(configuration()),
		);
		const { ctx } = context();
		await tools.get("exec_command")?.execute(
			"exec-call",
			{
				cmd: "printf fixture",
				shell: "/bin/bash",
				workdir: "/workspace",
				connection: {
					providerId: "model-injected",
					baseUrl: "http://127.0.0.1:9/v1",
					authentication: { kind: "bearer", token: "model-injected" },
				},
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
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("connection");
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("env");
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("authorization");
		expect(JSON.stringify(runtime.execution?.argumentsValue)).not.toContain("Authorization");
		expect(JSON.stringify(runtime.execution?.argumentsValue)).not.toContain("127.0.0.1:9");

		await tools.get("image_gen.imagegen")?.execute(
			"imagegen-call",
			{
				prompt: "fixture image",
				connection: {
					providerId: "model-injected",
					baseUrl: "http://127.0.0.1:9/v1",
					authentication: { kind: "bearer", token: "model-injected" },
				},
				extra: "drop-me",
			} as never,
			undefined,
			undefined,
			ctx,
		);
		expect(runtime.execution?.argumentsValue).toEqual({ prompt: "fixture image" });
		expect(runtime.execution?.argumentsValue).not.toHaveProperty("connection");
	});

	test("recomputes managed tools immediately after configuration save", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = ["third_party"];
		const status = new Map<string, string | undefined>();
		const service = configuration();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			new ProviderActivationPolicy(service),
		);

		const { ctx } = context();
		(ctx.ui as { setStatus?: (key: string, text: string | undefined) => void }).setStatus = (
			key,
			text,
		) => status.set(key, text);

		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		expect(active).toContain("view_image");
		expect(active).toContain("image_gen.imagegen");
		expect(status.get("codex-adaptor")).toBe("Codex exec bg web");

		// Successful settings save/reset/restore publishes the validated snapshot via onChange.
		await service.publish({
			...service.config,
			tools: {
				...service.config.tools,
				optional: { viewImage: "off", imageGeneration: "off" },
			},
			codex: {
				...service.config.codex,
				webSearch: { mode: "disabled" },
			},
			ui: { status: false },
		});

		expect(active).toEqual([
			"third_party",
			"update_plan",
			"apply_patch",
			"exec_command",
			"write_stdin",
		]);
		expect(active).not.toContain("view_image");
		expect(active).not.toContain("image_gen.imagegen");
		expect(status.get("codex-adaptor")).toBeUndefined();
	});

	test("disables managed tools when activation providers no longer include the model", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = ["third_party"];
		const service = configuration();
		const policy = new ProviderActivationPolicy(service);
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			policy,
		);

		const { ctx } = context();
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		expect(active).toContain("update_plan");
		expect(policy.isActive(ctx.model)).toBe(true);

		await service.publish({
			...service.config,
			activation: { providers: ["custom-codex"] },
		});

		expect(policy.isActive(ctx.model)).toBe(false);
		expect(active).toEqual(["third_party"]);
	});

	test("ignores configuration callbacks after session_shutdown", async () => {
		const runtime = new FixtureRuntime();
		const handlers = new Map<string, EventHandler[]>();
		const tools = new Map<string, ToolDefinition>();
		let active = ["third_party"];
		const status = new Map<string, string | undefined>();
		const service = configuration();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: (event: string, handler: EventHandler) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				getActiveTools: () => active,
				getAllTools: () => [
					{ name: "third_party" },
					...[...tools.keys()].map((name) => ({ name })),
				],
				setActiveTools: (next: string[]) => {
					active = next;
				},
			} as never,
			runtime,
			service,
			new ProviderActivationPolicy(service),
		);

		const { ctx } = context();
		(ctx.ui as { setStatus?: (key: string, text: string | undefined) => void }).setStatus = (
			key,
			text,
		) => status.set(key, text);

		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		expect(active).toContain("view_image");

		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
		const toolsAfterShutdown = [...active];
		const statusAfterShutdown = status.get("codex-adaptor");

		await service.publish({
			...service.config,
			tools: {
				...service.config.tools,
				optional: { viewImage: "off", imageGeneration: "off" },
			},
			ui: { status: false },
		});

		expect(active).toEqual(toolsAfterShutdown);
		expect(status.get("codex-adaptor")).toBe(statusAfterShutdown);
	});

	test("binds every managed registration to a compact presentation renderer", () => {
		const tools = new Map<string, ToolDefinition>();
		registerCodexTools(
			{
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				on: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as never,
			new FixtureRuntime(),
			configuration(),
			new ProviderActivationPolicy(configuration()),
		);

		const expected = {
			exec_command: "Running",
			shell_command: "Running",
			write_stdin: "Waiting",
			apply_patch: "Applying patch",
			view_image: "Viewing",
			"image_gen.imagegen": "Generating image",
			"web.run": "Searching web",
			update_plan: "Updating plan",
		} as const;

		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const context = {
			args: {},
			toolCallId: "call-fixture",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: "/workspace",
			executionStarted: false,
			argsComplete: true,
			isPartial: true,
			expanded: false,
			showImages: false,
			isError: false,
		};

		for (const [name, fragment] of Object.entries(expected)) {
			const tool = tools.get(name);
			expect(tool?.renderShell).toBe("self");
			expect(typeof tool?.renderCall).toBe("function");
			expect(typeof tool?.renderResult).toBe("function");
			const args =
				name === "exec_command"
					? { cmd: "fixture" }
					: name === "shell_command"
						? { command: "fixture" }
						: name === "write_stdin"
							? { session_id: 1, chars: "" }
							: name === "view_image"
								? { path: "fixture.png" }
								: name === "web.run"
									? { search_query: [{ q: "fixture" }] }
									: name === "update_plan"
										? { plan: [] }
										: name === "image_gen.imagegen"
											? { prompt: "hidden-prompt" }
											: { input: "hidden-patch" };
			const call = tool?.renderCall?.(args as never, theme as never, context as never);
			const text =
				call
					?.render(120)
					.map((line) => line.trimEnd())
					.join("\n") ?? "";
			expect(text).toContain(fragment);
			expect(text).not.toContain("hidden-prompt");
			expect(text).not.toContain("hidden-patch");
			expect(text).not.toContain("{");
		}

		// Terminal command display hides model-visible metadata while execute content stays unchanged.
		const command = tools.get("exec_command");
		const terminalContext = { ...context, isPartial: false, executionStarted: true };
		const callEmpty = command?.renderCall?.(
			{ cmd: "fixture command" } as never,
			theme as never,
			terminalContext as never,
		);
		expect(callEmpty?.render(80)).toEqual([]);
		const result = command?.renderResult?.(
			{
				content: [
					{
						type: "text",
						text: 'fixture output\n{"status":"completed","exit_code":0}',
					},
				],
				details: { status: "completed", output: "fixture output", exit_code: 0 },
			} as never,
			{ expanded: false, isPartial: false },
			theme as never,
			{ ...terminalContext, args: { cmd: "fixture command" } } as never,
		);
		const resultText =
			result
				?.render(120)
				.map((line) => line.trimEnd())
				.join("\n") ?? "";
		expect(resultText).toContain("Ran fixture command");
		expect(resultText).toContain("fixture output");
		expect(resultText).not.toContain('"exit_code"');
	});
});

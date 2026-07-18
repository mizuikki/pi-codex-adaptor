import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type {
	CodexApprovalRequest,
	CodexProviderConnection,
	CodexRuntime,
} from "../../application/codex-runtime.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import { UpdatePlanUseCase } from "../../application/update-plan.ts";
import { buildToolsResolveParams, parseModelResolution } from "../../domain/capability.ts";
import type { PlanUpdate } from "../../domain/plan.ts";
import { requestCodexApproval } from "../../ui/terminal/approval-prompt.ts";
import { responseItemsFromMessages } from "./codex-provider.ts";
import { OFFICIAL_CORE_TOOL_CONTRACTS, PI_CORE_TOOL_PARAMETERS } from "./generated/core-tools.ts";
import { createProviderConnection } from "./provider-connection.ts";

const MANAGED_TOOLS = [
	"update_plan",
	"exec_command",
	"write_stdin",
	"shell_command",
	"apply_patch",
	"view_image",
	"image_gen.imagegen",
	"web.run",
] as const;
type ManagedTool = (typeof MANAGED_TOOLS)[number];
type NativeManagedTool = Exclude<ManagedTool, "update_plan" | "image_gen.imagegen" | "web.run">;

export function registerCodexTools(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
): void {
	const hiddenDispatchTools = new Set<ManagedTool>();
	registerPlanTool(pi, activation);
	registerNativeTool(pi, runtime, configuration, activation, "exec_command", "Execute command");
	registerNativeTool(pi, runtime, configuration, activation, "write_stdin", "Write to session");
	registerNativeTool(pi, runtime, configuration, activation, "shell_command", "Run shell command");
	registerNativeTool(pi, runtime, configuration, activation, "apply_patch", "Apply patch");
	registerNativeTool(pi, runtime, configuration, activation, "view_image", "View image");
	registerImageGenerationTool(pi, runtime, activation);
	registerStandaloneWebTool(pi, runtime, configuration, activation);

	let activationGeneration = 0;
	const activate = async (ctx: ExtensionContext): Promise<void> => {
		const generation = ++activationGeneration;
		const selected = ctx.model;
		if (selected === undefined || !activation.isActive(selected)) {
			hiddenDispatchTools.clear();
			disableManagedTools(pi);
			setStatus(ctx, undefined);
			return;
		}
		try {
			const config = await configuration.load();
			const resolution = parseModelResolution(await runtime.resolveModel(selected.id), selected.id);
			if (generation !== activationGeneration) return;
			const model = resolution.model;
			const toolResolution = record(
				await runtime.resolveTools(
					buildToolsResolveParams(resolution, {
						webSearchMode: config.codex.webSearch.mode,
						viewImage: config.tools.optional.viewImage === "auto",
						imageGeneration: config.tools.optional.imageGeneration === "auto",
						standaloneWebSearchExecutorAvailable: true,
					}),
				),
			);
			if (generation !== activationGeneration) return;
			const shellSurface = toolResolution?.shellSurface ?? resolution.shellSurface;
			const dispatchTools = Array.isArray(toolResolution?.dispatchTools)
				? toolResolution.dispatchTools
				: [];
			const hiddenDispatch = new Set(
				dispatchTools
					.map((tool) => {
						const value = record(tool);
						return typeof value?.name === "string" ? value.name : undefined;
					})
					.filter(
						(name): name is ManagedTool =>
							typeof name === "string" && (MANAGED_TOOLS as readonly string[]).includes(name),
					),
			);
			// Unified Exec keeps shell_command dispatch-only: registered and executable, not model-visible.
			if (shellSurface === "unified-exec") hiddenDispatch.add("shell_command");
			else hiddenDispatch.delete("shell_command");
			hiddenDispatchTools.clear();
			for (const name of hiddenDispatch) hiddenDispatchTools.add(name);

			const active: ManagedTool[] = ["update_plan"];
			if (model.apply_patch_tool_type === "freeform") active.push("apply_patch");
			if (shellSurface === "unified-exec") active.push("exec_command", "write_stdin");
			if (shellSurface === "shell-command") active.push("shell_command");
			if (
				config.tools.optional.viewImage === "auto" &&
				Array.isArray(model.input_modalities) &&
				model.input_modalities.includes("image")
			) {
				active.push("view_image");
			}
			if (
				config.tools.optional.imageGeneration === "auto" &&
				toolResolution?.imageGenerationSurface === "standalone"
			) {
				active.push("image_gen.imagegen");
			}
			if (toolResolution?.webSurface === "standalone") active.push("web.run");
			const visible = active.filter((name) => !hiddenDispatchTools.has(name));
			setManagedTools(pi, visible);
			const webSurface =
				typeof toolResolution?.webSurface === "string" ? toolResolution.webSurface : "unsupported";
			setStatus(
				ctx,
				config.ui.status ? `Codex 0.144.3 | ${shellSurface} | ${webSurface}` : undefined,
			);
		} catch {
			if (generation === activationGeneration) {
				hiddenDispatchTools.clear();
				disableManagedTools(pi);
				setStatus(ctx, "Codex unavailable");
			}
		}
	};

	pi.on("session_start", (_event, ctx) => activate(ctx));
	pi.on("model_select", (_event, ctx) => activate(ctx));
}

function registerStandaloneWebTool(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
): void {
	const namespace = OFFICIAL_CORE_TOOL_CONTRACTS.web;
	const contract = namespace.tools[0];
	pi.registerTool({
		name: `${namespace.name}.${contract.name}`,
		label: "Web search",
		description: contract.description,
		parameters: contract.parameters as TSchema,
		renderShell: "self",
		renderCall: (args, theme) =>
			new Text(
				theme.fg("toolTitle", theme.bold(`web.run ${compactText(JSON.stringify(args), 72)}`)),
				0,
				0,
			),
		renderResult: (result, options, theme) => renderToolResult(result, options, theme),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const connection = await resolveProviderConnection(ctx, activation);
			const config = await configuration.load();
			const conversationItems = responseItemsFromMessages(
				ctx.sessionManager.getBranch().flatMap((entry) => {
					const value = record(entry);
					return value?.type === "message" ? [value.message] : [];
				}),
			);
			const result = await runtime.executeTool({
				connection,
				tool: "web.run",
				argumentsValue: buildWebRunArguments(params, {
					conversationItems,
					model: ctx.model?.id,
					requestSessionId: ctx.sessionManager.getSessionId(),
					webSearchMode: config.codex.webSearch.mode,
				}),
				workdir: ctx.cwd,
				workspaceRoots: [ctx.cwd],
				...(signal === undefined ? {} : { signal }),
				onApproval: (approval) => requestApproval(ctx, approval, signal),
			});
			const details = record(result.result);
			const output = typeof details?.output === "string" ? details.output : "";
			return {
				content: [{ type: "text", text: output }],
				details: { status: result.status },
			};
		},
	});
}

function registerImageGenerationTool(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	activation: ProviderActivationPolicy,
): void {
	const namespace = OFFICIAL_CORE_TOOL_CONTRACTS.image_gen;
	const contract = namespace.tools[0];
	pi.registerTool({
		name: `${namespace.name}.${contract.name}`,
		label: "Generate image",
		description: contract.description,
		parameters: contract.parameters as TSchema,
		renderShell: "self",
		renderCall: (args, theme) =>
			new Text(
				theme.fg("toolTitle", theme.bold(`image_gen ${compactText(JSON.stringify(args), 72)}`)),
				0,
				0,
			),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const connection = await resolveProviderConnection(ctx, activation);
			const argumentsValue = buildImageGenerationArguments(params, ctx);
			const result = await runtime.executeTool({
				connection,
				tool: "image_gen.imagegen",
				argumentsValue,
				workdir: ctx.cwd,
				workspaceRoots: [ctx.cwd],
				...(signal === undefined ? {} : { signal }),
				onApproval: (approval) => requestApproval(ctx, approval, signal),
			});
			const details = record(result.result);
			const image = imageContent(details?.image_url);
			if (image === undefined) throw new Error("Native image generation result is invalid");
			return { content: [image], details: { status: result.status } };
		},
	});
}

function registerPlanTool(pi: ExtensionAPI, activation: ProviderActivationPolicy): void {
	const contract = OFFICIAL_CORE_TOOL_CONTRACTS.update_plan;
	pi.registerTool({
		name: contract.name,
		label: "Update plan",
		description: contract.description,
		parameters: contract.parameters as TSchema,
		renderShell: "self",
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("update_plan")), 0, 0),
		renderResult: (result, options, theme) => renderToolResult(result, options, theme),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			assertActive(ctx, activation);
			let update: PlanUpdate | undefined;
			const useCase = new UpdatePlanUseCase({
				publish: (next) => {
					update = next;
					ctx.ui.setWidget("codex-plan", renderPlan(next));
				},
			});
			const output = await useCase.execute(params, detectPlanMode(ctx));
			return {
				content: [{ type: "text", text: output }],
				details: update,
			};
		},
	});
}

function registerNativeTool(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
	name: NativeManagedTool,
	label: string,
): void {
	const contract = OFFICIAL_CORE_TOOL_CONTRACTS[name];
	const parameters =
		name === "apply_patch"
			? PI_CORE_TOOL_PARAMETERS.apply_patch
			: "parameters" in contract
				? contract.parameters
				: PI_CORE_TOOL_PARAMETERS.apply_patch;
	pi.registerTool({
		name: contract.name,
		label,
		description: contract.description,
		parameters: parameters as TSchema,
		renderShell: "self",
		renderCall: (args, theme) => {
			const value = record(args);
			const summary =
				typeof value?.command === "string"
					? value.command
					: typeof value?.input === "string"
						? value.input
						: typeof value?.path === "string"
							? value.path
							: "";
			return new Text(
				theme.fg("toolTitle", theme.bold(`${name} ${compactText(summary, 72)}`)),
				0,
				0,
			);
		},
		renderResult: (result, options, theme) => renderToolResult(result, options, theme),
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			assertActive(ctx, activation);
			const config = await configuration.load();
			let streamedOutput = "";
			const result = await runtime.executeTool({
				tool: name,
				argumentsValue: buildNativeToolArguments(name, params, config.tools.backgroundSessions),
				workdir: workdirFrom(params, ctx.cwd),
				workspaceRoots: [ctx.cwd],
				...(signal === undefined ? {} : { signal }),
				onEvent: (event) => {
					const delta = toolOutputDelta(event);
					if (delta === undefined) return;
					streamedOutput += delta;
					onUpdate?.({
						content: [{ type: "text", text: streamedOutput }],
						details: { status: "running" },
					});
				},
				onApproval: (approval) => requestApproval(ctx, approval, signal),
			});
			const details = record(result.result) ?? {};
			if (name === "view_image") {
				const image = imageContent(details.image_url);
				if (image === undefined) throw new Error("Native image result is invalid");
				return {
					content: [image],
					details: { status: result.status, detail: details.detail },
				};
			}
			const output = typeof details.output === "string" ? details.output : streamedOutput;
			return {
				content: [
					{
						type: "text",
						text: output.length > 0 ? output : `Command ${result.status}`,
					},
				],
				details: { status: result.status, ...details },
			};
		},
	});
}

async function resolveProviderConnection(
	ctx: ExtensionContext,
	activation: ProviderActivationPolicy,
): Promise<CodexProviderConnection> {
	const model = ctx.model;
	assertActive(ctx, activation);
	if (model === undefined) throw new Error("Codex tools require an active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error("Provider authentication is unavailable");
	return createProviderConnection(model, {
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(auth.headers === undefined ? {} : { headers: auth.headers }),
	});
}

function assertActive(ctx: ExtensionContext, activation: ProviderActivationPolicy): void {
	if (!activation.isActive(ctx.model)) {
		throw new Error("Codex tools are inactive for the selected provider and API");
	}
}

async function requestApproval(
	ctx: ExtensionContext,
	approval: CodexApprovalRequest,
	signal?: AbortSignal,
): Promise<"allow_once" | "decline" | "cancel"> {
	return requestCodexApproval(ctx, approval, signal);
}

function detectPlanMode(ctx: ExtensionContext): "default" | "plan" {
	const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getEntries?: () => readonly unknown[];
	};
	const entries =
		typeof manager.getEntries === "function" ? manager.getEntries() : manager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = record(entries[index]);
		if (entry?.type === "custom" && entry.customType === "plan-mode") {
			const data = record(entry.data);
			return data?.enabled === true ? "plan" : "default";
		}
		if (
			entry?.type === "custom_message" &&
			entry.customType === "plan-mode-context" &&
			typeof entry.content === "string" &&
			entry.content.includes("[PLAN MODE ACTIVE]")
		) {
			return "plan";
		}
	}
	const prompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	return prompt.includes("[PLAN MODE ACTIVE]") ? "plan" : "default";
}

function setManagedTools(pi: ExtensionAPI, activeManaged: readonly ManagedTool[]): void {
	const managed = new Set<string>(MANAGED_TOOLS);
	const active = pi.getActiveTools().filter((name) => !managed.has(name));
	pi.setActiveTools([...active, ...activeManaged]);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	const ui = ctx.ui as unknown as { setStatus?: (key: string, text: string | undefined) => void };
	ui.setStatus?.("codex-adaptor", value);
}

function disableManagedTools(pi: ExtensionAPI): void {
	setManagedTools(pi, []);
}

function workdirFrom(value: unknown, fallback: string): string {
	const params = record(value);
	return typeof params?.workdir === "string" && params.workdir.length > 0
		? params.workdir
		: fallback;
}

function toolOutputDelta(value: unknown): string | undefined {
	const event = record(value);
	return event?.type === "tool.output.delta" && typeof event.text === "string"
		? event.text
		: undefined;
}

function imageContent(
	value: unknown,
): { type: "image"; data: string; mimeType: string } | undefined {
	if (typeof value !== "string" || !value.startsWith("data:")) return undefined;
	const separator = value.indexOf(",");
	if (separator < 0) return undefined;
	const metadata = value.slice(5, separator).split(";");
	const mimeType = metadata[0];
	if (mimeType === undefined || metadata[1] !== "base64") return undefined;
	return { type: "image", mimeType, data: value.slice(separator + 1) };
}

function recentConversationImageUrls(ctx: ExtensionContext, count: number): string[] {
	const images: string[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0 && images.length < count; index -= 1) {
		const entry = record(branch[index]);
		const message = entry?.type === "message" ? record(entry.message) : undefined;
		if (message === undefined || !Array.isArray(message.content)) continue;
		for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
			const content = record(message.content[contentIndex]);
			if (
				content?.type === "image" &&
				typeof content.data === "string" &&
				typeof content.mimeType === "string"
			) {
				images.push(`data:${content.mimeType};base64,${content.data}`);
				if (images.length === count) break;
			}
		}
	}
	return images.reverse();
}

function renderPlan(update: PlanUpdate): string[] {
	const lines = ["Plan"];
	for (const item of update.plan) {
		const marker =
			item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
		lines.push(`${marker} ${item.step}`);
	}
	return lines;
}

function renderToolResult(
	result: { content: readonly { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg(color: string, text: string): string },
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "[running]"), 0, 0);
	const details = record(result.details);
	const status = typeof details?.status === "string" ? details.status : "completed";
	const label = status === "completed" ? "[ok]" : `[${status}]`;
	const color = status === "completed" ? "success" : "error";
	const content = result.content.find((item) => item.type === "text");
	const output = typeof content?.text === "string" ? content.text : "";
	let text = theme.fg(color, label);
	if (output.length > 0) text += theme.fg("dim", ` ${compactText(output, 88)}`);
	if (options.expanded && output.length > 0) text += `\n${boundedOutput(output)}`;
	return new Text(text, 0, 0);
}

function buildNativeToolArguments(
	name: NativeManagedTool,
	params: unknown,
	allowBackgroundSessions: boolean,
): Record<string, unknown> {
	const source = record(params) ?? {};
	switch (name) {
		case "exec_command":
			return {
				...pickString(source, "cmd"),
				...pickString(source, "shell"),
				...pickBoolean(source, "login"),
				...pickNumber(source, "max_output_tokens"),
				...pickBoolean(source, "tty"),
				...pickNumber(source, "yield_time_ms"),
				allow_background_sessions: allowBackgroundSessions,
			};
		case "shell_command":
			return {
				...pickString(source, "command"),
				...pickBoolean(source, "login"),
				...pickNumber(source, "timeout_ms"),
				...pickNumber(source, "max_output_tokens"),
			};
		case "write_stdin":
			return {
				...pickNumber(source, "session_id"),
				...pickString(source, "chars"),
				...pickNumber(source, "yield_time_ms"),
				...pickNumber(source, "max_output_tokens"),
			};
		case "apply_patch":
			return {
				...pickString(source, "input"),
			};
		case "view_image":
			return {
				...pickString(source, "path"),
				...pickString(source, "detail"),
			};
	}
}

function buildImageGenerationArguments(
	params: unknown,
	ctx: ExtensionContext,
): Record<string, unknown> {
	const source = record(params) ?? {};
	const argumentsValue: Record<string, unknown> = {
		...pickString(source, "prompt"),
		...pickStringArray(source, "referenced_image_paths"),
		...pickNumber(source, "num_last_images_to_include"),
	};
	const count = argumentsValue.num_last_images_to_include;
	if (typeof count === "number") {
		argumentsValue.recent_image_urls = recentConversationImageUrls(ctx, count);
	}
	return argumentsValue;
}

function buildWebRunArguments(
	params: unknown,
	host: {
		conversationItems: unknown[];
		model: string | undefined;
		requestSessionId: string;
		webSearchMode: string;
	},
): Record<string, unknown> {
	return {
		commands: record(params) ?? {},
		conversation_items: host.conversationItems,
		...(host.model === undefined ? {} : { model: host.model }),
		request_session_id: host.requestSessionId,
		web_search_mode: host.webSearchMode,
	};
}

function pickString(source: Record<string, unknown>, key: string): Record<string, string> {
	const value = source[key];
	return typeof value === "string" ? { [key]: value } : {};
}

function pickBoolean(source: Record<string, unknown>, key: string): Record<string, boolean> {
	const value = source[key];
	return typeof value === "boolean" ? { [key]: value } : {};
}

function pickNumber(source: Record<string, unknown>, key: string): Record<string, number> {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function pickStringArray(source: Record<string, unknown>, key: string): Record<string, string[]> {
	const value = source[key];
	if (!Array.isArray(value)) return {};
	const items = value.filter((entry): entry is string => typeof entry === "string");
	return items.length === value.length ? { [key]: items } : {};
}

function compactText(value: string, limit: number): string {
	const normalized = value.replaceAll(/\s+/g, " ").trim();
	return normalized.length <= limit
		? normalized
		: `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function boundedOutput(value: string): string {
	const lines = value.split("\n");
	if (lines.length <= 12) return lines.map((line) => `  ${line}`).join("\n");
	const head = lines.slice(0, 6);
	const tail = lines.slice(-6);
	return [...head, `  ... ${lines.length - 12} lines omitted ...`, ...tail]
		.map((line) => (line.startsWith("  ") ? line : `  ${line}`))
		.join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

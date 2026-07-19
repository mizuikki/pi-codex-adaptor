import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type {
	CodexApprovalRequest,
	CodexRuntime,
	NativeAuthorization,
} from "../../application/codex-runtime.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	capabilityCacheKey,
	ResolveEffectiveCapabilities,
} from "../../application/resolve-effective-capabilities.ts";
import { UpdatePlanUseCase } from "../../application/update-plan.ts";
import type { ManagedToolName } from "../../domain/capability.ts";
import type { ApprovalPolicy, CodexConfig } from "../../domain/config.ts";
import type { PlanUpdate } from "../../domain/plan.ts";
import { resolveProviderActivation } from "../../domain/provider-activation.ts";
import { requestCodexApproval } from "../../ui/terminal/approval-prompt.ts";
import { APPROVAL_BYPASS_WARNING } from "../../ui/terminal/settings-model.ts";
import { responseItemsFromMessages } from "./codex-provider.ts";
import { codexSkillsPrompt } from "./codex-system-prompt.ts";
import { type CodexToolProfileCoordinator, createCodexToolProfile } from "./codex-tool-profile.ts";
import { OFFICIAL_CORE_TOOL_CONTRACTS, PI_CORE_TOOL_PARAMETERS } from "./generated/core-tools.ts";
import { assertProviderActive, resolveProviderConnection } from "./provider-connection.ts";

type ManagedTool = ManagedToolName;
type NativeManagedTool = Exclude<ManagedTool, "update_plan" | "image_gen.imagegen" | "web.run">;

export function registerCodexTools(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: Pick<ConfigurationService, "load"> &
		Partial<Pick<ConfigurationService, "onChange">>,
	activation: ProviderActivationPolicy,
	capabilities = new ResolveEffectiveCapabilities(runtime),
	profile: CodexToolProfileCoordinator = createCodexToolProfile(pi),
): void {
	let startupBypassWarningShown = false;
	registerPlanTool(pi, activation);
	registerNativeTool(pi, runtime, configuration, activation, "exec_command", "Execute command");
	registerNativeTool(pi, runtime, configuration, activation, "write_stdin", "Write to session");
	registerNativeTool(pi, runtime, configuration, activation, "shell_command", "Run shell command");
	registerNativeTool(pi, runtime, configuration, activation, "apply_patch", "Apply patch");
	registerNativeTool(pi, runtime, configuration, activation, "view_image", "View image");
	registerImageGenerationTool(pi, runtime, configuration, activation);
	registerStandaloneWebTool(pi, runtime, configuration, activation);
	pi.on("before_agent_start", (event) => {
		if (profile.readiness.kind !== "healthy") return;
		const section = codexSkillsPrompt(
			event.systemPromptOptions.skills,
			profile.skillLoader,
			event.systemPrompt,
		);
		return section.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}${section}` };
	});

	let activationGeneration = 0;
	// Last session context that owns managed tools/status. Cleared on session_shutdown.
	let activeContext: ExtensionContext | undefined;
	let lastHealthyCapabilityKey: string | undefined;
	let lastHealthyModelIdentity: string | undefined;
	const providerActive = (
		model: ExtensionContext["model"],
		config: Pick<CodexConfig, "activation"> | undefined,
	): boolean => {
		if (config !== undefined) return resolveProviderActivation(model, config).active;
		return activation.isActive(model);
	};

	const activate = async (
		ctx: ExtensionContext,
		configOverride?: CodexConfig,
		startupWarning = false,
	): Promise<void> => {
		const generation = ++activationGeneration;
		const selected = ctx.model;
		const activeBeforeLoad = selected !== undefined && providerActive(selected, configOverride);
		let shouldFailClosed = activeBeforeLoad;
		const selectedIdentity = modelProfileIdentity(selected);
		const suppliedKey =
			activeBeforeLoad && configOverride !== undefined && selected !== undefined
				? capabilityCacheKey({
						modelId: selected.id,
						providerId: selected.provider,
						config: configOverride,
						contextWindow: selected.contextWindow,
					})
				: undefined;
		if (!activeBeforeLoad) {
			profile.restorePi();
			lastHealthyCapabilityKey = undefined;
			lastHealthyModelIdentity = undefined;
			setStatus(ctx, undefined);
		} else if (
			profile.readiness.kind !== "healthy" ||
			lastHealthyCapabilityKey === undefined ||
			lastHealthyModelIdentity !== selectedIdentity ||
			(suppliedKey !== undefined && !profile.isHealthy(suppliedKey))
		) {
			profile.enterPending(suppliedKey);
			setStatus(ctx, undefined);
		}
		try {
			const config = configOverride ?? (await configuration.load());
			if (generation !== activationGeneration) return;
			if (
				startupWarning &&
				!startupBypassWarningShown &&
				config.security.approvalPolicy === "bypass"
			) {
				startupBypassWarningShown = true;
				ctx.ui.notify(APPROVAL_BYPASS_WARNING, "warning");
			}
			if (selected === undefined || !providerActive(selected, config)) {
				profile.restorePi();
				lastHealthyCapabilityKey = undefined;
				lastHealthyModelIdentity = undefined;
				setStatus(ctx, undefined);
				return;
			}
			shouldFailClosed = true;
			const capabilityInput = {
				modelId: selected.id,
				providerId: selected.provider,
				config,
				contextWindow: selected.contextWindow,
			};
			const capabilityKey = capabilityCacheKey(capabilityInput);
			if (profile.isHealthy(capabilityKey)) {
				if (!profile.revalidateHealthyOwnership((message) => ctx.ui.notify(message, "warning"))) {
					lastHealthyCapabilityKey = undefined;
					lastHealthyModelIdentity = undefined;
					setStatus(ctx, "Codex unavailable");
					return;
				}
			} else {
				profile.enterPending(capabilityKey);
				setStatus(ctx, undefined);
			}
			const snapshot = await capabilities.resolve({
				...capabilityInput,
			});
			if (generation !== activationGeneration) return;
			if (
				!profile.installHealthy(
					capabilityKey,
					snapshot.localTools,
					snapshot.localTools.includes("exec_command")
						? "exec_command"
						: snapshot.localTools.includes("shell_command")
							? "shell_command"
							: undefined,
					(message) => ctx.ui.notify(message, "warning"),
				)
			) {
				lastHealthyCapabilityKey = undefined;
				lastHealthyModelIdentity = undefined;
				setStatus(ctx, "Codex unavailable");
				return;
			}
			lastHealthyCapabilityKey = capabilityKey;
			lastHealthyModelIdentity = selectedIdentity;
			const webSurface = snapshot.webSurface;
			setStatus(
				ctx,
				config.ui.status
					? `Codex 0.144.3 | ${snapshot.shell.primary} | sessions:${snapshot.shell.sessionSurface} | web:${webSurface}${
							config.security.approvalPolicy === "bypass" ? " | approvals:bypass" : ""
						}`
					: undefined,
			);
		} catch {
			if (generation === activationGeneration) {
				if (shouldFailClosed) {
					profile.installUnavailable();
					lastHealthyCapabilityKey = undefined;
					lastHealthyModelIdentity = undefined;
				} else {
					profile.restorePi();
					lastHealthyCapabilityKey = undefined;
					lastHealthyModelIdentity = undefined;
				}
				setStatus(ctx, shouldFailClosed ? "Codex unavailable" : undefined);
			}
		}
	};

	const remember = (ctx: ExtensionContext, startupWarning = false): Promise<void> => {
		activeContext = ctx;
		return activate(ctx, undefined, startupWarning);
	};

	// Settings save/reset/restore notify onChange with the validated snapshot. Recompute the
	// current session surface immediately so optional tools and status match activation/config.
	const unsubscribeConfig =
		configuration.onChange?.((config) => {
			const ctx = activeContext;
			if (ctx === undefined) return;
			return activate(ctx, config);
		}) ?? (() => {});

	pi.on("session_start", (_event, ctx) => remember(ctx, true));
	pi.on("model_select", (_event, ctx) => remember(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		// Drop the session context, invalidate in-flight activate work, and unsubscribe so a
		// late save/reset/restore cannot mutate tools/status after shutdown. Matches the
		// extension root disposing activation and shutting down the runtime on this event.
		activationGeneration += 1;
		capabilities.invalidate();
		profile.restorePi();
		setStatus(ctx, undefined);
		lastHealthyCapabilityKey = undefined;
		lastHealthyModelIdentity = undefined;
		activeContext = undefined;
		startupBypassWarningShown = false;
		unsubscribeConfig();
	});
}

function modelProfileIdentity(model: ExtensionContext["model"]): string | undefined {
	if (model === undefined) return undefined;
	return JSON.stringify([model.id, model.provider, model.api, model.contextWindow ?? null]);
}

function registerStandaloneWebTool(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: Pick<ConfigurationService, "load">,
	activation: ProviderActivationPolicy,
): void {
	const namespace = OFFICIAL_CORE_TOOL_CONTRACTS.web;
	const contract = namespace.tools[0];
	pi.registerTool({
		name: `${namespace.name}.${contract.name}`,
		label: "Web search",
		description: contract.description,
		promptSnippet: "Search the web",
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
			const config = await configuration.load();
			const connection = await resolveProviderConnection(
				ctx,
				activation,
				"Codex tools are inactive for the selected provider and API",
			);
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
				authorization: nativeAuthorizationFor(config.security.approvalPolicy),
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
	configuration: Pick<ConfigurationService, "load">,
	activation: ProviderActivationPolicy,
): void {
	const namespace = OFFICIAL_CORE_TOOL_CONTRACTS.image_gen;
	const contract = namespace.tools[0];
	pi.registerTool({
		name: `${namespace.name}.${contract.name}`,
		label: "Generate image",
		description: contract.description,
		promptSnippet: "Generate an image",
		parameters: contract.parameters as TSchema,
		renderShell: "self",
		renderCall: (args, theme) =>
			new Text(
				theme.fg("toolTitle", theme.bold(`image_gen ${compactText(JSON.stringify(args), 72)}`)),
				0,
				0,
			),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const config = await configuration.load();
			const connection = await resolveProviderConnection(
				ctx,
				activation,
				"Codex tools are inactive for the selected provider and API",
			);
			const argumentsValue = buildImageGenerationArguments(params, ctx);
			const result = await runtime.executeTool({
				connection,
				tool: "image_gen.imagegen",
				argumentsValue,
				workdir: ctx.cwd,
				workspaceRoots: [ctx.cwd],
				authorization: nativeAuthorizationFor(config.security.approvalPolicy),
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
		promptSnippet: "Track multi-step work with an explicit plan",
		parameters: contract.parameters as TSchema,
		renderShell: "self",
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("update_plan")), 0, 0),
		renderResult: (result, options, theme) => renderToolResult(result, options, theme),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			assertProviderActive(
				ctx,
				activation,
				"Codex tools are inactive for the selected provider and API",
			);
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
	configuration: Pick<ConfigurationService, "load">,
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
		promptSnippet:
			name === "exec_command"
				? "Run a command that may continue in a session"
				: name === "write_stdin"
					? "Send input to a running command session"
					: name === "shell_command"
						? "Run a bounded shell command"
						: name === "apply_patch"
							? "Apply a patch to files"
							: "Inspect an image file",
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
			assertProviderActive(
				ctx,
				activation,
				"Codex tools are inactive for the selected provider and API",
			);
			const config = await configuration.load();
			let streamedOutput = "";
			const result = await runtime.executeTool({
				tool: name,
				argumentsValue: buildNativeToolArguments(name, params, config.tools.backgroundSessions),
				workdir: workdirFrom(params, ctx.cwd),
				workspaceRoots: [ctx.cwd],
				authorization: nativeAuthorizationFor(config.security.approvalPolicy),
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
			const output = modelVisibleNativeToolResult(result.status, details, streamedOutput);
			return {
				content: [
					{
						type: "text",
						text: output,
					},
				],
				details: { status: result.status, ...details },
			};
		},
	});
}

function modelVisibleNativeToolResult(
	status: string,
	details: Record<string, unknown>,
	streamedOutput: string,
): string {
	const output = typeof details.output === "string" ? details.output : streamedOutput;
	const metadata: Record<string, unknown> = { status };
	for (const [key, value] of Object.entries(details)) {
		if (key !== "output" && key !== "status") metadata[key] = value;
	}
	const serializedMetadata = JSON.stringify(metadata);
	if (output.length === 0) return serializedMetadata;
	return `${output}${output.endsWith("\n") ? "" : "\n"}${serializedMetadata}`;
}

export function nativeAuthorizationFor(policy: ApprovalPolicy): NativeAuthorization {
	switch (policy) {
		case "prompt":
			return "require_approval";
		case "bypass":
			return "preauthorized";
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

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
	const ui = ctx.ui as unknown as { setStatus?: (key: string, text: string | undefined) => void };
	ui.setStatus?.("codex-adaptor", value);
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

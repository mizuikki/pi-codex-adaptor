import type { ShellSurface, WebSearchMode } from "./config.ts";

export const MANAGED_TOOL_NAMES = [
	"update_plan",
	"exec_command",
	"write_stdin",
	"shell_command",
	"apply_patch",
	"view_image",
	"image_gen.imagegen",
	"web.run",
] as const;

export type ManagedToolName = (typeof MANAGED_TOOL_NAMES)[number];
export type AvailabilitySource = "official" | "supplemental" | "provider-contract";
export type Availability =
	| { status: "available"; source: AvailabilitySource }
	| { status: "disabled"; reason: string }
	| { status: "unavailable"; reason: string };

export interface CompleteCodexProviderContract {
	responsesSse: true;
	responsesWebsocket: "official-only" | "unavailable";
	remoteCompactionV2: true;
	compactEndpoint: true;
	namespaceTools: true;
	imagesApi: true;
	searchApi: true;
	hostedWebSearch: true;
}

export interface ResolvedModelCapability {
	model: Record<string, unknown>;
	shellSurface: ShellSurface;
	autoCompactTokenLimit: number | null;
}

export interface NativeToolCapabilityEvidence {
	sessions: Availability;
	applyPatch: Availability;
	viewImage: Availability;
	imageGeneration: Availability;
	webSearch: Availability;
}

export interface ResolvedToolCapability {
	modelTools: readonly unknown[];
	dispatchTools: readonly unknown[];
	localToolNames: readonly ManagedToolName[];
	hostedToolNames: readonly string[];
	shellSurface: ShellSurface;
	sessionSurface: "official" | "supplemental" | "disabled" | "unavailable";
	webSurface: "standalone" | "hosted" | "disabled" | "unsupported";
	imageGenerationSurface: "standalone" | "disabled";
	capabilities: NativeToolCapabilityEvidence;
}

export type CompactionImplementation = "remote_v2" | "compact_endpoint";

export type CapabilityErrorCode =
	| "inactive_provider"
	| "model_metadata_unavailable"
	| "provider_capability_unavailable"
	| "compaction_unsupported"
	| "effective_capability_invalid"
	| "provider_session_unavailable"
	| "provider_contract_mismatch";

export class CapabilityError extends Error {
	readonly code: CapabilityErrorCode;
	readonly reason: string;

	constructor(code: CapabilityErrorCode, reason: string) {
		super(reason);
		this.name = "CapabilityError";
		this.code = code;
		this.reason = reason;
	}
}

export interface ToolsResolveHostOptions {
	providerId: string;
	webSearchMode: WebSearchMode;
	viewImage: boolean;
	imageGeneration: boolean;
	backgroundSessions: boolean;
	bridgeCapabilities: readonly string[];
	allowLoginShell?: boolean;
	execPermissionApprovalsEnabled?: boolean;
}

export function completeProviderContract(providerId: string): CompleteCodexProviderContract {
	return {
		responsesSse: true,
		responsesWebsocket: providerId === "openai-codex" ? "official-only" : "unavailable",
		remoteCompactionV2: true,
		compactEndpoint: true,
		namespaceTools: true,
		imagesApi: true,
		searchApi: true,
		hostedWebSearch: true,
	};
}

/** Parse credential-free model metadata resolved through the pinned native official method. */
export function parseModelResolution(
	value: unknown,
	expectedModelId: string,
): ResolvedModelCapability {
	const root = record(value);
	if (root === undefined) {
		throw metadataError("OpenAI Codex model metadata is unavailable");
	}
	const model = record(root.model);
	if (model === undefined || model.slug !== expectedModelId) {
		throw metadataError("OpenAI Codex model metadata did not match the selected model");
	}
	return {
		model,
		shellSurface: parseShellSurface(root.shellSurface),
		autoCompactTokenLimit: parseAutoCompactTokenLimit(root.autoCompactTokenLimit),
	};
}

/** Build protocol-v4 native resolver input from product policy and verified bridge evidence. */
export function buildToolsResolveParams(
	resolution: ResolvedModelCapability,
	options: ToolsResolveHostOptions,
): Record<string, unknown> {
	const bridge = new Set(options.bridgeCapabilities);
	return {
		model: resolution.model,
		webSearchMode: options.webSearchMode,
		providerContract: completeProviderContract(options.providerId),
		standaloneWebSearch: {
			featureEnabled: false,
			executorAvailable: bridge.has("standalone_web_search"),
		},
		sessions: {
			enabled: options.backgroundSessions,
			executorAvailable: bridge.has("unified_exec"),
		},
		shell: {
			allowLoginShell: options.allowLoginShell ?? true,
			execPermissionApprovalsEnabled: options.execPermissionApprovalsEnabled ?? false,
		},
		optional: {
			viewImage: options.viewImage && bridge.has("view_image"),
			imageGeneration: options.imageGeneration && bridge.has("image_generation"),
		},
	};
}

/** Strictly parse authoritative tool names, surfaces, and effective evidence from native. */
export function parseToolResolution(value: unknown): ResolvedToolCapability {
	const root = requiredRecord(value, "native tools.resolve result");
	const capabilities = requiredRecord(root.capabilities, "native capability evidence");
	return {
		modelTools: array(root.modelTools, "modelTools"),
		dispatchTools: array(root.dispatchTools, "dispatchTools"),
		localToolNames: managedToolNames(root.localToolNames),
		hostedToolNames: stringArray(root.hostedToolNames, "hostedToolNames"),
		shellSurface: enumValue(root.shellSurface, ["unified-exec", "shell-command", "disabled"]),
		sessionSurface: enumValue(root.sessionSurface, [
			"official",
			"supplemental",
			"disabled",
			"unavailable",
		]),
		webSurface: enumValue(root.webSurface, ["standalone", "hosted", "disabled", "unsupported"]),
		imageGenerationSurface: enumValue(root.imageGenerationSurface, ["standalone", "disabled"]),
		capabilities: {
			sessions: parseAvailability(capabilities.sessions),
			applyPatch: parseAvailability(capabilities.applyPatch),
			viewImage: parseAvailability(capabilities.viewImage),
			imageGeneration: parseAvailability(capabilities.imageGeneration),
			webSearch: parseAvailability(capabilities.webSearch),
		},
	};
}

export function parseAvailability(value: unknown): Availability {
	const item = requiredRecord(value, "capability availability");
	if (item.status === "available") {
		return {
			status: "available",
			source: enumValue(item.source, ["official", "supplemental", "provider-contract"]),
		};
	}
	if (item.status === "disabled" || item.status === "unavailable") {
		if (typeof item.reason !== "string" || item.reason.length === 0) {
			throw invalidCapability("capability availability reason is invalid");
		}
		return { status: item.status, reason: item.reason };
	}
	throw invalidCapability("capability availability status is invalid");
}

export function selectCompactionImplementation(
	contract: CompleteCodexProviderContract,
): CompactionImplementation {
	return contract.remoteCompactionV2 ? "remote_v2" : "compact_endpoint";
}

function managedToolNames(value: unknown): ManagedToolName[] {
	const names = stringArray(value, "localToolNames");
	if (new Set(names).size !== names.length) {
		throw invalidCapability("native local tool names contain duplicates");
	}
	for (const name of names) {
		if (!(MANAGED_TOOL_NAMES as readonly string[]).includes(name)) {
			throw invalidCapability("native local tool name is not registered by the adaptor");
		}
	}
	return names as ManagedToolName[];
}

function parseShellSurface(value: unknown): ShellSurface {
	if (value === "unified-exec" || value === "shell-command" || value === "disabled") return value;
	throw metadataError("OpenAI Codex model metadata did not include a valid shell surface");
}

function parseAutoCompactTokenLimit(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	throw metadataError("OpenAI Codex model metadata did not include a valid auto-compact limit");
}

function array(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) throw invalidCapability(`native ${name} is invalid`);
	return value;
}

function stringArray(value: unknown, name: string): string[] {
	const values = array(value, name);
	if (!values.every((item) => typeof item === "string" && item.length > 0)) {
		throw invalidCapability(`native ${name} is invalid`);
	}
	return values as string[];
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
	if (typeof value === "string" && values.includes(value)) return value as T[number];
	throw invalidCapability("native capability enum value is invalid");
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
	const item = record(value);
	if (item === undefined) throw invalidCapability(`${name} is invalid`);
	return item;
}

function metadataError(reason: string): CapabilityError {
	return new CapabilityError("model_metadata_unavailable", reason);
}

function invalidCapability(reason: string): CapabilityError {
	return new CapabilityError("effective_capability_invalid", reason);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

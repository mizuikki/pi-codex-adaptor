import type { ShellSurface, WebSearchMode } from "./config.ts";

/**
 * Official OpenAI provider capability upper bounds returned by models.resolve.
 * Callers may disable more features through configuration, but must not invent
 * capabilities the active provider does not advertise.
 */
export interface OfficialProviderCapabilities {
	name: string;
	supportsWebsockets: boolean;
	supportsRemoteCompaction: boolean;
	namespaceTools: boolean;
	imageGeneration: boolean;
	hostedWebSearch: boolean;
}

export interface ResolvedModelCapability {
	model: Record<string, unknown>;
	shellSurface: ShellSurface;
	autoCompactTokenLimit: number | null;
	provider: OfficialProviderCapabilities;
}

export type CompactionImplementation = "remote_v2" | "compact_endpoint";

export type CapabilityErrorCode =
	| "inactive_provider"
	| "model_metadata_unavailable"
	| "provider_capability_unavailable"
	| "compaction_unsupported";

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
	webSearchMode: WebSearchMode;
	viewImage: boolean;
	imageGeneration: boolean;
	/** Host fact: bundled bridge compiles the standalone web.run executor. */
	standaloneWebSearchExecutorAvailable: boolean;
	allowLoginShell?: boolean;
	execPermissionApprovalsEnabled?: boolean;
}

/**
 * Parse the native models.resolve payload. Missing model or provider capability
 * metadata is an explicit failure rather than a guessed default.
 */
export function parseModelResolution(
	value: unknown,
	expectedModelId: string,
): ResolvedModelCapability {
	const root = record(value);
	if (root === undefined) {
		throw new CapabilityError(
			"model_metadata_unavailable",
			"OpenAI did not return metadata for the requested model",
		);
	}
	const model = record(root.model);
	if (model === undefined || model.slug !== expectedModelId) {
		throw new CapabilityError(
			"model_metadata_unavailable",
			"OpenAI Codex model metadata did not match the selected model",
		);
	}
	const provider = parseProviderCapabilities(root.provider);
	if (provider === undefined) {
		throw new CapabilityError(
			"provider_capability_unavailable",
			"OpenAI Codex provider capability metadata is unavailable",
		);
	}
	const shellSurface = parseShellSurface(root.shellSurface, model);
	const autoCompactTokenLimit = parseAutoCompactTokenLimit(root.autoCompactTokenLimit);
	return { model, shellSurface, autoCompactTokenLimit, provider };
}

/**
 * Official RemoteCompactionV2 when the provider supports remote compaction;
 * otherwise the typed CompactClient endpoint.
 */
export function selectCompactionImplementation(
	provider: OfficialProviderCapabilities,
): CompactionImplementation {
	return provider.supportsRemoteCompaction ? "remote_v2" : "compact_endpoint";
}

/**
 * Build tools.resolve parameters from official model/provider metadata and host
 * policy inputs. Does not hard-code provider WebSocket, hosted, or namespace truth.
 */
export function buildToolsResolveParams(
	resolution: ResolvedModelCapability,
	options: ToolsResolveHostOptions,
): Record<string, unknown> {
	// Official StandaloneWebSearch is under development and default-disabled.
	// Responses Lite still takes the standalone path through model.use_responses_lite.
	return {
		model: resolution.model,
		webSearchMode: options.webSearchMode,
		provider: {
			hostedWebSearch: resolution.provider.hostedWebSearch,
			namespaceTools: resolution.provider.namespaceTools,
			imageGeneration: resolution.provider.imageGeneration,
		},
		standaloneWebSearch: {
			featureEnabled: false,
			executorAvailable: options.standaloneWebSearchExecutorAvailable,
		},
		shell: {
			allowLoginShell: options.allowLoginShell ?? true,
			execPermissionApprovalsEnabled: options.execPermissionApprovalsEnabled ?? false,
		},
		optional: {
			viewImage: options.viewImage,
			imageGeneration: options.imageGeneration,
		},
	};
}

export function parseProviderCapabilities(
	value: unknown,
): OfficialProviderCapabilities | undefined {
	const provider = record(value);
	if (provider === undefined) return undefined;
	if (typeof provider.name !== "string" || provider.name.length === 0) return undefined;
	if (typeof provider.supportsWebsockets !== "boolean") return undefined;
	if (typeof provider.supportsRemoteCompaction !== "boolean") return undefined;
	if (typeof provider.namespaceTools !== "boolean") return undefined;
	if (typeof provider.imageGeneration !== "boolean") return undefined;
	if (typeof provider.hostedWebSearch !== "boolean") return undefined;
	return {
		name: provider.name,
		supportsWebsockets: provider.supportsWebsockets,
		supportsRemoteCompaction: provider.supportsRemoteCompaction,
		namespaceTools: provider.namespaceTools,
		imageGeneration: provider.imageGeneration,
		hostedWebSearch: provider.hostedWebSearch,
	};
}

function parseShellSurface(value: unknown, model: Record<string, unknown>): ShellSurface {
	if (value === "unified-exec" || value === "shell-command" || value === "disabled") {
		return value;
	}
	const shellType = model.shell_type;
	if (shellType === "unified_exec") return "unified-exec";
	if (shellType === "disabled") return "disabled";
	if (
		shellType === "default" ||
		shellType === "local" ||
		shellType === "shell_command" ||
		shellType === undefined
	) {
		return "shell-command";
	}
	throw new CapabilityError(
		"model_metadata_unavailable",
		"OpenAI Codex model metadata did not include a shell surface",
	);
}

function parseAutoCompactTokenLimit(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
	}
	throw new CapabilityError(
		"model_metadata_unavailable",
		"OpenAI Codex model metadata did not include a valid auto-compact limit",
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

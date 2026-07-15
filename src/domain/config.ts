export type AutoOrOff = "auto" | "off";
export type ServiceTier = "default" | "priority" | "flex";
export type Verbosity = "low" | "medium" | "high";
export type TransportMode = "auto" | "sse";
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type ShellSurface = "unified-exec" | "shell-command" | "disabled";

export type CompactionConfig =
	| { mode: "off" }
	| { mode: "auto"; autoCompactTokenLimit: "model" | number };

export interface CodexConfig {
	schemaVersion: 1;
	tools: {
		backgroundSessions: boolean;
		optional: {
			viewImage: AutoOrOff;
			imageGeneration: AutoOrOff;
		};
	};
	openai: {
		serviceTier: ServiceTier;
		verbosity: Verbosity;
		transport: { mode: TransportMode };
		webSearch: { mode: WebSearchMode };
		compaction: CompactionConfig;
	};
	ui: { status: boolean };
}

export type ConfigurationIssueCode =
	| "invalid_type"
	| "invalid_value"
	| "missing_field"
	| "unknown_field"
	| "unsupported_capability"
	| "capability_unavailable";

export interface ConfigurationIssue {
	path: string;
	code: ConfigurationIssueCode;
	message: string;
}

export class ConfigurationError extends Error {
	readonly code: "invalid_configuration";
	readonly issues: readonly ConfigurationIssue[];

	constructor(issues: readonly ConfigurationIssue[]) {
		super("The Codex adaptor configuration is invalid");
		this.name = "ConfigurationError";
		this.code = "invalid_configuration";
		this.issues = issues;
	}
}

/**
 * Optional runtime facts available at save time. Only supplied fields participate in capability
 * checks; missing fields leave the corresponding settings unconstrained.
 */
export interface ConfigCapabilityContext {
	/** Positive model context-window size when known from verified metadata. */
	contextWindow?: number;
	/**
	 * Verified model auto-compact threshold. Use `null` when metadata is present but has no limit.
	 * Leave undefined when model metadata is unavailable.
	 */
	modelAutoCompactTokenLimit?: number | null;
	/** Bridge capability identifiers from handshake or diagnostics. */
	bridgeCapabilities?: readonly string[];
	/** Official shell surface resolved for the current model. */
	shellSurface?: ShellSurface;
	/** Whether the active provider supports WebSocket transport. */
	providerSupportsWebsockets?: boolean;
	/** Whether the active provider can use RemoteCompactionV2. */
	remoteCompactionV2?: boolean;
	/** Whether the compact endpoint is available. */
	compactEndpoint?: boolean;
}

export type SettingAvailability =
	| { status: "enabled" }
	| { status: "disabled"; reason: string }
	| { status: "unsupported"; reason: string };

export interface ConfigSettingEvaluation {
	path: string;
	availability: SettingAvailability;
}

export function createDefaultConfig(): CodexConfig {
	return {
		schemaVersion: 1,
		tools: {
			backgroundSessions: true,
			optional: { viewImage: "auto", imageGeneration: "auto" },
		},
		openai: {
			serviceTier: "default",
			verbosity: "low",
			transport: { mode: "auto" },
			webSearch: { mode: "cached" },
			compaction: { mode: "auto", autoCompactTokenLimit: "model" },
		},
		ui: { status: true },
	};
}

export function parseConfig(value: unknown): CodexConfig {
	const issues: ConfigurationIssue[] = [];
	const root = record(value, "$", issues);
	if (root === undefined) {
		throw new ConfigurationError(issues);
	}
	exactKeys(root, ["schemaVersion", "tools", "openai", "ui"], "$", issues);

	const schemaVersion = literal(root.schemaVersion, 1, "schemaVersion", issues);
	const tools = parseTools(root.tools, issues);
	const openai = parseOpenAi(root.openai, issues);
	const ui = parseUi(root.ui, issues);
	if (
		issues.length > 0 ||
		schemaVersion === undefined ||
		tools === undefined ||
		openai === undefined ||
		ui === undefined
	) {
		throw new ConfigurationError(issues);
	}
	return { schemaVersion, tools, openai, ui };
}

/**
 * Schema-parse a draft and apply capability-aware save gates for the supplied context.
 */
export function validateConfigForSave(
	value: unknown,
	context: ConfigCapabilityContext = {},
): CodexConfig {
	const config = parseConfig(value);
	const issues = collectCapabilityIssues(config, context);
	if (issues.length > 0) {
		throw new ConfigurationError(issues);
	}
	return config;
}

/**
 * Evaluate capability-dependent settings for UI three-state rendering. Does not throw.
 */
export function evaluateConfigSettings(
	config: CodexConfig,
	context: ConfigCapabilityContext = {},
): readonly ConfigSettingEvaluation[] {
	const capabilities = capabilitySet(context.bridgeCapabilities);
	const evaluations: ConfigSettingEvaluation[] = [
		evaluateBackgroundSessions(config, context),
		evaluateOptionalTool(
			"tools.optional.viewImage",
			config.tools.optional.viewImage,
			capabilities,
			"view_image",
			"Unavailable: bridge does not advertise view_image",
		),
		evaluateOptionalTool(
			"tools.optional.imageGeneration",
			config.tools.optional.imageGeneration,
			capabilities,
			"image_generation",
			"Unavailable: bridge does not advertise image_generation",
		),
		evaluateTransport(config, context, capabilities),
		evaluateWebSearch(config, capabilities),
		evaluateCompaction(config, context, capabilities),
	];

	if (config.openai.compaction.mode === "auto") {
		evaluations.push(evaluateAutoCompactTokenLimit(config, context));
	}

	return evaluations;
}

function collectCapabilityIssues(
	config: CodexConfig,
	context: ConfigCapabilityContext,
): ConfigurationIssue[] {
	const issues: ConfigurationIssue[] = [];
	const capabilities = capabilitySet(context.bridgeCapabilities);

	if (
		config.openai.compaction.mode === "auto" &&
		typeof config.openai.compaction.autoCompactTokenLimit === "number" &&
		typeof context.contextWindow === "number"
	) {
		if (
			!Number.isSafeInteger(context.contextWindow) ||
			context.contextWindow <= 0 ||
			config.openai.compaction.autoCompactTokenLimit >= context.contextWindow
		) {
			issue(
				issues,
				"openai.compaction.autoCompactTokenLimit",
				"invalid_value",
				"must be a positive integer below the model context window",
			);
		}
	}

	if (
		config.openai.compaction.mode === "auto" &&
		config.openai.compaction.autoCompactTokenLimit === "model" &&
		context.modelAutoCompactTokenLimit === null
	) {
		issue(
			issues,
			"openai.compaction.autoCompactTokenLimit",
			"capability_unavailable",
			"Unavailable: model metadata has no auto-compact limit",
		);
	}

	if (
		config.openai.compaction.mode === "auto" &&
		capabilities !== undefined &&
		!capabilities.has("remote_compaction_v2") &&
		!capabilities.has("compact_endpoint")
	) {
		issue(
			issues,
			"openai.compaction.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise an official compaction path",
		);
	}

	if (
		config.openai.transport.mode === "auto" &&
		context.providerSupportsWebsockets === false &&
		capabilities !== undefined &&
		!capabilities.has("responses_sse")
	) {
		issue(
			issues,
			"openai.transport.mode",
			"unsupported_capability",
			"Unavailable: neither WebSocket nor SSE transport is available",
		);
	}

	if (
		config.openai.transport.mode === "sse" &&
		capabilities !== undefined &&
		!capabilities.has("responses_sse")
	) {
		issue(
			issues,
			"openai.transport.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise responses_sse",
		);
	}

	if (
		config.openai.webSearch.mode !== "disabled" &&
		capabilities !== undefined &&
		!capabilities.has("standalone_web_search") &&
		!capabilities.has("hosted_web_search")
	) {
		issue(
			issues,
			"openai.webSearch.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise a web search surface",
		);
	}

	return issues;
}

function evaluateBackgroundSessions(
	config: CodexConfig,
	context: ConfigCapabilityContext,
): ConfigSettingEvaluation {
	if (context.shellSurface === undefined) {
		return { path: "tools.backgroundSessions", availability: { status: "enabled" } };
	}
	if (context.shellSurface === "unified-exec") {
		return {
			path: "tools.backgroundSessions",
			availability: config.tools.backgroundSessions
				? { status: "enabled" }
				: {
						status: "disabled",
						reason: "Disabled: Unified Exec sessions terminate after the initial yield",
					},
		};
	}
	return {
		path: "tools.backgroundSessions",
		availability: {
			status: "unsupported",
			reason: "Unavailable: background sessions apply only to Unified Exec",
		},
	};
}

function evaluateOptionalTool(
	path: string,
	value: AutoOrOff,
	capabilities: ReadonlySet<string> | undefined,
	capability: string,
	unsupportedReason: string,
): ConfigSettingEvaluation {
	if (value === "off") {
		return {
			path,
			availability: { status: "disabled", reason: "Disabled by configuration" },
		};
	}
	if (capabilities !== undefined && !capabilities.has(capability)) {
		return {
			path,
			availability: { status: "unsupported", reason: unsupportedReason },
		};
	}
	return { path, availability: { status: "enabled" } };
}

function evaluateTransport(
	config: CodexConfig,
	context: ConfigCapabilityContext,
	capabilities: ReadonlySet<string> | undefined,
): ConfigSettingEvaluation {
	if (config.openai.transport.mode === "sse") {
		if (capabilities !== undefined && !capabilities.has("responses_sse")) {
			return {
				path: "openai.transport.mode",
				availability: {
					status: "unsupported",
					reason: "Unavailable: bridge does not advertise responses_sse",
				},
			};
		}
		return { path: "openai.transport.mode", availability: { status: "enabled" } };
	}

	if (context.providerSupportsWebsockets === false) {
		if (capabilities !== undefined && !capabilities.has("responses_sse")) {
			return {
				path: "openai.transport.mode",
				availability: {
					status: "unsupported",
					reason: "Unavailable: neither WebSocket nor SSE transport is available",
				},
			};
		}
		return {
			path: "openai.transport.mode",
			availability: {
				status: "disabled",
				reason: "WebSocket unavailable for this provider; SSE will be used",
			},
		};
	}

	if (
		capabilities !== undefined &&
		!capabilities.has("responses_websocket") &&
		!capabilities.has("responses_sse")
	) {
		return {
			path: "openai.transport.mode",
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise Responses transport",
			},
		};
	}

	return { path: "openai.transport.mode", availability: { status: "enabled" } };
}

function evaluateWebSearch(
	config: CodexConfig,
	capabilities: ReadonlySet<string> | undefined,
): ConfigSettingEvaluation {
	if (config.openai.webSearch.mode === "disabled") {
		return {
			path: "openai.webSearch.mode",
			availability: { status: "disabled", reason: "Disabled by configuration" },
		};
	}
	if (
		capabilities !== undefined &&
		!capabilities.has("standalone_web_search") &&
		!capabilities.has("hosted_web_search")
	) {
		return {
			path: "openai.webSearch.mode",
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise a web search surface",
			},
		};
	}
	return { path: "openai.webSearch.mode", availability: { status: "enabled" } };
}

function evaluateCompaction(
	config: CodexConfig,
	context: ConfigCapabilityContext,
	capabilities: ReadonlySet<string> | undefined,
): ConfigSettingEvaluation {
	if (config.openai.compaction.mode === "off") {
		return {
			path: "openai.compaction.mode",
			availability: { status: "disabled", reason: "Disabled by configuration" },
		};
	}
	if (
		capabilities !== undefined &&
		!capabilities.has("remote_compaction_v2") &&
		!capabilities.has("compact_endpoint")
	) {
		return {
			path: "openai.compaction.mode",
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise an official compaction path",
			},
		};
	}
	if (context.remoteCompactionV2 === false && context.compactEndpoint === false) {
		return {
			path: "openai.compaction.mode",
			availability: {
				status: "unsupported",
				reason: "Unavailable: provider has no official compaction path",
			},
		};
	}
	return { path: "openai.compaction.mode", availability: { status: "enabled" } };
}

function evaluateAutoCompactTokenLimit(
	config: CodexConfig,
	context: ConfigCapabilityContext,
): ConfigSettingEvaluation {
	if (config.openai.compaction.mode !== "auto") {
		return {
			path: "openai.compaction.autoCompactTokenLimit",
			availability: { status: "disabled", reason: "Compaction is off" },
		};
	}
	if (config.openai.compaction.autoCompactTokenLimit === "model") {
		if (context.modelAutoCompactTokenLimit === null) {
			return {
				path: "openai.compaction.autoCompactTokenLimit",
				availability: {
					status: "unsupported",
					reason: "Unavailable: model metadata has no auto-compact limit",
				},
			};
		}
		return { path: "openai.compaction.autoCompactTokenLimit", availability: { status: "enabled" } };
	}
	if (
		typeof context.contextWindow === "number" &&
		config.openai.compaction.autoCompactTokenLimit >= context.contextWindow
	) {
		return {
			path: "openai.compaction.autoCompactTokenLimit",
			availability: {
				status: "unsupported",
				reason: "Unavailable: threshold must be below the model context window",
			},
		};
	}
	return { path: "openai.compaction.autoCompactTokenLimit", availability: { status: "enabled" } };
}

function capabilitySet(values: readonly string[] | undefined): ReadonlySet<string> | undefined {
	return values === undefined ? undefined : new Set(values);
}

function parseTools(
	value: unknown,
	issues: ConfigurationIssue[],
): CodexConfig["tools"] | undefined {
	const tools = record(value, "tools", issues);
	if (tools === undefined) return undefined;
	exactKeys(tools, ["backgroundSessions", "optional"], "tools", issues);
	const backgroundSessions = booleanValue(
		tools.backgroundSessions,
		"tools.backgroundSessions",
		issues,
	);
	const optional = record(tools.optional, "tools.optional", issues);
	if (optional === undefined) return undefined;
	exactKeys(optional, ["viewImage", "imageGeneration"], "tools.optional", issues);
	const viewImage = enumValue(
		optional.viewImage,
		["auto", "off"],
		"tools.optional.viewImage",
		issues,
	);
	const imageGeneration = enumValue(
		optional.imageGeneration,
		["auto", "off"],
		"tools.optional.imageGeneration",
		issues,
	);
	return backgroundSessions === undefined ||
		viewImage === undefined ||
		imageGeneration === undefined
		? undefined
		: { backgroundSessions, optional: { viewImage, imageGeneration } };
}

function parseOpenAi(
	value: unknown,
	issues: ConfigurationIssue[],
): CodexConfig["openai"] | undefined {
	const openai = record(value, "openai", issues);
	if (openai === undefined) return undefined;
	exactKeys(
		openai,
		["serviceTier", "verbosity", "transport", "webSearch", "compaction"],
		"openai",
		issues,
	);
	const serviceTier = enumValue(
		openai.serviceTier,
		["default", "priority", "flex"],
		"openai.serviceTier",
		issues,
	);
	const verbosity = enumValue(
		openai.verbosity,
		["low", "medium", "high"],
		"openai.verbosity",
		issues,
	);
	const transportMode = nestedMode(openai.transport, ["auto", "sse"], "openai.transport", issues);
	const webSearchMode = nestedMode(
		openai.webSearch,
		["disabled", "cached", "indexed", "live"],
		"openai.webSearch",
		issues,
	);
	const compaction = parseCompaction(openai.compaction, issues);
	return serviceTier === undefined ||
		verbosity === undefined ||
		transportMode === undefined ||
		webSearchMode === undefined ||
		compaction === undefined
		? undefined
		: {
				serviceTier,
				verbosity,
				transport: { mode: transportMode },
				webSearch: { mode: webSearchMode },
				compaction,
			};
}

function parseCompaction(
	value: unknown,
	issues: ConfigurationIssue[],
): CompactionConfig | undefined {
	const compaction = record(value, "openai.compaction", issues);
	if (compaction === undefined) return undefined;
	const mode = enumValue(compaction.mode, ["off", "auto"], "openai.compaction.mode", issues);
	if (mode === "off") {
		exactKeys(compaction, ["mode"], "openai.compaction", issues);
		return { mode };
	}
	if (mode !== "auto") return undefined;
	exactKeys(compaction, ["mode", "autoCompactTokenLimit"], "openai.compaction", issues);
	const limit = compaction.autoCompactTokenLimit;
	if (limit === "model") return { mode, autoCompactTokenLimit: limit };
	if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0) {
		return { mode, autoCompactTokenLimit: limit };
	}
	issue(
		issues,
		"openai.compaction.autoCompactTokenLimit",
		"invalid_value",
		"must be model or a positive integer",
	);
	return undefined;
}

function parseUi(value: unknown, issues: ConfigurationIssue[]): CodexConfig["ui"] | undefined {
	const ui = record(value, "ui", issues);
	if (ui === undefined) return undefined;
	exactKeys(ui, ["status"], "ui", issues);
	const status = booleanValue(ui.status, "ui.status", issues);
	return status === undefined ? undefined : { status };
}

function nestedMode<const T extends readonly string[]>(
	value: unknown,
	allowed: T,
	path: string,
	issues: ConfigurationIssue[],
): T[number] | undefined {
	const container = record(value, path, issues);
	if (container === undefined) return undefined;
	exactKeys(container, ["mode"], path, issues);
	return enumValue(container.mode, allowed, `${path}.mode`, issues);
}

function record(
	value: unknown,
	path: string,
	issues: ConfigurationIssue[],
): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	issue(issues, path, "invalid_type", "must be an object");
	return undefined;
}

function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	path: string,
	issues: ConfigurationIssue[],
): void {
	const expectedSet = new Set(expected);
	if (Object.keys(value).some((key) => !expectedSet.has(key))) {
		issue(issues, path, "unknown_field", "contains unsupported fields");
	}
	for (const key of expected) {
		if (!Object.hasOwn(value, key)) {
			issue(issues, path === "$" ? key : `${path}.${key}`, "missing_field", "is required");
		}
	}
}

function enumValue<const T extends readonly string[]>(
	value: unknown,
	allowed: T,
	path: string,
	issues: ConfigurationIssue[],
): T[number] | undefined {
	if (typeof value === "string" && allowed.includes(value)) return value;
	issue(issues, path, "invalid_value", "has an unsupported value");
	return undefined;
}

function literal<const T extends string | number>(
	value: unknown,
	expected: T,
	path: string,
	issues: ConfigurationIssue[],
): T | undefined {
	if (value === expected) return expected;
	issue(issues, path, "invalid_value", "has an unsupported value");
	return undefined;
}

function booleanValue(
	value: unknown,
	path: string,
	issues: ConfigurationIssue[],
): boolean | undefined {
	if (typeof value === "boolean") return value;
	issue(issues, path, "invalid_type", "must be a boolean");
	return undefined;
}

function issue(
	issues: ConfigurationIssue[],
	path: string,
	code: ConfigurationIssue["code"],
	message: string,
): void {
	issues.push({ path, code, message });
}

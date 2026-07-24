export type AutoOrOff = "auto" | "off";
export type ServiceTier = "default" | "priority" | "flex";
export type Verbosity = "low" | "medium" | "high";
export type TransportMode = "auto" | "sse";
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type ShellSurface = "unified-exec" | "shell-command" | "disabled";
export type ApprovalPolicy = "prompt" | "bypass";

export type CompactionConfig =
	| { mode: "off" }
	| { mode: "auto"; autoCompactTokenLimit: "model" | number };

export interface CodexConfig {
	schemaVersion: 2;
	activation: { providers: string[] };
	tools: {
		backgroundSessions: boolean;
		optional: {
			viewImage: AutoOrOff;
			imageGeneration: AutoOrOff;
		};
	};
	security: { approvalPolicy: ApprovalPolicy };
	codex: {
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
	/** Verified model auto-compact threshold. Null means metadata has no limit. */
	modelAutoCompactTokenLimit?: number | null;
	/** Bridge capability identifiers from handshake or diagnostics. */
	bridgeCapabilities?: readonly string[];
	/** Official shell surface resolved for the current model. */
	shellSurface?: ShellSurface;
	/** Whether the active provider supports WebSocket transport. */
	providerSupportsWebsockets?: boolean;
	/** Whether the active provider supports RemoteCompactionV2. */
	remoteCompactionV2?: boolean;
	/** Whether the compact endpoint is available. */
	compactEndpoint?: boolean;
	/** Whether the bridge supports native portable context summarization. */
	portableContextSummary?: boolean;
	/** Effective route results resolved from the same snapshot used by requests and Pi tools. */
	backgroundSessionsAvailable?: boolean;
	viewImageAvailable?: boolean;
	imageGenerationAvailable?: boolean;
	webSearchAvailable?: boolean;
	manualCompactionAvailable?: boolean;
	transportAvailable?: boolean;
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
		schemaVersion: 2,
		activation: { providers: ["openai-codex"] },
		tools: {
			backgroundSessions: true,
			optional: { viewImage: "auto", imageGeneration: "auto" },
		},
		security: { approvalPolicy: "prompt" },
		codex: {
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
	if (root === undefined) throw new ConfigurationError(issues);
	exactKeys(root, ["schemaVersion", "activation", "tools", "security", "codex", "ui"], "$", issues);

	const schemaVersion = literal(root.schemaVersion, 2, "schemaVersion", issues);
	const activation = parseActivation(root.activation, issues);
	const tools = parseTools(root.tools, issues);
	const security = parseSecurity(root.security, issues);
	const codex = parseCodex(root.codex, issues);
	const ui = parseUi(root.ui, issues);
	if (
		issues.length > 0 ||
		schemaVersion === undefined ||
		activation === undefined ||
		tools === undefined ||
		security === undefined ||
		codex === undefined ||
		ui === undefined
	) {
		throw new ConfigurationError(issues);
	}
	return { schemaVersion, activation, tools, security, codex, ui };
}

/** Schema-parse a draft and apply capability-aware save gates for the supplied context. */
export function validateConfigForSave(
	value: unknown,
	context: ConfigCapabilityContext = {},
): CodexConfig {
	const config = parseConfig(value);
	const issues = collectCapabilityIssues(config, context);
	if (issues.length > 0) throw new ConfigurationError(issues);
	return config;
}

/** Evaluate capability-dependent settings for UI three-state rendering. Does not throw. */
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
			context.viewImageAvailable,
		),
		evaluateOptionalTool(
			"tools.optional.imageGeneration",
			config.tools.optional.imageGeneration,
			capabilities,
			"image_generation",
			"Unavailable: bridge does not advertise image_generation",
			context.imageGenerationAvailable,
		),
		evaluateTransport(config, context, capabilities),
		evaluateWebSearch(config, capabilities, context.webSearchAvailable),
		evaluateCompaction(config, context, capabilities),
	];

	if (config.codex.compaction.mode === "auto") {
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
	const compaction = config.codex.compaction;

	if (config.tools.backgroundSessions && context.backgroundSessionsAvailable === false) {
		issue(
			issues,
			"tools.backgroundSessions",
			"capability_unavailable",
			"Unavailable: the model and bridge do not provide a complete managed-session route",
		);
	}
	if (config.tools.optional.viewImage === "auto" && context.viewImageAvailable === false) {
		issue(
			issues,
			"tools.optional.viewImage",
			"capability_unavailable",
			"Unavailable: no complete view_image route exists",
		);
	}
	if (
		config.tools.optional.imageGeneration === "auto" &&
		context.imageGenerationAvailable === false
	) {
		issue(
			issues,
			"tools.optional.imageGeneration",
			"capability_unavailable",
			"Unavailable: no complete image generation route exists",
		);
	}
	if (config.codex.webSearch.mode !== "disabled" && context.webSearchAvailable === false) {
		issue(
			issues,
			"codex.webSearch.mode",
			"capability_unavailable",
			"Unavailable: no complete web search route exists",
		);
	}
	if (compaction.mode === "auto" && context.manualCompactionAvailable === false) {
		issue(
			issues,
			"codex.compaction.mode",
			"capability_unavailable",
			"Unavailable: no complete compaction route exists",
		);
	}
	if (context.transportAvailable === false) {
		issue(
			issues,
			"codex.transport.mode",
			"capability_unavailable",
			"Unavailable: no complete Responses transport route exists",
		);
	}

	if (
		compaction.mode === "auto" &&
		typeof compaction.autoCompactTokenLimit === "number" &&
		typeof context.contextWindow === "number" &&
		(!Number.isSafeInteger(context.contextWindow) ||
			context.contextWindow <= 0 ||
			compaction.autoCompactTokenLimit >= context.contextWindow)
	) {
		issue(
			issues,
			"codex.compaction.autoCompactTokenLimit",
			"invalid_value",
			"must be a positive integer below the model context window",
		);
	}

	if (
		compaction.mode === "auto" &&
		compaction.autoCompactTokenLimit === "model" &&
		context.modelAutoCompactTokenLimit === null
	) {
		issue(
			issues,
			"codex.compaction.autoCompactTokenLimit",
			"capability_unavailable",
			"Unavailable: model metadata has no auto-compact limit",
		);
	}

	if (
		compaction.mode === "auto" &&
		context.manualCompactionAvailable === undefined &&
		capabilities !== undefined &&
		!capabilities.has("portable_context_summary")
	) {
		issue(
			issues,
			"codex.compaction.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise portable context summary",
		);
	}

	if (
		compaction.mode === "auto" &&
		context.manualCompactionAvailable === undefined &&
		capabilities !== undefined &&
		!capabilities.has("remote_compaction_v2") &&
		!capabilities.has("compact_endpoint")
	) {
		issue(
			issues,
			"codex.compaction.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise an official compaction path",
		);
	}

	if (
		compaction.mode === "auto" &&
		context.manualCompactionAvailable === undefined &&
		context.remoteCompactionV2 === false &&
		context.compactEndpoint === false &&
		context.portableContextSummary !== false &&
		(capabilities === undefined ||
			capabilities.has("remote_compaction_v2") ||
			capabilities.has("compact_endpoint"))
	) {
		issue(
			issues,
			"codex.compaction.mode",
			"unsupported_capability",
			"Unavailable: provider has no official compaction path",
		);
	}

	if (
		compaction.mode === "auto" &&
		context.manualCompactionAvailable === undefined &&
		context.portableContextSummary === false
	) {
		issue(
			issues,
			"codex.compaction.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise portable context summary",
		);
	}

	if (
		config.codex.transport.mode === "auto" &&
		context.transportAvailable === undefined &&
		context.providerSupportsWebsockets === false &&
		capabilities !== undefined &&
		!capabilities.has("responses_sse")
	) {
		issue(
			issues,
			"codex.transport.mode",
			"unsupported_capability",
			"Unavailable: neither WebSocket nor SSE transport is available",
		);
	}

	if (
		config.codex.transport.mode === "auto" &&
		context.transportAvailable === undefined &&
		context.providerSupportsWebsockets !== false &&
		capabilities !== undefined &&
		!capabilities.has("responses_websocket") &&
		!capabilities.has("responses_sse")
	) {
		issue(
			issues,
			"codex.transport.mode",
			"unsupported_capability",
			"Unavailable: neither WebSocket nor SSE transport is available",
		);
	}

	if (
		config.codex.transport.mode === "sse" &&
		context.transportAvailable === undefined &&
		capabilities !== undefined &&
		!capabilities.has("responses_sse")
	) {
		issue(
			issues,
			"codex.transport.mode",
			"unsupported_capability",
			"Unavailable: bridge does not advertise responses_sse",
		);
	}

	if (
		config.codex.webSearch.mode !== "disabled" &&
		context.webSearchAvailable === undefined &&
		capabilities !== undefined &&
		!capabilities.has("standalone_web_search") &&
		!capabilities.has("hosted_web_search")
	) {
		issue(
			issues,
			"codex.webSearch.mode",
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
	if (context.backgroundSessionsAvailable === false) {
		return {
			path: "tools.backgroundSessions",
			availability: {
				status: "unsupported",
				reason: "Unavailable: no complete managed-session route exists",
			},
		};
	}
	if (
		context.backgroundSessionsAvailable === true ||
		context.shellSurface === undefined ||
		context.shellSurface === "unified-exec"
	) {
		return {
			path: "tools.backgroundSessions",
			availability: config.tools.backgroundSessions
				? { status: "enabled" }
				: {
						status: "disabled",
						reason: "Disabled: managed sessions terminate or remain unavailable",
					},
		};
	}
	return {
		path: "tools.backgroundSessions",
		availability: {
			status: "unsupported",
			reason: "Unavailable: the current model has no managed-session route",
		},
	};
}

function evaluateOptionalTool(
	path: string,
	value: AutoOrOff,
	capabilities: ReadonlySet<string> | undefined,
	capability: string,
	unsupportedReason: string,
	effectiveAvailable?: boolean,
): ConfigSettingEvaluation {
	if (value === "off") {
		return { path, availability: { status: "disabled", reason: "Disabled by configuration" } };
	}
	if (effectiveAvailable === false) {
		return {
			path,
			availability: { status: "unsupported", reason: "Unavailable: no complete route exists" },
		};
	}
	if (capabilities !== undefined && !capabilities.has(capability)) {
		return { path, availability: { status: "unsupported", reason: unsupportedReason } };
	}
	return { path, availability: { status: "enabled" } };
}

function evaluateTransport(
	config: CodexConfig,
	context: ConfigCapabilityContext,
	capabilities: ReadonlySet<string> | undefined,
): ConfigSettingEvaluation {
	const path = "codex.transport.mode";
	if (context.transportAvailable === false) {
		return {
			path,
			availability: { status: "unsupported", reason: "Unavailable: no complete transport exists" },
		};
	}
	if (config.codex.transport.mode === "sse") {
		return capabilities !== undefined && !capabilities.has("responses_sse")
			? {
					path,
					availability: {
						status: "unsupported",
						reason: "Unavailable: bridge does not advertise responses_sse",
					},
				}
			: { path, availability: { status: "enabled" } };
	}
	if (context.providerSupportsWebsockets === false) {
		if (capabilities !== undefined && !capabilities.has("responses_sse")) {
			return {
				path,
				availability: {
					status: "unsupported",
					reason: "Unavailable: neither WebSocket nor SSE transport is available",
				},
			};
		}
		return {
			path,
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
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise Responses transport",
			},
		};
	}
	return { path, availability: { status: "enabled" } };
}

function evaluateWebSearch(
	config: CodexConfig,
	capabilities: ReadonlySet<string> | undefined,
	effectiveAvailable?: boolean,
): ConfigSettingEvaluation {
	const path = "codex.webSearch.mode";
	if (config.codex.webSearch.mode === "disabled") {
		return { path, availability: { status: "disabled", reason: "Disabled by configuration" } };
	}
	if (effectiveAvailable === false) {
		return {
			path,
			availability: { status: "unsupported", reason: "Unavailable: no complete route exists" },
		};
	}
	if (
		capabilities !== undefined &&
		!capabilities.has("standalone_web_search") &&
		!capabilities.has("hosted_web_search")
	) {
		return {
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise a web search surface",
			},
		};
	}
	return { path, availability: { status: "enabled" } };
}

function evaluateCompaction(
	config: CodexConfig,
	context: ConfigCapabilityContext,
	capabilities: ReadonlySet<string> | undefined,
): ConfigSettingEvaluation {
	const path = "codex.compaction.mode";
	if (config.codex.compaction.mode === "off") {
		return { path, availability: { status: "disabled", reason: "Disabled by configuration" } };
	}
	if (context.manualCompactionAvailable === false) {
		return {
			path,
			availability: { status: "unsupported", reason: "Unavailable: no complete route exists" },
		};
	}
	if (capabilities !== undefined && !capabilities.has("portable_context_summary")) {
		return {
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise portable context summary",
			},
		};
	}
	if (
		capabilities !== undefined &&
		!capabilities.has("remote_compaction_v2") &&
		!capabilities.has("compact_endpoint")
	) {
		return {
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise an official compaction path",
			},
		};
	}
	if (context.remoteCompactionV2 === false && context.compactEndpoint === false) {
		return {
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: provider has no official compaction path",
			},
		};
	}
	if (context.portableContextSummary === false) {
		return {
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: bridge does not advertise portable context summary",
			},
		};
	}
	return { path, availability: { status: "enabled" } };
}

function evaluateAutoCompactTokenLimit(
	config: CodexConfig,
	context: ConfigCapabilityContext,
): ConfigSettingEvaluation {
	const path = "codex.compaction.autoCompactTokenLimit";
	if (config.codex.compaction.mode !== "auto") {
		return { path, availability: { status: "disabled", reason: "Compaction is off" } };
	}
	if (config.codex.compaction.autoCompactTokenLimit === "model") {
		return context.modelAutoCompactTokenLimit === null
			? {
					path,
					availability: {
						status: "unsupported",
						reason: "Unavailable: model metadata has no auto-compact limit",
					},
				}
			: { path, availability: { status: "enabled" } };
	}
	if (
		typeof context.contextWindow === "number" &&
		config.codex.compaction.autoCompactTokenLimit >= context.contextWindow
	) {
		return {
			path,
			availability: {
				status: "unsupported",
				reason: "Unavailable: threshold must be below the model context window",
			},
		};
	}
	return { path, availability: { status: "enabled" } };
}

function capabilitySet(values: readonly string[] | undefined): ReadonlySet<string> | undefined {
	return values === undefined ? undefined : new Set(values);
}

function parseActivation(
	value: unknown,
	issues: ConfigurationIssue[],
): CodexConfig["activation"] | undefined {
	const activation = record(value, "activation", issues);
	if (activation === undefined) return undefined;
	exactKeys(activation, ["providers"], "activation", issues);
	if (!Array.isArray(activation.providers)) {
		issue(issues, "activation.providers", "invalid_type", "must be an array");
		return undefined;
	}
	const providers = activation.providers;
	if (
		providers.length === 0 ||
		providers.some(
			(provider) =>
				typeof provider !== "string" ||
				provider.trim().length === 0 ||
				provider.length > 256 ||
				/[\r\n]/.test(provider) ||
				provider !== provider.trim(),
		)
	) {
		issue(issues, "activation.providers", "invalid_value", "must contain non-empty provider ids");
		return undefined;
	}
	if (new Set(providers).size !== providers.length) {
		issue(issues, "activation.providers", "invalid_value", "must contain unique provider ids");
		return undefined;
	}
	return { providers: [...providers] as string[] };
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

function parseSecurity(
	value: unknown,
	issues: ConfigurationIssue[],
): CodexConfig["security"] | undefined {
	const security = record(value, "security", issues);
	if (security === undefined) return undefined;
	exactKeys(security, ["approvalPolicy"], "security", issues);
	const approvalPolicy = enumValue(
		security.approvalPolicy,
		["prompt", "bypass"],
		"security.approvalPolicy",
		issues,
	);
	return approvalPolicy === undefined ? undefined : { approvalPolicy };
}

function parseCodex(
	value: unknown,
	issues: ConfigurationIssue[],
): CodexConfig["codex"] | undefined {
	const codex = record(value, "codex", issues);
	if (codex === undefined) return undefined;
	exactKeys(
		codex,
		["serviceTier", "verbosity", "transport", "webSearch", "compaction"],
		"codex",
		issues,
	);
	const serviceTier = enumValue(
		codex.serviceTier,
		["default", "priority", "flex"],
		"codex.serviceTier",
		issues,
	);
	const verbosity = enumValue(
		codex.verbosity,
		["low", "medium", "high"],
		"codex.verbosity",
		issues,
	);
	const transportMode = nestedMode(codex.transport, ["auto", "sse"], "codex.transport", issues);
	const webSearchMode = nestedMode(
		codex.webSearch,
		["disabled", "cached", "indexed", "live"],
		"codex.webSearch",
		issues,
	);
	const compaction = parseCompaction(codex.compaction, issues);
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
	const compaction = record(value, "codex.compaction", issues);
	if (compaction === undefined) return undefined;
	const mode = enumValue(compaction.mode, ["off", "auto"], "codex.compaction.mode", issues);
	if (mode === "off") {
		exactKeys(compaction, ["mode"], "codex.compaction", issues);
		return { mode };
	}
	if (mode !== "auto") return undefined;
	exactKeys(compaction, ["mode", "autoCompactTokenLimit"], "codex.compaction", issues);
	const limit = compaction.autoCompactTokenLimit;
	if (limit === "model") return { mode, autoCompactTokenLimit: limit };
	if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0)
		return { mode, autoCompactTokenLimit: limit };
	issue(
		issues,
		"codex.compaction.autoCompactTokenLimit",
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
	if (typeof value === "object" && value !== null && !Array.isArray(value))
		return value as Record<string, unknown>;
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
	if (Object.keys(value).some((key) => !expectedSet.has(key)))
		issue(issues, path, "unknown_field", "contains unsupported fields");
	for (const key of expected) {
		if (!Object.hasOwn(value, key))
			issue(issues, path === "$" ? key : `${path}.${key}`, "missing_field", "is required");
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

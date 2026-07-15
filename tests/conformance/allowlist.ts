export interface ResponsesAllowlist {
	schemaVersion: number;
	officialCodexVersion: string;
	officialSourceCommit: string;
	requestBody: string[];
	/** Product-contract request fields that must match across official and product wire captures. */
	requestBodyComparable: string[];
	requestHeaders: string[];
	eventTypes: string[];
	terminalStatuses: string[];
	toolContractFields: string[];
	toolSurfaceFields: string[];
	coreTools: string[];
	/** Agent-only request fields that must be present on the official capture without content equality. */
	requestPresence: string[];
}

export function pickFields(
	value: Record<string, unknown>,
	fields: readonly string[],
): Record<string, unknown> {
	const selected: Record<string, unknown> = {};
	for (const field of fields) {
		if (Object.hasOwn(value, field)) {
			selected[field] = value[field];
		}
	}
	return selected;
}

export function normalizeRequestBody(
	body: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
): Record<string, unknown> {
	return pickFields(body, allowlist.requestBody);
}

export function normalizeComparableRequestBody(
	body: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
): Record<string, unknown> {
	return pickFields(body, allowlist.requestBodyComparable);
}

export function normalizeRequestHeaders(
	headers: Headers | Record<string, string | null | undefined>,
	allowlist: ResponsesAllowlist,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	const lookup =
		headers instanceof Headers
			? (name: string) => headers.get(name)
			: (name: string) => {
					const direct = headers[name] ?? headers[name.toLowerCase()];
					return direct ?? null;
				};

	for (const name of allowlist.requestHeaders) {
		const value = lookup(name);
		if (value === null || value === undefined || value === "") {
			continue;
		}
		if (name.toLowerCase() === "authorization") {
			normalized[name.toLowerCase()] = value.toLowerCase().startsWith("bearer ")
				? "bearer redacted"
				: "redacted";
			continue;
		}
		normalized[name.toLowerCase()] = value.toLowerCase();
	}
	return normalized;
}

export function normalizeEventTypes(
	events: readonly unknown[],
	allowlist: ResponsesAllowlist,
): string[] {
	const allowed = new Set(allowlist.eventTypes);
	const types: string[] = [];
	for (const event of events) {
		if (typeof event !== "object" || event === null || Array.isArray(event)) {
			continue;
		}
		const type = (event as { type?: unknown }).type;
		if (typeof type === "string" && allowed.has(type)) {
			types.push(type);
		}
	}
	return types;
}

export interface NormalizedTerminalState {
	status: string;
	responseId?: string;
	text?: string;
}

export function normalizeTerminalState(
	value: {
		status: string;
		responseId?: string | null;
		text?: string | null;
	},
	allowlist: ResponsesAllowlist,
): NormalizedTerminalState {
	if (!allowlist.terminalStatuses.includes(value.status)) {
		throw new Error(`Terminal status ${value.status} is outside the product-contract allowlist`);
	}
	const normalized: NormalizedTerminalState = { status: value.status };
	if (typeof value.responseId === "string" && value.responseId.length > 0) {
		normalized.responseId = value.responseId;
	}
	if (typeof value.text === "string") {
		normalized.text = value.text;
	}
	return normalized;
}

export function assertRequestPresence(
	body: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
	label: string,
): void {
	for (const field of allowlist.requestPresence) {
		if (!Object.hasOwn(body, field)) {
			throw new Error(`${label} is missing required request presence field ${field}`);
		}
	}
}

export interface ResponsesWireObservation {
	requestBody: Record<string, unknown>;
	comparableRequestBody: Record<string, unknown>;
	requestHeaders: Record<string, string>;
	eventTypes: string[];
	terminal: NormalizedTerminalState;
}

export function observeResponsesWire(options: {
	allowlist: ResponsesAllowlist;
	requestBody: Record<string, unknown>;
	requestHeaders: Headers | Record<string, string | null | undefined>;
	events: readonly unknown[];
	terminal: {
		status: string;
		responseId?: string | null;
		text?: string | null;
	};
}): ResponsesWireObservation {
	const observation: ResponsesWireObservation = {
		requestBody: normalizeRequestBody(options.requestBody, options.allowlist),
		comparableRequestBody: normalizeComparableRequestBody(options.requestBody, options.allowlist),
		requestHeaders: normalizeRequestHeaders(options.requestHeaders, options.allowlist),
		eventTypes: normalizeEventTypes(options.events, options.allowlist),
		terminal: normalizeTerminalState(options.terminal, options.allowlist),
	};
	assertCredentialFree(JSON.stringify(observation), "responses wire observation");
	return observation;
}

export function normalizeToolContract(
	contract: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
): Record<string, unknown> {
	const normalized = pickFields(contract, allowlist.toolContractFields);
	if (
		(contract.name === "exec_command" || contract.name === "shell_command") &&
		Object.hasOwn(normalized, "description")
	) {
		if (typeof normalized.description !== "string" || normalized.description.length === 0) {
			throw new Error(`Official ${String(contract.name)} description must be non-empty`);
		}
		normalized.description = "<official platform-specific shell description>";
	}
	return normalized;
}

export function normalizeToolSurface(
	result: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
): Record<string, unknown> {
	const modelTools = Array.isArray(result.modelTools) ? result.modelTools : [];
	const dispatchTools = Array.isArray(result.dispatchTools) ? result.dispatchTools : [];
	const modelToolNames = modelTools
		.map((tool) => toolName(tool))
		.filter((name): name is string => name !== undefined)
		.sort();
	const dispatchToolNames = dispatchTools
		.map((tool) => toolName(tool))
		.filter((name): name is string => name !== undefined)
		.sort();

	const surface = {
		shellSurface: result.shellSurface,
		webSurface: result.webSurface,
		webReason: result.webReason,
		imageGenerationSurface: result.imageGenerationSurface,
		modelToolNames,
		dispatchToolNames,
	};
	return pickFields(surface, allowlist.toolSurfaceFields);
}

export function normalizeCoreToolContracts(
	contracts: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const name of allowlist.coreTools) {
		const contract = contracts[name];
		if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
			continue;
		}
		normalized[name] = normalizeToolContract(contract as Record<string, unknown>, allowlist);
	}
	return normalized;
}

export function parseSseEvents(body: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const block of body.split("\n\n")) {
		const dataLines = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart());
		if (dataLines.length === 0) {
			const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
			if (eventLine !== undefined) {
				events.push({ type: eventLine.slice(6).trim() });
			}
			continue;
		}
		const payload = dataLines.join("\n");
		const parsed = JSON.parse(payload) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			events.push(parsed as Record<string, unknown>);
		}
	}
	return events;
}

export function assertCredentialFree(text: string, label: string): void {
	const forbidden = [
		/sk-[A-Za-z0-9_-]{10,}/,
		/Bearer\s+(?!redacted\b)[A-Za-z0-9._~+/=-]{8,}/i,
		/chatgpt_account_id/i,
		/\/home\/[A-Za-z0-9._-]+/,
		/\\\\Users\\\\[A-Za-z0-9._-]+/,
		/CODEX_API_KEY/i,
		/OPENAI_API_KEY/i,
	];
	for (const pattern of forbidden) {
		if (pattern.test(text)) {
			throw new Error(`${label} contains forbidden credential or path material`);
		}
	}
}

function toolName(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name === "string") {
		return record.name;
	}
	if (record.type === "web_search") {
		return "web_search";
	}
	return undefined;
}

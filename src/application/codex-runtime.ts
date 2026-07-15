/**
 * In-memory OpenAI credentials derived from the Pi provider secret.
 *
 * OAuth bearer values are only produced for JWTs that carry the official
 * ChatGPT account claim. Any other non-empty credential is treated as an API
 * key. Credential values must never appear in errors, logs, or diagnostics.
 */
export type CodexAuthentication =
	| {
			kind: "oauth_bearer";
			token: string;
			accountId: string;
	  }
	| {
			kind: "openai_api_key";
			apiKey: string;
	  };

/** Official JWT claim used by OpenAI ChatGPT account tokens. */
export const OFFICIAL_ACCOUNT_CLAIM = "https://api.openai.com/auth";

/**
 * Derive the bridge authentication variant from a Pi provider credential.
 *
 * Empty credentials fail closed. Valid JWTs with the official account claim
 * become OAuth bearer auth; every other non-empty value becomes an API key.
 */
export function resolveCodexAuthentication(credential: string): CodexAuthentication {
	if (credential.length === 0) {
		throw new Error("OpenAI Codex authentication is required");
	}
	const accountId = extractAccountId(credential);
	if (accountId !== undefined) {
		return {
			kind: "oauth_bearer",
			token: credential,
			accountId,
		};
	}
	return {
		kind: "openai_api_key",
		apiKey: credential,
	};
}

/**
 * Read the official ChatGPT account id from a JWT credential.
 *
 * Returns undefined for non-JWT values, malformed payloads, or JWTs that omit
 * the pinned account claim. Never throws and never echoes the credential.
 */
export function extractAccountId(credential: string): string | undefined {
	const parts = credential.split(".");
	if (parts.length !== 3) {
		return undefined;
	}
	const payloadSegment = parts[1];
	if (payloadSegment === undefined || payloadSegment.length === 0) {
		return undefined;
	}
	const payloadText = decodeBase64Url(payloadSegment);
	if (payloadText === undefined) {
		return undefined;
	}
	try {
		const decoded = JSON.parse(payloadText) as unknown;
		const root = record(decoded);
		const auth = root === undefined ? undefined : record(root[OFFICIAL_ACCOUNT_CLAIM]);
		const accountId = auth?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

/** Compare two authentication values without logging either credential. */
export function sameCodexAuthentication(
	current: CodexAuthentication | undefined,
	next: CodexAuthentication,
): boolean {
	if (current === undefined || current.kind !== next.kind) {
		return false;
	}
	if (current.kind === "oauth_bearer" && next.kind === "oauth_bearer") {
		return current.token === next.token && current.accountId === next.accountId;
	}
	if (current.kind === "openai_api_key" && next.kind === "openai_api_key") {
		return current.apiKey === next.apiKey;
	}
	return false;
}

function decodeBase64Url(value: string): string | undefined {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const padLength = (4 - (normalized.length % 4)) % 4;
		const padded = normalized + "=".repeat(padLength);
		return atob(padded);
	} catch {
		return undefined;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export interface CreateResponseOptions {
	authentication: CodexAuthentication;
	request: unknown;
	transportMode: "auto" | "sse";
	providerSupportsWebsockets: boolean;
	signal?: AbortSignal;
	onEvent(event: unknown): void | Promise<void>;
}

export interface CreateResponseResult {
	status: "completed" | "incomplete" | "failed" | "aborted" | "timed_out";
	result: unknown;
}

export interface CompactResponseOptions {
	authentication: CodexAuthentication;
	request: unknown;
	implementation: "remote_v2" | "compact_endpoint";
	transportMode: "auto" | "sse";
	providerSupportsWebsockets: boolean;
	signal?: AbortSignal;
}

export interface CodexApprovalRequest {
	approvalId: string;
	operation: "command" | "patch" | "filesystem" | "network";
	summary: string;
	details: unknown;
	availableDecisions: readonly ("allow_once" | "allow_session" | "decline" | "cancel")[];
}

export type CodexApprovalDecision = CodexApprovalRequest["availableDecisions"][number];

export interface ExecuteToolOptions {
	authentication: CodexAuthentication;
	tool: string;
	argumentsValue: Record<string, unknown>;
	workdir: string;
	workspaceRoots: readonly string[];
	signal?: AbortSignal;
	onEvent?(event: unknown): void | Promise<void>;
	onApproval?(
		request: CodexApprovalRequest,
	): CodexApprovalDecision | Promise<CodexApprovalDecision>;
}

export interface CodexRuntime {
	createResponse(options: CreateResponseOptions): Promise<CreateResponseResult>;
	compact(options: CompactResponseOptions): Promise<CreateResponseResult>;
	readDiagnostics?(): Promise<unknown>;
	resolveModel(authentication: CodexAuthentication, modelId: string): Promise<unknown>;
	resolveTools(authentication: CodexAuthentication, params: unknown): Promise<unknown>;
	executeTool(options: ExecuteToolOptions): Promise<CreateResponseResult>;
	shutdown(): Promise<void>;
}

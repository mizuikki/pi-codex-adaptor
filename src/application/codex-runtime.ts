/** Official JWT claim used by OpenAI ChatGPT account tokens. */
export const OFFICIAL_ACCOUNT_CLAIM = "https://api.openai.com/auth";

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
	connection: CodexProviderConnection;
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
	connection: CodexProviderConnection;
	request: unknown;
	implementation: "remote_v2" | "compact_endpoint";
	transportMode: "auto" | "sse";
	providerSupportsWebsockets: boolean;
	signal?: AbortSignal;
}

/** Authorization selected by Pi for one native request. */
export type NativeAuthorization = "require_approval" | "preauthorized";

export interface CodexApprovalRequest {
	approvalId: string;
	operation: "command" | "patch" | "filesystem" | "network";
	summary: string;
	details: unknown;
	availableDecisions: readonly ("allow_once" | "allow_session" | "decline" | "cancel")[];
}

export type CodexApprovalDecision = CodexApprovalRequest["availableDecisions"][number];

export interface ExecuteToolOptions {
	connection?: CodexProviderConnection;
	tool: string;
	argumentsValue: Record<string, unknown>;
	workdir: string;
	workspaceRoots: readonly string[];
	authorization: NativeAuthorization;
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
	resolveModel(modelId: string): Promise<unknown>;
	resolveTools(params: unknown): Promise<unknown>;
	executeTool(options: ExecuteToolOptions): Promise<CreateResponseResult>;
	shutdown(): Promise<void>;
}

export type CodexProviderAuthentication = { kind: "bearer"; token: string } | { kind: "none" };

/** Immutable request-scoped provider details passed to native network operations. */
export interface CodexProviderConnection {
	readonly providerId: string;
	readonly baseUrl: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly authentication: CodexProviderAuthentication;
	readonly accountId?: string;
	readonly maxRetries?: number;
	readonly timeoutMs?: number;
	readonly websocketConnectTimeoutMs?: number;
}

import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	type CodexProviderAuthentication,
	type CodexProviderConnection,
	extractAccountId,
} from "../../application/codex-runtime.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";

const ACCOUNT_ID_HEADER = "chatgpt-account-id";
const AUTHORIZATION_HEADER = "authorization";
const MAX_HEADER_COUNT = 128;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 1024 * 1024;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Pi maps disabled HTTP idle timeout (`0`) to this signed 32-bit max int sentinel. */
const PI_DISABLED_IDLE_TIMEOUT_MS = 2_147_483_647;

export function createProviderConnection(
	model: Pick<Model<string>, "provider" | "baseUrl">,
	options: Pick<
		SimpleStreamOptions,
		"apiKey" | "headers" | "maxRetries" | "timeoutMs" | "websocketConnectTimeoutMs"
	> = {},
): CodexProviderConnection {
	const providerId = validateProviderId(model.provider);
	const baseUrl = normalizeBaseUrl(model.baseUrl);
	const normalized = normalizeHeaders(options.headers);
	const source = normalized.values;
	const authorization = takeHeader(source, AUTHORIZATION_HEADER);
	const explicitAccountId = takeHeader(source, ACCOUNT_ID_HEADER);
	const authentication = resolveAuthentication(
		authorization,
		normalized.suppressed.has(AUTHORIZATION_HEADER),
		options.apiKey,
	);
	const accountId =
		explicitAccountId !== undefined
			? explicitAccountId.value.length > 0
				? explicitAccountId.value
				: undefined
			: normalized.suppressed.has(ACCOUNT_ID_HEADER)
				? undefined
				: authentication.kind === "bearer"
					? extractAccountId(authentication.token)
					: undefined;
	if (accountId !== undefined && accountId.length > MAX_ACCOUNT_ID_LENGTH) {
		throw new Error("Provider account id is invalid");
	}
	if (
		providerId === "openai-codex" &&
		authentication.kind === "none" &&
		authorization === undefined
	) {
		throw new Error("Provider credentials are unavailable");
	}
	if (
		authorization !== undefined &&
		!authorization.value.trim().toLowerCase().startsWith("bearer ")
	) {
		source.set(authorization.name, authorization.value);
	}

	return Object.freeze({
		providerId,
		baseUrl,
		headers: Object.freeze(Object.fromEntries(source)),
		authentication: freezeAuthentication(authentication),
		...(accountId === undefined ? {} : { accountId }),
		...(explicitAccountId === undefined ? {} : { accountIdSource: "header" as const }),
		...optionalNumber("maxRetries", options.maxRetries, 0, MAX_RETRIES),
		...optionalTimeoutMs("timeoutMs", options.timeoutMs),
		...optionalNumber(
			"websocketConnectTimeoutMs",
			options.websocketConnectTimeoutMs,
			1,
			MAX_TIMEOUT_MS,
		),
	});
}

export function assertProviderActive(
	ctx: ExtensionContext,
	activation: ProviderActivationPolicy,
	inactiveMessage: string,
): void {
	if (!activation.isActive(ctx.model)) {
		throw new Error(inactiveMessage);
	}
}

export async function resolveProviderConnection(
	ctx: ExtensionContext,
	activation: ProviderActivationPolicy,
	inactiveMessage: string,
): Promise<CodexProviderConnection> {
	assertProviderActive(ctx, activation, inactiveMessage);

	const model = ctx.model;
	if (model === undefined) {
		throw new Error("Provider connection requires an active model");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error("Provider authentication is unavailable");
	}

	return createProviderConnection(model, {
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(auth.headers === undefined ? {} : { headers: auth.headers }),
	});
}

function validateProviderId(value: string): string {
	if (value.length === 0 || value.length > 256 || value !== value.trim() || /[\r\n]/.test(value)) {
		throw new Error("Provider id is invalid");
	}
	return value;
}

function normalizeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Provider base URL is invalid");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.hostname.length === 0 ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.hash.length > 0 ||
		url.search.length > 0
	) {
		throw new Error("Provider base URL is invalid");
	}
	const path = url.pathname.replace(/\/+$/, "");
	if (path === "/responses" || path.endsWith("/responses")) {
		throw new Error("Provider base URL must be an API root");
	}
	if (
		url.protocol === "https:" &&
		(url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
		path === "/backend-api"
	) {
		url.pathname = "/backend-api/codex";
	}
	return url.toString().replace(/\/$/, "");
}

function normalizeHeaders(input: Record<string, string | null> | undefined): {
	values: Map<string, string>;
	suppressed: Set<string>;
} {
	if (input === undefined) return { values: new Map(), suppressed: new Set() };
	if (Object.keys(input).length > MAX_HEADER_COUNT) throw new Error("Provider headers are invalid");
	const values = new Map<string, string>();
	const suppressed = new Set<string>();
	for (const [name, rawValue] of Object.entries(input)) {
		validateHeaderName(name);
		const normalizedName = name.toLowerCase();
		if (rawValue === null) {
			removeHeader(values, name);
			suppressed.add(normalizedName);
			continue;
		}
		if (rawValue.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(rawValue)) {
			throw new Error("Provider headers are invalid");
		}
		removeHeader(values, name);
		suppressed.delete(normalizedName);
		values.set(name, rawValue);
	}
	return { values, suppressed };
}

function resolveAuthentication(
	authorization: HeaderValue | undefined,
	authorizationSuppressed: boolean,
	apiKey: string | undefined,
): CodexProviderAuthentication {
	if (authorization !== undefined) {
		if (authorization.value.trim().toLowerCase().startsWith("bearer ")) {
			const token = authorization.value.trim().slice("bearer ".length).trim();
			if (token.length === 0) throw new Error("Authorization header is invalid");
			return { kind: "bearer", token };
		}
		return { kind: "none" };
	}
	if (authorizationSuppressed) return { kind: "none" };
	if (apiKey === undefined || apiKey.length === 0) return { kind: "none" };
	if (/[\r\n]/.test(apiKey) || apiKey.length > MAX_HEADER_VALUE_LENGTH) {
		throw new Error("Provider credential is invalid");
	}
	return { kind: "bearer", token: apiKey };
}

interface HeaderValue {
	name: string;
	value: string;
}

function takeHeader(headers: Map<string, string>, name: string): HeaderValue | undefined {
	for (const [key, value] of headers) {
		if (key.toLowerCase() !== name) continue;
		headers.delete(key);
		return { name: key, value };
	}
	return undefined;
}

function removeHeader(headers: Map<string, string>, name: string): void {
	for (const key of headers.keys()) {
		if (key.toLowerCase() === name.toLowerCase()) headers.delete(key);
	}
}

function validateHeaderName(name: string): void {
	if (
		name.length === 0 ||
		name.length > MAX_HEADER_NAME_LENGTH ||
		!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
	) {
		throw new Error("Provider headers are invalid");
	}
}

function optionalNumber(
	key: "maxRetries" | "timeoutMs" | "websocketConnectTimeoutMs",
	value: number | undefined,
	minimum: number,
	maximum: number,
): Record<string, number> {
	if (value === undefined) return {};
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error("Provider request settings are invalid");
	}
	return { [key]: value };
}

/**
 * Maps Pi stream idle timeout settings onto the bridge wire.
 *
 * Finite values stay in `[1, MAX_TIMEOUT_MS]`. Pi's disabled HTTP idle timeout is represented as
 * `2147483647` (signed 32-bit max int) and is forwarded as that exact sentinel so native code can
 * apply an unbounded stream idle timeout. Values between the 24h bound and the sentinel, and any
 * larger value, remain invalid.
 */
function optionalTimeoutMs(key: "timeoutMs", value: number | undefined): Record<string, number> {
	if (value === undefined) return {};
	if (value === PI_DISABLED_IDLE_TIMEOUT_MS) {
		return { [key]: PI_DISABLED_IDLE_TIMEOUT_MS };
	}
	return optionalNumber(key, value, 1, MAX_TIMEOUT_MS);
}

function freezeAuthentication(
	authentication: CodexProviderAuthentication,
): CodexProviderAuthentication {
	return Object.freeze(authentication);
}

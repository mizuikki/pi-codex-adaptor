/**
 * Pure redaction policy for logs, diagnostics, and error surfaces.
 *
 * Values are replaced with fixed placeholders. Callers must never log the
 * original input after redaction fails or throws.
 */

export const REDACTED = "[REDACTED]";
export const REDACTED_PATH = "[PATH]";
export const REDACTED_COMPACTION = "[COMPACTION]";

const SENSITIVE_KEY =
	/^(?:authorization|proxy-?authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|password|secret|credential|credentials|prompt|message|messages|content|input|input[_-]?preview|chars|user[_-]?content|compaction|compaction[_-]?output|compacted(?:[_-]?items)?)$/i;

const AUTHORIZATION_HEADER = /\b(authorization|proxy-authorization)\s*[:=]\s*([^\r\n,;]+)/gi;
const BEARER_TOKEN = /\b(bearer)\s+([A-Za-z0-9._\-+/=]+)/gi;
const API_KEY_LITERAL =
	/\b(sk-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|sk-svcacct-[A-Za-z0-9_-]{8,})\b/g;
const JWT_LITERAL = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const ABSOLUTE_UNIX_PATH = /(?<![A-Za-z0-9_])(?:\/(?:home|Users|private|var\/folders)\/[^\s"'`]+)/g;
const ABSOLUTE_WINDOWS_PATH =
	/(?<![A-Za-z0-9_])(?:[A-Za-z]:\\(?:Users|home)(?:\\[^\s"'`]+)?|\\\\[^\\\s"'`]+\\[^\s"'`]+)/g;

export function redactValue(value: unknown): unknown {
	return redactUnknown(value, new WeakSet<object>());
}

export function redactString(value: string): string {
	return redactText(value);
}

export function containsSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key);
}

function redactUnknown(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "string") {
		return redactText(value);
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return value;
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return REDACTED;
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactText(value.message),
		};
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return REDACTED;
		}
		seen.add(value);
		return value.map((entry) => redactUnknown(entry, seen));
	}
	if (typeof value === "object") {
		if (seen.has(value)) {
			return REDACTED;
		}
		seen.add(value);
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			result[key] = redactObjectEntry(key, entry, seen);
		}
		return result;
	}
	return REDACTED;
}

function redactObjectEntry(key: string, value: unknown, seen: WeakSet<object>): unknown {
	if (isCompactionKey(key)) {
		return REDACTED_COMPACTION;
	}
	if (isUserContentKey(key) || isCredentialKey(key)) {
		return REDACTED;
	}
	if (isPathKey(key) && typeof value === "string" && looksLikeAbsolutePath(value)) {
		return REDACTED_PATH;
	}
	return redactUnknown(value, seen);
}

function redactText(value: string): string {
	let redacted = value;
	redacted = redacted.replace(AUTHORIZATION_HEADER, "$1: [REDACTED]");
	redacted = redacted.replace(BEARER_TOKEN, "$1 [REDACTED]");
	redacted = redacted.replace(API_KEY_LITERAL, REDACTED);
	redacted = redacted.replace(JWT_LITERAL, REDACTED);
	redacted = redacted.replace(ABSOLUTE_UNIX_PATH, REDACTED_PATH);
	redacted = redacted.replace(ABSOLUTE_WINDOWS_PATH, REDACTED_PATH);
	return redacted;
}

function isCredentialKey(key: string): boolean {
	return (
		/authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|password|secret|credential/i.test(
			key,
		) && !isPathKey(key)
	);
}

function isUserContentKey(key: string): boolean {
	return /^(?:prompt|message|messages|content|input|input[_-]?preview|chars|user[_-]?content)$/i.test(
		key,
	);
}

function isCompactionKey(key: string): boolean {
	return /^(?:compaction|compaction[_-]?output|compacted(?:[_-]?items)?)$/i.test(key);
}

function isPathKey(key: string): boolean {
	return /(?:path|file|filename|dir|directory|workdir|cwd|root)$/i.test(key);
}

function looksLikeAbsolutePath(value: string): boolean {
	return (
		value.startsWith("/home/") ||
		value.startsWith("/Users/") ||
		value.startsWith("/private/") ||
		value.startsWith("/var/folders/") ||
		/^[A-Za-z]:\\(?:Users|home)/i.test(value) ||
		value.startsWith("\\\\")
	);
}

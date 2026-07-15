import type { CodexConfig } from "../domain/config.ts";

export interface DiagnosticExport {
	path: string;
	sha256: string;
}

export interface DiagnosticsExporter {
	export(snapshot: DiagnosticsSnapshot, path: string): Promise<DiagnosticExport>;
}

export type SafeDiagnosticErrorCategory =
	| "ConfigurationError"
	| "AuthenticationError"
	| "ProtocolError"
	| "CapabilityError"
	| "NativeToolError";

export interface SafeDiagnosticError {
	category: SafeDiagnosticErrorCategory;
	code: string;
	message: string;
	requestId?: string;
	retryable?: boolean;
}

/**
 * Host-sourced diagnostic inputs. Callers must already redact secrets and user content.
 * Unavailable values are omitted rather than invented.
 */
export interface DiagnosticsHostContext {
	adaptorVersion?: string;
	/** Only include when the host already resolved a Pi version string. */
	piVersion?: string;
	os?: string;
	arch?: string;
	/** Lowercase hex SHA-256 of the active bridge binary when known. */
	binaryChecksum?: string;
	/** Recent errors already classified and redacted by the host. */
	recentErrors?: readonly unknown[];
}

export interface DiagnosticsSnapshot {
	schemaVersion: 1;
	configSchemaVersion: 1;
	adaptor?: { version: string };
	pi?: { version: string };
	runtime?: { os: string; arch: string };
	bridge: Record<string, unknown>;
	recentErrors?: readonly SafeDiagnosticError[];
	binaryChecksum?: string;
}

const BRIDGE_FIELDS = [
	"bridgeProtocolVersion",
	"officialCodexVersion",
	"officialCodexTag",
	"officialSourceCommit",
	"buildTarget",
	"buildSourceCommit",
	"vendorTreeSha256",
	"capabilities",
] as const;

const SAFE_ERROR_CATEGORIES = new Set<SafeDiagnosticErrorCategory>([
	"ConfigurationError",
	"AuthenticationError",
	"ProtocolError",
	"CapabilityError",
	"NativeToolError",
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_SAFE_STRING = 256;
const MAX_RECENT_ERRORS = 20;

export class DiagnosticsExportError extends Error {
	readonly code: "confirmation_required" | "export_failure";

	constructor(code: DiagnosticsExportError["code"], message: string) {
		super(message);
		this.name = "DiagnosticsExportError";
		this.code = code;
	}
}

export function createDiagnosticsSnapshot(
	config: CodexConfig,
	nativeDiagnostics: unknown,
	host: DiagnosticsHostContext = {},
): DiagnosticsSnapshot {
	const source = record(nativeDiagnostics);
	const bridge: Record<string, unknown> = {};
	for (const field of BRIDGE_FIELDS) {
		const value = source?.[field];
		if (isSafeDiagnosticValue(value)) bridge[field] = value;
	}

	const snapshot: DiagnosticsSnapshot = {
		schemaVersion: 1,
		configSchemaVersion: config.schemaVersion,
		bridge,
		recentErrors: sanitizeRecentErrors(host.recentErrors ?? source?.recentErrors),
	};

	const adaptorVersion = sanitizeIdentityString(host.adaptorVersion);
	if (adaptorVersion !== undefined) {
		snapshot.adaptor = { version: adaptorVersion };
	}

	const piVersion = sanitizeIdentityString(host.piVersion);
	if (piVersion !== undefined) {
		snapshot.pi = { version: piVersion };
	}

	const os = sanitizeIdentityString(host.os);
	const arch = sanitizeIdentityString(host.arch);
	if (os !== undefined && arch !== undefined) {
		snapshot.runtime = { os, arch };
	}

	const binaryChecksum = sanitizeChecksum(
		host.binaryChecksum ?? source?.binaryChecksum ?? source?.binarySha256,
	);
	if (binaryChecksum !== undefined) {
		snapshot.binaryChecksum = binaryChecksum;
	}

	return snapshot;
}

/**
 * Export only after explicit user confirmation. Re-sanitizes the snapshot so callers cannot
 * smuggle non-allowlisted fields through a mutated object.
 */
export async function exportDiagnosticsConfirmed(
	exporter: DiagnosticsExporter,
	snapshot: DiagnosticsSnapshot,
	path: string,
	options: { confirmed: boolean },
): Promise<DiagnosticExport> {
	if (options.confirmed !== true) {
		throw new DiagnosticsExportError(
			"confirmation_required",
			"Diagnostics export requires explicit confirmation",
		);
	}
	try {
		return await exporter.export(sanitizeSnapshot(snapshot), path);
	} catch (error) {
		if (error instanceof DiagnosticsExportError) throw error;
		throw new DiagnosticsExportError("export_failure", "Codex diagnostics could not be exported");
	}
}

export function sanitizeSnapshot(snapshot: DiagnosticsSnapshot): DiagnosticsSnapshot {
	const bridge: Record<string, unknown> = {};
	const sourceBridge = record(snapshot.bridge) ?? {};
	for (const field of BRIDGE_FIELDS) {
		const value = sourceBridge[field];
		if (isSafeDiagnosticValue(value)) bridge[field] = value;
	}

	const sanitized: DiagnosticsSnapshot = {
		schemaVersion: 1,
		configSchemaVersion: 1,
		bridge,
		recentErrors: sanitizeRecentErrors(snapshot.recentErrors),
	};

	const adaptorVersion = sanitizeIdentityString(snapshot.adaptor?.version);
	if (adaptorVersion !== undefined) sanitized.adaptor = { version: adaptorVersion };

	const piVersion = sanitizeIdentityString(snapshot.pi?.version);
	if (piVersion !== undefined) sanitized.pi = { version: piVersion };

	const os = sanitizeIdentityString(snapshot.runtime?.os);
	const arch = sanitizeIdentityString(snapshot.runtime?.arch);
	if (os !== undefined && arch !== undefined) sanitized.runtime = { os, arch };

	const binaryChecksum = sanitizeChecksum(snapshot.binaryChecksum);
	if (binaryChecksum !== undefined) sanitized.binaryChecksum = binaryChecksum;

	return sanitized;
}

function sanitizeRecentErrors(value: unknown): SafeDiagnosticError[] {
	if (!Array.isArray(value)) return [];
	const errors: SafeDiagnosticError[] = [];
	for (const entry of value) {
		if (errors.length >= MAX_RECENT_ERRORS) break;
		const sanitized = sanitizeError(entry);
		if (sanitized !== undefined) errors.push(sanitized);
	}
	return errors;
}

function sanitizeError(value: unknown): SafeDiagnosticError | undefined {
	const entry = record(value);
	if (entry === undefined) return undefined;
	if (
		typeof entry.category !== "string" ||
		!SAFE_ERROR_CATEGORIES.has(entry.category as SafeDiagnosticErrorCategory)
	) {
		return undefined;
	}
	const code = sanitizeIdentityString(entry.code);
	const message = sanitizeErrorMessage(entry.message);
	if (code === undefined || message === undefined) return undefined;

	const result: SafeDiagnosticError = {
		category: entry.category as SafeDiagnosticErrorCategory,
		code,
		message,
	};
	const requestId = sanitizeIdentityString(entry.requestId);
	if (requestId !== undefined) result.requestId = requestId;
	if (typeof entry.retryable === "boolean") result.retryable = entry.retryable;
	return result;
}

function sanitizeIdentityString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_SAFE_STRING) return undefined;
	if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
	if (trimmed.startsWith("/") || trimmed.includes("\\")) return undefined;
	return trimmed;
}

function sanitizeErrorMessage(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	// Keep only a bounded, single-line message; drop path-like and credential-like content.
	if (trimmed.length > 512) return undefined;
	if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
	if (/(api[_-]?key|token|bearer|authorization|password)/i.test(trimmed)) return undefined;
	if (trimmed.startsWith("/") || /[A-Za-z]:\\/.test(trimmed)) return undefined;
	return trimmed;
}

function sanitizeChecksum(value: unknown): string | undefined {
	return typeof value === "string" && SHA256_HEX.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isSafeDiagnosticValue(value: unknown): boolean {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"))
	);
}

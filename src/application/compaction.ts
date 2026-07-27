import type { CompactionConfig } from "../domain/config.ts";
import { isStrictJsonArray, isStrictJsonValue, isStrictPlainRecord } from "./structured-json.ts";

export const CODEX_REMOTE_COMPACTION_KIND = "pi-codex-adaptor.remote-compaction" as const;
export const CODEX_REMOTE_COMPACTION_VERSION = 1 as const;

export type StructuredJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly StructuredJsonValue[]
	| { readonly [key: string]: StructuredJsonValue };

export type StructuredResponseItem = { readonly [key: string]: StructuredJsonValue };

export type CodexAuthenticationBindingV1 =
	| { readonly kind: "jwt_account"; readonly fingerprint: string }
	| { readonly kind: "credential"; readonly fingerprint: string };

export interface CodexCompactionIdentity {
	readonly sessionFingerprint: string;
	readonly providerId: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly modelId: string;
	readonly authenticationBinding: CodexAuthenticationBindingV1;
}

export interface NormalizedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly reasoningTokens?: number;
}

export interface CodexRemoteCompactionCheckpointV1 extends CodexCompactionIdentity {
	readonly kind: typeof CODEX_REMOTE_COMPACTION_KIND;
	readonly version: typeof CODEX_REMOTE_COMPACTION_VERSION;
	readonly checkpointId: string;
	readonly coveredEntryId: string;
	readonly implementation: "remote_v2" | "compact_endpoint";
	readonly output: readonly StructuredResponseItem[];
	readonly tokensBefore: number;
	readonly usage?: NormalizedUsage;
}

const MAX_IDENTITY_FIELD_LENGTH = 4096;
const MAX_CHECKPOINT_ID_LENGTH = 256;
const MAX_OUTPUT_ITEMS = 8192;

const RESPONSE_ITEM_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["additional_tools", new Set(["type", "id", "role", "tools"])],
	[
		"message",
		new Set([
			"type",
			"id",
			"role",
			"content",
			"phase",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"agent_message",
		new Set([
			"type",
			"id",
			"author",
			"recipient",
			"content",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"reasoning",
		new Set([
			"type",
			"id",
			"summary",
			"content",
			"encrypted_content",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"local_shell_call",
		new Set([
			"type",
			"id",
			"call_id",
			"status",
			"action",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"function_call",
		new Set([
			"type",
			"id",
			"name",
			"namespace",
			"arguments",
			"call_id",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"tool_search_call",
		new Set([
			"type",
			"id",
			"call_id",
			"status",
			"execution",
			"arguments",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"function_call_output",
		new Set(["type", "id", "call_id", "output", "internal_chat_message_metadata_passthrough"]),
	],
	[
		"custom_tool_call",
		new Set([
			"type",
			"id",
			"status",
			"call_id",
			"name",
			"namespace",
			"input",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"custom_tool_call_output",
		new Set([
			"type",
			"id",
			"call_id",
			"name",
			"output",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"tool_search_output",
		new Set([
			"type",
			"id",
			"call_id",
			"status",
			"execution",
			"tools",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"web_search_call",
		new Set(["type", "id", "status", "action", "internal_chat_message_metadata_passthrough"]),
	],
	[
		"image_generation_call",
		new Set([
			"type",
			"id",
			"status",
			"revised_prompt",
			"result",
			"internal_chat_message_metadata_passthrough",
		]),
	],
	[
		"compaction",
		new Set(["type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough"]),
	],
	[
		"context_compaction",
		new Set(["type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough"]),
	],
]);

export function isSupportedStructuredResponseItem(value: unknown): value is StructuredResponseItem {
	if (!isStrictPlainRecord(value) || typeof value.type !== "string") return false;
	const fields = RESPONSE_ITEM_FIELDS.get(value.type);
	if (fields === undefined || Object.keys(value).some((key) => !fields.has(key))) return false;
	if (!Object.values(value).every(isStrictJsonValue)) return false;
	if (value.type === "compaction" || value.type === "context_compaction") {
		return typeof value.encrypted_content === "string" && value.encrypted_content.length > 0;
	}
	return true;
}

export function validateCompactionOutput(value: unknown): readonly StructuredResponseItem[] {
	if (!isStrictJsonArray(value) || value.length === 0 || value.length > MAX_OUTPUT_ITEMS) {
		throw new Error("Remote compaction output is invalid");
	}
	let compactionItems = 0;
	const output = value.map((item) => {
		if (!isSupportedStructuredResponseItem(item))
			throw new Error("Remote compaction output item is invalid");
		if (item.type === "compaction") compactionItems += 1;
		return structuredClone(item);
	});
	if (compactionItems !== 1)
		throw new Error("Remote compaction output must contain exactly one compaction item");
	return Object.freeze(output);
}

export function createRemoteCompactionCheckpoint(
	identity: CodexCompactionIdentity,
	checkpointId: string,
	coveredEntryId: string,
	implementation: CodexRemoteCompactionCheckpointV1["implementation"],
	output: readonly unknown[],
	tokensBefore: number,
	usage?: NormalizedUsage,
): CodexRemoteCompactionCheckpointV1 {
	if (implementation !== "remote_v2" && implementation !== "compact_endpoint") {
		throw new Error("Remote compaction implementation is invalid");
	}
	return structuredClone({
		kind: CODEX_REMOTE_COMPACTION_KIND,
		version: CODEX_REMOTE_COMPACTION_VERSION,
		...validateIdentity(identity),
		checkpointId: requireText(checkpointId, "checkpoint ID", MAX_CHECKPOINT_ID_LENGTH),
		coveredEntryId: requireText(coveredEntryId, "covered entry ID"),
		implementation,
		output: validateCompactionOutput(output),
		tokensBefore: normalizeNonNegativeInteger(tokensBefore, "tokens before"),
		...(usage === undefined ? {} : { usage: validateUsage(usage) }),
	});
}

export function parseRemoteCompactionCheckpoint(
	value: unknown,
): CodexRemoteCompactionCheckpointV1 | undefined {
	if (!isStrictPlainRecord(value)) return undefined;
	const requiredKeys = [
		"kind",
		"version",
		"sessionFingerprint",
		"providerId",
		"api",
		"baseUrl",
		"modelId",
		"authenticationBinding",
		"checkpointId",
		"coveredEntryId",
		"implementation",
		"output",
		"tokensBefore",
	] as const;
	if (
		value.kind !== CODEX_REMOTE_COMPACTION_KIND ||
		value.version !== CODEX_REMOTE_COMPACTION_VERSION ||
		(!hasExactKeys(value, requiredKeys) && !hasExactKeys(value, [...requiredKeys, "usage"]))
	) {
		return undefined;
	}
	try {
		const implementation = value.implementation;
		if (implementation !== "remote_v2" && implementation !== "compact_endpoint") return undefined;
		const output = value.output;
		if (!isStrictJsonArray(output)) return undefined;
		return createRemoteCompactionCheckpoint(
			parseIdentity(value),
			requireText(value.checkpointId, "checkpoint ID", MAX_CHECKPOINT_ID_LENGTH),
			requireText(value.coveredEntryId, "covered entry ID"),
			implementation,
			output,
			normalizeNonNegativeInteger(value.tokensBefore, "tokens before"),
			value.usage === undefined ? undefined : parseUsage(value.usage),
		);
	} catch {
		return undefined;
	}
}

export function sameCompactionIdentity(
	left: CodexCompactionIdentity | undefined,
	right: CodexCompactionIdentity | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.sessionFingerprint === right.sessionFingerprint &&
		left.providerId === right.providerId &&
		left.api === right.api &&
		left.baseUrl === right.baseUrl &&
		left.modelId === right.modelId &&
		left.authenticationBinding.kind === right.authenticationBinding.kind &&
		left.authenticationBinding.fingerprint === right.authenticationBinding.fingerprint
	);
}

/** Process-local lifecycle serialization and one-time continuity warnings only. */
export class CodexCompactionStore {
	readonly #warningKeys = new Set<string>();

	warnOnce(sessionId: string, identity: CodexCompactionIdentity): boolean {
		const key = `${sessionId}\u0000${identityKey(identity)}`;
		if (this.#warningKeys.has(key)) return false;
		this.#warningKeys.add(key);
		return true;
	}

	warnSessionOnce(sessionId: string): boolean {
		const key = `${sessionId}\u0000<inactive>`;
		if (this.#warningKeys.has(key)) return false;
		this.#warningKeys.add(key);
		return true;
	}

	dispose(sessionId: string): void {
		for (const key of this.#warningKeys) {
			if (key.startsWith(`${sessionId}\u0000`)) this.#warningKeys.delete(key);
		}
	}

	disposeAll(): void {
		this.#warningKeys.clear();
	}
}

export type CompactionCoordinatorPhase = "idle" | "pending" | "executing";

export class CodexCompactionCoordinator {
	readonly #sessions = new Map<string, CompactionCoordinatorPhase>();

	isBusy(sessionId: string): boolean {
		return this.#sessions.get(sessionId) !== undefined && this.#sessions.get(sessionId) !== "idle";
	}

	begin(sessionId: string): boolean {
		if (this.isBusy(sessionId)) return false;
		this.#sessions.set(sessionId, "pending");
		return true;
	}

	beginExecution(sessionId: string): boolean {
		if (this.#sessions.get(sessionId) === "executing") return false;
		this.#sessions.set(sessionId, "executing");
		return true;
	}

	end(sessionId: string, _outcome: "success" | "error" | "cancel"): void {
		this.#sessions.set(sessionId, "idle");
	}

	endPending(sessionId: string, outcome: "success" | "error" | "cancel"): void {
		this.end(sessionId, outcome);
	}

	dispose(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}

	disposeAll(): void {
		this.#sessions.clear();
	}
}

export function resolveCompactionThreshold(
	compaction: CompactionConfig,
	modelAutoCompactTokenLimit: number | null,
	contextWindow: number,
): number | undefined {
	if (compaction.mode === "off" || !Number.isFinite(contextWindow) || contextWindow <= 0)
		return undefined;
	const candidate =
		typeof compaction.autoCompactTokenLimit === "number"
			? compaction.autoCompactTokenLimit
			: modelAutoCompactTokenLimit;
	if (
		candidate === null ||
		candidate === undefined ||
		!Number.isFinite(candidate) ||
		candidate <= 0
	)
		return undefined;
	const threshold = Math.trunc(candidate);
	return threshold < contextWindow ? threshold : undefined;
}

export function shouldCreateAutomaticCheckpoint(options: {
	mode: CompactionConfig["mode"];
	contextTokens: number | null;
	threshold: number | undefined;
	hasUncheckpointedInput: boolean;
	busy: boolean;
}): boolean {
	return (
		options.mode === "auto" &&
		options.contextTokens !== null &&
		Number.isFinite(options.contextTokens) &&
		options.threshold !== undefined &&
		options.contextTokens > options.threshold &&
		options.hasUncheckpointedInput &&
		!options.busy
	);
}

function validateIdentity(identity: CodexCompactionIdentity): CodexCompactionIdentity {
	if (!isStrictPlainRecord(identity)) throw new Error("Compaction identity is invalid");
	return {
		sessionFingerprint: requireText(identity.sessionFingerprint, "session fingerprint"),
		providerId: requireText(identity.providerId, "provider ID"),
		api: requireText(identity.api, "API"),
		baseUrl: requireText(identity.baseUrl, "base URL"),
		modelId: requireText(identity.modelId, "model ID"),
		authenticationBinding: validateAuthenticationBinding(identity.authenticationBinding),
	};
}

function parseIdentity(value: Record<string, unknown>): CodexCompactionIdentity {
	return validateIdentity({
		sessionFingerprint: value.sessionFingerprint as string,
		providerId: value.providerId as string,
		api: value.api as string,
		baseUrl: value.baseUrl as string,
		modelId: value.modelId as string,
		authenticationBinding: value.authenticationBinding as CodexAuthenticationBindingV1,
	});
}

function validateAuthenticationBinding(value: unknown): CodexAuthenticationBindingV1 {
	if (!isStrictPlainRecord(value) || !hasExactKeys(value, ["kind", "fingerprint"])) {
		throw new Error("Authentication binding is invalid");
	}
	if (value.kind !== "jwt_account" && value.kind !== "credential") {
		throw new Error("Authentication binding is invalid");
	}
	return {
		kind: value.kind,
		fingerprint: requireText(value.fingerprint, "authentication fingerprint"),
	};
}

function validateUsage(value: NormalizedUsage): NormalizedUsage {
	if (!isStrictPlainRecord(value)) throw new Error("Usage is invalid");
	const keys = ["inputTokens", "outputTokens", "cachedInputTokens"] as const;
	if (!hasExactKeys(value, keys) && !hasExactKeys(value, [...keys, "reasoningTokens"])) {
		throw new Error("Usage is invalid");
	}
	return {
		inputTokens: normalizeNonNegativeInteger(value.inputTokens, "input tokens"),
		outputTokens: normalizeNonNegativeInteger(value.outputTokens, "output tokens"),
		cachedInputTokens: normalizeNonNegativeInteger(value.cachedInputTokens, "cached input tokens"),
		...(value.reasoningTokens === undefined
			? {}
			: {
					reasoningTokens: normalizeNonNegativeInteger(value.reasoningTokens, "reasoning tokens"),
				}),
	};
}

function parseUsage(value: unknown): NormalizedUsage {
	return validateUsage(value as NormalizedUsage);
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
	return value as number;
}

function requireText(value: unknown, label: string, maximum = MAX_IDENTITY_FIELD_LENGTH): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		value.trim().length === 0 ||
		hasControlCharacter(value)
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function identityKey(identity: CodexCompactionIdentity): string {
	return [
		identity.sessionFingerprint,
		identity.providerId,
		identity.api,
		identity.baseUrl,
		identity.modelId,
		identity.authenticationBinding.kind,
		identity.authenticationBinding.fingerprint,
	].join("\u0001");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	);
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

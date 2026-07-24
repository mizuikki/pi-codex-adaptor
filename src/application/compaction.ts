import type { CompactionConfig } from "../domain/config.ts";
import { isStrictJsonArray, isStrictJsonValue, isStrictPlainRecord } from "./structured-json.ts";

export const CODEX_COMPACTION_DETAILS_KIND = "pi-codex-adaptor.compaction";
export const CODEX_COMPACTION_DETAILS_VERSION = 3;
export const CODEX_COMPACTION_LEGACY_DETAILS_VERSION = 2;
export const CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION = 1;
export const CODEX_AUTO_COMPACTION_KIND = "pi-codex-adaptor.auto-compaction";
export const CODEX_AUTO_COMPACTION_VERSION = 1;

export type StructuredJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly StructuredJsonValue[]
	| { readonly [key: string]: StructuredJsonValue };

export type StructuredResponseItem = {
	readonly [key: string]: StructuredJsonValue;
};

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

export interface CodexOpaqueCompactionDetailsV3 extends CodexCompactionIdentity {
	output: readonly StructuredResponseItem[];
}

export interface CodexPortableCompactionDetailsV3 {
	kind: typeof CODEX_COMPACTION_DETAILS_KIND;
	version: typeof CODEX_COMPACTION_DETAILS_VERSION;
	portable: {
		readonly summarySha256: string;
	};
	readonly opaque?: CodexOpaqueCompactionDetailsV3;
}

export interface CodexLegacyCompactionDetailsV2 extends CodexCompactionIdentity {
	kind: typeof CODEX_COMPACTION_DETAILS_KIND;
	version: typeof CODEX_COMPACTION_LEGACY_DETAILS_VERSION;
	output: readonly StructuredResponseItem[];
}

export interface CodexLegacyCompactionDetailsV1 {
	kind: typeof CODEX_COMPACTION_DETAILS_KIND;
	version: typeof CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION;
	modelId: string;
	output: readonly StructuredResponseItem[];
	readonly replay: "legacy_identity_missing";
}

export type CodexCompactionDetails = CodexPortableCompactionDetailsV3;
export type ParsedCodexCompactionDetails =
	| CodexPortableCompactionDetailsV3
	| CodexLegacyCompactionDetailsV2
	| CodexLegacyCompactionDetailsV1;

export interface CodexAutoCompactionCheckpointV1 extends CodexCompactionIdentity {
	kind: typeof CODEX_AUTO_COMPACTION_KIND;
	version: typeof CODEX_AUTO_COMPACTION_VERSION;
	checkpointId: string;
	coveredEntryId: string;
	output: readonly StructuredResponseItem[];
}

export type CompactionTrigger = "manual" | "auto";
export type CompactionPhase = "standalone_turn" | "pre_turn" | "mid_turn";

export interface CompactionOperation {
	readonly trigger: CompactionTrigger;
	readonly phase: CompactionPhase;
	readonly sessionId: string;
	readonly modelId: string;
	readonly input: readonly StructuredResponseItem[];
}

export type CodexCompactionSnapshot =
	| {
			readonly source: "manual";
			readonly summary: string;
			readonly entryId?: string;
			readonly details: CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2;
			readonly output?: readonly StructuredResponseItem[];
	  }
	| {
			readonly source: "automatic";
			readonly entryId?: string;
			readonly checkpoint: CodexAutoCompactionCheckpointV1;
			readonly output: readonly StructuredResponseItem[];
	  };

/** Storage-neutral entry view for pure boundary classification. */
export interface PersistedCompactionEntryView {
	readonly type: "compaction" | "custom";
	readonly id?: string | undefined;
	readonly parentId?: string | null | undefined;
	readonly summary?: string | undefined;
	readonly details?: unknown;
	readonly firstKeptEntryId?: string | undefined;
	readonly usage?: unknown;
	readonly retainedTail?: unknown;
	readonly customType?: string | undefined;
	readonly data?: unknown;
}

export type PersistedCompactionKind =
	| { readonly source: "portable_pi"; readonly entry: PersistedCompactionEntryView }
	| {
			readonly source: "adaptor_v3";
			readonly entry: PersistedCompactionEntryView;
			readonly details: CodexPortableCompactionDetailsV3;
	  }
	| {
			readonly source: "legacy_opaque";
			readonly entry: PersistedCompactionEntryView;
			readonly details:
				| CodexLegacyCompactionDetailsV2
				| CodexLegacyCompactionDetailsV1
				| CodexAutoCompactionCheckpointV1;
	  }
	| { readonly source: "malformed_adaptor" };

export interface CommittedCompactionProposalExpectation {
	readonly parentId?: string | null;
	readonly summary?: string;
	readonly summarySha256?: string;
	readonly firstKeptEntryId?: string;
	readonly usage?: unknown;
	readonly retainedTail?: unknown;
	readonly details?: CodexPortableCompactionDetailsV3;
}

export interface PendingCommittedCompactionExpectation
	extends CommittedCompactionProposalExpectation {
	readonly summary: string;
	readonly summarySha256: string;
	readonly details: CodexPortableCompactionDetailsV3;
}

const SUPPORTED_RESPONSE_ITEM_TYPES = new Set([
	"additional_tools",
	"message",
	"agent_message",
	"reasoning",
	"local_shell_call",
	"function_call",
	"tool_search_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"tool_search_output",
	"web_search_call",
	"image_generation_call",
	"compaction",
	"context_compaction",
]);

const SUPPORTED_RESPONSE_ITEM_FIELDS = new Map<string, ReadonlySet<string>>([
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

const MAX_CHECKPOINT_ID_LENGTH = 256;
const MAX_IDENTITY_FIELD_LENGTH = 4096;

export class CodexCompactionStore {
	readonly #sessions = new Map<string, CodexCompactionSnapshot>();
	readonly #replayInvalid = new Set<string>();
	readonly #pendingCommits = new Map<string, PendingCommittedCompactionExpectation>();

	get(sessionId: string | undefined, modelId: string): CodexCompactionSnapshot | undefined {
		if (sessionId === undefined || this.#replayInvalid.has(sessionId)) return undefined;
		const snapshot = this.#sessions.get(sessionId);
		if (snapshot === undefined) return undefined;
		const identity = snapshotIdentity(snapshot);
		if (identity === undefined) return undefined;
		return identity.modelId === modelId ? snapshot : undefined;
	}

	getForSession(sessionId: string | undefined): CodexCompactionSnapshot | undefined {
		if (sessionId === undefined || this.#replayInvalid.has(sessionId)) return undefined;
		return this.#sessions.get(sessionId);
	}

	set(
		sessionId: string,
		summary: string,
		details:
			| CodexPortableCompactionDetailsV3
			| CodexLegacyCompactionDetailsV2
			| CodexLegacyCompactionDetailsV1,
	): void {
		if (details.version === CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION) {
			this.clear(sessionId);
			return;
		}
		this.setManual(sessionId, summary, details);
	}

	setManual(
		sessionId: string,
		summary: string,
		details: CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2,
		entryId?: string,
	): void {
		this.#replayInvalid.delete(sessionId);
		const output = opaqueOutputFromDetails(details);
		this.#sessions.set(sessionId, {
			source: "manual",
			summary,
			details: cloneCompactionDetails(details),
			...(output === undefined ? {} : { output }),
			...(entryId === undefined ? {} : { entryId }),
		});
	}

	setAutomatic(
		sessionId: string,
		checkpoint: CodexAutoCompactionCheckpointV1,
		entryId?: string,
	): void {
		this.#replayInvalid.delete(sessionId);
		this.#sessions.set(sessionId, {
			source: "automatic",
			checkpoint: cloneAutomaticCheckpoint(checkpoint),
			output: cloneOutputWindow(checkpoint.output),
			...(entryId === undefined ? {} : { entryId }),
		});
	}

	setPendingCommit(sessionId: string, expected: PendingCommittedCompactionExpectation): void {
		this.#pendingCommits.set(sessionId, structuredClone(expected));
	}

	getPendingCommit(sessionId: string): PendingCommittedCompactionExpectation | undefined {
		const expected = this.#pendingCommits.get(sessionId);
		return expected === undefined ? undefined : structuredClone(expected);
	}

	clearPendingCommit(sessionId: string): void {
		this.#pendingCommits.delete(sessionId);
	}

	clear(sessionId: string): void {
		this.#sessions.delete(sessionId);
		this.#replayInvalid.delete(sessionId);
		this.#pendingCommits.delete(sessionId);
	}

	markReplayInvalid(sessionId: string): void {
		this.#replayInvalid.add(sessionId);
		this.#sessions.delete(sessionId);
		this.#pendingCommits.delete(sessionId);
	}

	isReplayInvalid(sessionId: string): boolean {
		return this.#replayInvalid.has(sessionId);
	}

	dispose(sessionId: string): void {
		this.clear(sessionId);
	}

	disposeAll(): void {
		this.#sessions.clear();
		this.#replayInvalid.clear();
		this.#pendingCommits.clear();
	}
}

export function createCodexCompactionDetails(
	identity: CodexCompactionIdentity,
	output: readonly unknown[],
): CodexLegacyCompactionDetailsV2;
/** Compatibility constructor for callers that only have the legacy model/output pair. */
export function createCodexCompactionDetails(
	modelId: string,
	output: readonly unknown[],
): CodexLegacyCompactionDetailsV1;
export function createCodexCompactionDetails(
	identityOrModel: CodexCompactionIdentity | string,
	output: readonly unknown[],
): CodexLegacyCompactionDetailsV2 | CodexLegacyCompactionDetailsV1 {
	if (typeof identityOrModel === "string") {
		return {
			kind: CODEX_COMPACTION_DETAILS_KIND,
			version: CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION,
			modelId: requireIdentityText(identityOrModel, "model id"),
			output: cloneLegacyOutputWindow(output),
			replay: "legacy_identity_missing",
		};
	}
	return {
		kind: CODEX_COMPACTION_DETAILS_KIND,
		version: CODEX_COMPACTION_LEGACY_DETAILS_VERSION,
		...validateIdentity(identityOrModel),
		output: cloneOutputWindow(output),
	};
}

export function createPortableCompactionDetails(
	portableSummarySha256: string,
	opaque?:
		| {
				readonly identity: CodexCompactionIdentity;
				readonly output: readonly unknown[];
		  }
		| undefined,
): CodexPortableCompactionDetailsV3 {
	if (typeof portableSummarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(portableSummarySha256)) {
		throw new Error("summary digest is invalid");
	}
	return {
		kind: CODEX_COMPACTION_DETAILS_KIND,
		version: CODEX_COMPACTION_DETAILS_VERSION,
		portable: { summarySha256: portableSummarySha256 },
		...(opaque === undefined
			? {}
			: {
					opaque: {
						...validateIdentity(opaque.identity),
						output: cloneOutputWindow(opaque.output),
					},
				}),
	};
}

export function createCodexAutoCompactionCheckpoint(
	identity: CodexCompactionIdentity,
	checkpointId: string,
	coveredEntryId: string,
	output: readonly unknown[],
): CodexAutoCompactionCheckpointV1 {
	return {
		kind: CODEX_AUTO_COMPACTION_KIND,
		version: CODEX_AUTO_COMPACTION_VERSION,
		checkpointId: validateCheckpointId(checkpointId),
		coveredEntryId: requireIdentityText(coveredEntryId, "covered entry id"),
		...validateIdentity(identity),
		output: cloneOutputWindow(output),
	};
}

export function parseCodexCompactionDetails(
	value: unknown,
): ParsedCodexCompactionDetails | undefined {
	const object = plainRecord(value);
	if (object === undefined || object.kind !== CODEX_COMPACTION_DETAILS_KIND) return undefined;
	if (object.version === CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION) {
		if (
			(!hasExactKeys(object, ["kind", "version", "modelId", "output"]) &&
				(!hasExactKeys(object, ["kind", "version", "modelId", "output", "replay"]) ||
					object.replay !== "legacy_identity_missing")) ||
			typeof object.modelId !== "string" ||
			object.modelId.length === 0 ||
			!isLegacyOutputWindow(object.output)
		) {
			return undefined;
		}
		try {
			return {
				kind: CODEX_COMPACTION_DETAILS_KIND,
				version: CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION,
				modelId: requireIdentityText(object.modelId, "model id"),
				output: cloneLegacyOutputWindow(object.output as readonly unknown[]),
				replay: "legacy_identity_missing",
			};
		} catch {
			return undefined;
		}
	}
	if (object.version === CODEX_COMPACTION_LEGACY_DETAILS_VERSION) {
		if (
			!hasExactKeys(object, [
				"kind",
				"version",
				"sessionFingerprint",
				"providerId",
				"api",
				"baseUrl",
				"modelId",
				"authenticationBinding",
				"output",
			])
		) {
			return undefined;
		}
		try {
			return {
				kind: CODEX_COMPACTION_DETAILS_KIND,
				version: CODEX_COMPACTION_LEGACY_DETAILS_VERSION,
				...parseIdentity(object),
				output: cloneOutputWindow(object.output as readonly unknown[]),
			};
		} catch {
			return undefined;
		}
	}
	if (object.version !== CODEX_COMPACTION_DETAILS_VERSION) return undefined;
	const portable = plainRecord(object.portable);
	if (
		(!hasExactKeys(object, ["kind", "version", "portable"]) &&
			!hasExactKeys(object, ["kind", "version", "portable", "opaque"])) ||
		portable === undefined ||
		!hasExactKeys(portable, ["summarySha256"]) ||
		typeof portable.summarySha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(portable.summarySha256)
	) {
		return undefined;
	}
	const opaque = object.opaque === undefined ? undefined : plainRecord(object.opaque);
	if (object.opaque !== undefined && opaque === undefined) return undefined;
	if (
		opaque !== undefined &&
		!hasExactKeys(opaque, [
			"sessionFingerprint",
			"providerId",
			"api",
			"baseUrl",
			"modelId",
			"authenticationBinding",
			"output",
		])
	) {
		return undefined;
	}
	try {
		return {
			kind: CODEX_COMPACTION_DETAILS_KIND,
			version: CODEX_COMPACTION_DETAILS_VERSION,
			portable: { summarySha256: portable.summarySha256 },
			...(opaque === undefined
				? {}
				: {
						opaque: {
							...parseIdentity(opaque),
							output: cloneOutputWindow(opaque.output as readonly unknown[]),
						},
					}),
		};
	} catch {
		return undefined;
	}
}

export function parseCodexAutoCompactionCheckpoint(
	value: unknown,
): CodexAutoCompactionCheckpointV1 | undefined {
	const object = plainRecord(value);
	if (
		object === undefined ||
		object.kind !== CODEX_AUTO_COMPACTION_KIND ||
		object.version !== CODEX_AUTO_COMPACTION_VERSION ||
		!hasExactKeys(object, [
			"kind",
			"version",
			"checkpointId",
			"coveredEntryId",
			"sessionFingerprint",
			"providerId",
			"api",
			"baseUrl",
			"modelId",
			"authenticationBinding",
			"output",
		])
	) {
		return undefined;
	}
	try {
		return {
			kind: CODEX_AUTO_COMPACTION_KIND,
			version: CODEX_AUTO_COMPACTION_VERSION,
			checkpointId: validateCheckpointId(object.checkpointId),
			coveredEntryId: requireIdentityText(object.coveredEntryId, "covered entry id"),
			...parseIdentity(object),
			output: cloneOutputWindow(object.output as readonly unknown[]),
		};
	} catch {
		return undefined;
	}
}

export function validateCompactionOutput(value: unknown): readonly StructuredResponseItem[] {
	if (!Array.isArray(value)) throw new Error("Compaction output window is invalid");
	return cloneOutputWindow(value as readonly unknown[]);
}

export function isReplayableCompactionDetails(
	value: ParsedCodexCompactionDetails | undefined,
): value is CodexLegacyCompactionDetailsV2 | CodexPortableCompactionDetailsV3 {
	return (
		value?.version === CODEX_COMPACTION_LEGACY_DETAILS_VERSION ||
		value?.version === CODEX_COMPACTION_DETAILS_VERSION
	);
}

export function opaqueIdentityFromDetails(
	details: CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2 | undefined,
): CodexCompactionIdentity | undefined {
	if (details === undefined) return undefined;
	if (details.version === CODEX_COMPACTION_LEGACY_DETAILS_VERSION) {
		return {
			sessionFingerprint: details.sessionFingerprint,
			providerId: details.providerId,
			api: details.api,
			baseUrl: details.baseUrl,
			modelId: details.modelId,
			authenticationBinding: details.authenticationBinding,
		};
	}
	if (details.opaque === undefined) return undefined;
	return {
		sessionFingerprint: details.opaque.sessionFingerprint,
		providerId: details.opaque.providerId,
		api: details.opaque.api,
		baseUrl: details.opaque.baseUrl,
		modelId: details.opaque.modelId,
		authenticationBinding: details.opaque.authenticationBinding,
	};
}

export function opaqueOutputFromDetails(
	details: CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2 | undefined,
): readonly StructuredResponseItem[] | undefined {
	if (details === undefined) return undefined;
	const output =
		details.version === CODEX_COMPACTION_LEGACY_DETAILS_VERSION
			? details.output
			: details.opaque?.output;
	return output === undefined ? undefined : cloneOutputWindow(output);
}

export function sameCompactionIdentity(
	left:
		| Pick<
				CodexCompactionIdentity,
				| "sessionFingerprint"
				| "providerId"
				| "api"
				| "baseUrl"
				| "modelId"
				| "authenticationBinding"
		  >
		| undefined,
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

export function matchingOpaqueSnapshotOutput(
	snapshot: CodexCompactionSnapshot | undefined,
	identity: CodexCompactionIdentity | undefined,
	summarySha256?: string,
): readonly StructuredResponseItem[] | undefined {
	if (snapshot === undefined || !sameCompactionIdentity(snapshotIdentity(snapshot), identity)) {
		return undefined;
	}
	if (snapshot.source === "manual") {
		if (snapshot.details.version === CODEX_COMPACTION_DETAILS_VERSION) {
			if (
				summarySha256 === undefined ||
				snapshot.details.portable.summarySha256 !== summarySha256 ||
				snapshot.details.opaque === undefined
			) {
				return undefined;
			}
		}
		return snapshot.output === undefined ? undefined : cloneOutputWindow(snapshot.output);
	}
	return snapshot.output;
}

/** Classify one durable compaction boundary without Pi runtime dependencies. */
export function classifyPersistedCompaction(
	entry: PersistedCompactionEntryView,
	summarySha256?: string,
): PersistedCompactionKind {
	if (entry.type === "custom") {
		if (entry.customType !== CODEX_AUTO_COMPACTION_KIND) {
			return { source: "portable_pi", entry };
		}
		const checkpoint = parseCodexAutoCompactionCheckpoint(entry.data);
		if (checkpoint === undefined) return { source: "malformed_adaptor" };
		return { source: "legacy_opaque", entry, details: checkpoint };
	}
	if (entry.type !== "compaction") return { source: "malformed_adaptor" };
	if (!claimsAdaptorCompactionDetails(entry.details)) {
		return { source: "portable_pi", entry };
	}
	const details = parseCodexCompactionDetails(entry.details);
	if (details === undefined) return { source: "malformed_adaptor" };
	if (details.version === CODEX_COMPACTION_DETAILS_VERSION) {
		if (typeof entry.summary !== "string" || entry.summary.length === 0) {
			return { source: "malformed_adaptor" };
		}
		if (summarySha256 === undefined || details.portable.summarySha256 !== summarySha256) {
			return { source: "malformed_adaptor" };
		}
		return { source: "adaptor_v3", entry, details };
	}
	if (
		details.version === CODEX_COMPACTION_LEGACY_DETAILS_VERSION ||
		details.version === CODEX_COMPACTION_MODEL_ONLY_DETAILS_VERSION
	) {
		return { source: "legacy_opaque", entry, details };
	}
	return { source: "malformed_adaptor" };
}

/**
 * Shared restore/commit validator for durable compaction boundaries.
 * Malformed claimed adaptor data fails closed; ordinary Pi entries remain portable.
 */
export function validateCommittedCompactionEntry(
	entry: PersistedCompactionEntryView,
	expected?: CommittedCompactionProposalExpectation,
	summarySha256?: string,
): { readonly ok: true; readonly kind: PersistedCompactionKind } | { readonly ok: false } {
	const kind = classifyPersistedCompaction(entry, summarySha256);
	if (kind.source === "malformed_adaptor") return { ok: false };
	if (expected === undefined) return { ok: true, kind };
	if (typeof entry.id !== "string" || entry.id.length === 0) return { ok: false };
	if (expected.parentId !== undefined && entry.parentId !== expected.parentId) return { ok: false };
	if (expected.summary !== undefined && entry.summary !== expected.summary) return { ok: false };
	if (
		expected.firstKeptEntryId !== undefined &&
		entry.firstKeptEntryId !== expected.firstKeptEntryId
	) {
		return { ok: false };
	}
	if (Object.hasOwn(expected, "usage") && !structuralEqual(entry.usage, expected.usage)) {
		return { ok: false };
	}
	if (
		Object.hasOwn(expected, "retainedTail") &&
		!structuralEqual(entry.retainedTail, expected.retainedTail)
	) {
		return { ok: false };
	}
	if (expected.details !== undefined) {
		if (kind.source !== "adaptor_v3") return { ok: false };
		if (!structuralEqual(kind.details, expected.details)) return { ok: false };
		if (
			expected.summarySha256 !== undefined &&
			kind.details.portable.summarySha256 !== expected.summarySha256
		) {
			return { ok: false };
		}
	}
	return { ok: true, kind };
}

function claimsAdaptorCompactionDetails(value: unknown): boolean {
	return isStrictPlainRecord(value) && value.kind === CODEX_COMPACTION_DETAILS_KIND;
}

function structuralEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function isStructuredJsonValue(value: unknown): value is StructuredJsonValue {
	return isStrictJsonValue(value);
}

/** Resolve the absolute token threshold used for inline automatic compaction. */
export function resolveCompactionThreshold(
	compaction: CompactionConfig,
	modelAutoCompactTokenLimit: number | null,
	contextWindow: number,
): number | undefined {
	if (compaction.mode === "off") return undefined;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const candidate =
		typeof compaction.autoCompactTokenLimit === "number"
			? compaction.autoCompactTokenLimit
			: modelAutoCompactTokenLimit;
	if (candidate === null || candidate === undefined) return undefined;
	if (!Number.isFinite(candidate) || candidate <= 0) return undefined;
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

export type CompactionCycleOutcome = "success" | "error" | "cancel";
export type CompactionCoordinatorPhase = "idle" | "pending" | "executing";

interface SessionCompactionGuard {
	phase: CompactionCoordinatorPhase;
}

/** Session-local serialization for manual and inline automatic compact calls. */
export class CodexCompactionCoordinator {
	readonly #sessions = new Map<string, SessionCompactionGuard>();

	isBusy(sessionId: string): boolean {
		const phase = this.#sessions.get(sessionId)?.phase;
		return phase !== undefined && phase !== "idle";
	}

	begin(sessionId: string): boolean {
		const state = this.#ensure(sessionId);
		if (state.phase !== "idle") return false;
		state.phase = "pending";
		return true;
	}

	beginExecution(sessionId: string): boolean {
		const state = this.#ensure(sessionId);
		if (state.phase === "executing") return false;
		state.phase = "executing";
		return true;
	}

	end(sessionId: string, _outcome: CompactionCycleOutcome): void {
		const state = this.#sessions.get(sessionId);
		if (state !== undefined) state.phase = "idle";
	}

	endPending(sessionId: string, _outcome: CompactionCycleOutcome): void {
		const state = this.#sessions.get(sessionId);
		if (state?.phase === "pending") state.phase = "idle";
	}

	dispose(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}

	disposeAll(): void {
		this.#sessions.clear();
	}

	#ensure(sessionId: string): SessionCompactionGuard {
		let state = this.#sessions.get(sessionId);
		if (state === undefined) {
			state = { phase: "idle" };
			this.#sessions.set(sessionId, state);
		}
		return state;
	}
}

function cloneCompactionDetails(
	details: CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2,
): CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2 {
	if (details.version === CODEX_COMPACTION_LEGACY_DETAILS_VERSION) {
		return createCodexCompactionDetails(details, details.output);
	}
	return {
		kind: CODEX_COMPACTION_DETAILS_KIND,
		version: CODEX_COMPACTION_DETAILS_VERSION,
		portable: { summarySha256: details.portable.summarySha256 },
		...(details.opaque === undefined
			? {}
			: {
					opaque: {
						...validateIdentity(details.opaque),
						output: cloneOutputWindow(details.opaque.output),
					},
				}),
	};
}

function cloneAutomaticCheckpoint(
	checkpoint: CodexAutoCompactionCheckpointV1,
): CodexAutoCompactionCheckpointV1 {
	return createCodexAutoCompactionCheckpoint(
		checkpoint,
		checkpoint.checkpointId,
		checkpoint.coveredEntryId,
		checkpoint.output,
	);
}

function snapshotIdentity(snapshot: CodexCompactionSnapshot): CodexCompactionIdentity | undefined {
	if (snapshot.source === "automatic") return snapshot.checkpoint;
	return opaqueIdentityFromDetails(snapshot.details);
}

function cloneOutputWindow(value: readonly unknown[]): readonly StructuredResponseItem[] {
	if (!isOutputWindow(value)) throw new Error("Compaction output window is invalid");
	const cloned = value.map((item) => cloneJson(item));
	return Object.freeze(cloned);
}

function cloneLegacyOutputWindow(value: readonly unknown[]): readonly StructuredResponseItem[] {
	if (!isLegacyOutputWindow(value)) throw new Error("Legacy compaction output window is invalid");
	return Object.freeze(value.map((item) => cloneJson(item)));
}

function isLegacyOutputWindow(value: unknown): value is readonly StructuredResponseItem[] {
	return isStrictJsonArray(value) && value.every(isSupportedStructuredResponseItem);
}

function isOutputWindow(value: unknown): value is readonly StructuredResponseItem[] {
	if (!isStrictJsonArray(value) || value.length === 0) return false;
	let compactions = 0;
	for (const item of value) {
		if (!isSupportedStructuredResponseItem(item)) return false;
		if (item.type === "compaction") {
			compactions += 1;
			if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
				return false;
			}
		}
	}
	return compactions === 1;
}

export function isSupportedStructuredResponseItem(value: unknown): value is StructuredResponseItem {
	const object = plainRecord(value);
	const type = object?.type;
	const allowedFields =
		typeof type === "string" ? SUPPORTED_RESPONSE_ITEM_FIELDS.get(type) : undefined;
	const basic =
		object !== undefined &&
		typeof type === "string" &&
		SUPPORTED_RESPONSE_ITEM_TYPES.has(type) &&
		allowedFields !== undefined &&
		Object.keys(object).every((key) => allowedFields.has(key)) &&
		Object.values(object).every(isStructuredJsonValue) &&
		validMetadata(object.internal_chat_message_metadata_passthrough);
	if (!basic) return false;
	return (
		type !== "compaction" ||
		(typeof object.encrypted_content === "string" && object.encrypted_content.length > 0)
	);
}

function validateIdentity(identity: CodexCompactionIdentity): CodexCompactionIdentity {
	if (!isStrictPlainRecord(identity)) throw new Error("Compaction identity is invalid");
	return {
		sessionFingerprint: requireIdentityText(identity.sessionFingerprint, "session fingerprint"),
		providerId: requireIdentityText(identity.providerId, "provider id"),
		api: requireIdentityText(identity.api, "API"),
		baseUrl: requireIdentityText(identity.baseUrl, "base URL"),
		modelId: requireIdentityText(identity.modelId, "model id"),
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

function validateAuthenticationBinding(
	value: CodexAuthenticationBindingV1,
): CodexAuthenticationBindingV1 {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Authentication binding is invalid");
	}
	const binding = value as Record<string, unknown>;
	if (
		!hasExactKeys(binding, ["kind", "fingerprint"]) ||
		(binding.kind !== "jwt_account" && binding.kind !== "credential")
	) {
		throw new Error("Authentication binding is invalid");
	}
	return {
		kind: binding.kind,
		fingerprint: requireIdentityText(binding.fingerprint, "authentication fingerprint"),
	};
}

function validateCheckpointId(value: unknown): string {
	return requireIdentityText(value, "checkpoint id", MAX_CHECKPOINT_ID_LENGTH);
}

function requireIdentityText(
	value: unknown,
	label: string,
	maximum = MAX_IDENTITY_FIELD_LENGTH,
): string {
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

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return isStrictPlainRecord(value) ? value : undefined;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	if (!isStrictPlainRecord(value)) return false;
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function cloneJson<T>(value: T): T {
	if (!isStructuredJsonValue(value)) throw new Error("Structured value is invalid");
	return freezeStructuredJson(structuredClone(value)) as T;
}

function freezeStructuredJson<T>(value: T): T {
	if (Array.isArray(value)) {
		for (const child of value) freezeStructuredJson(child);
		return Object.freeze(value);
	}
	if (plainRecord(value) !== undefined) {
		for (const child of Object.values(value as Record<string, unknown>)) {
			freezeStructuredJson(child);
		}
		return Object.freeze(value);
	}
	return value;
}

function validMetadata(value: unknown): boolean {
	if (value === undefined) return true;
	const object = plainRecord(value);
	return (
		object !== undefined &&
		(hasExactKeys(object, []) ||
			(hasExactKeys(object, ["turn_id"]) && typeof object.turn_id === "string"))
	);
}

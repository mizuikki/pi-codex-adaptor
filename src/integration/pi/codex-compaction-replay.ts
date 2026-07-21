import { randomUUID } from "node:crypto";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import { type CodexRuntime, remoteCompactionV2Context } from "../../application/codex-runtime.ts";
import {
	CODEX_AUTO_COMPACTION_KIND,
	type CodexAutoCompactionCheckpointV1,
	type CodexCompactionDetailsV2,
	type CodexCompactionIdentity,
	type CodexCompactionStore,
	createCodexAutoCompactionCheckpoint,
	isStructuredJsonValue,
	isSupportedStructuredResponseItem,
	parseCodexAutoCompactionCheckpoint,
	parseCodexCompactionDetails,
	type StructuredResponseItem,
	shouldCreateAutomaticCheckpoint,
	validateCompactionOutput,
} from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	capabilityCacheKey,
	type ResolveEffectiveCapabilities,
} from "../../application/resolve-effective-capabilities.ts";
import { isStrictJsonArray, isStrictPlainRecord } from "../../application/structured-json.ts";
import { responseItemsFromMessages } from "./codex-provider.ts";
import {
	authenticationSummary,
	type CodexProviderRequestGuard,
	type CodexProviderRequestRecord,
	deepFreeze,
	digestJson,
	sessionFingerprint,
} from "./codex-provider-request-guard.ts";
import type { CodexToolProfileCoordinator } from "./codex-tool-profile.ts";

const REPLAY_ERROR = "OpenAI Codex automatic compaction cannot safely replay this request";
type ProviderRequestOrigin = "agent" | "compaction_summary" | "branch_summary";
export interface CodexCompactionReplayOptions {
	readonly pi: ExtensionAPI;
	readonly runtime: CodexRuntime;
	readonly configuration: ConfigurationService;
	readonly activation: ProviderActivationPolicy;
	readonly store: CodexCompactionStore;
	readonly coordinator: import("../../application/compaction.ts").CodexCompactionCoordinator;
	readonly capabilities: ResolveEffectiveCapabilities;
	readonly profile: CodexToolProfileCoordinator;
	readonly guard: CodexProviderRequestGuard;
}

interface BranchCheckpoint {
	readonly source: "automatic" | "manual";
	readonly entry: SessionEntry;
	readonly output: readonly StructuredResponseItem[];
	readonly checkpoint?: CodexAutoCompactionCheckpointV1;
	readonly details?: CodexCompactionDetailsV2;
	readonly coveredEntryId?: string;
	readonly firstKeptEntryId?: string;
}

interface InputSegmentation {
	readonly liveTail: readonly StructuredResponseItem[];
	readonly rewrittenInput: readonly StructuredResponseItem[];
	readonly coveredEntryId: string | undefined;
}

export function registerCodexCompactionReplay(options: CodexCompactionReplayOptions): void {
	options.pi.on("before_provider_request", async (event, ctx) => {
		return handleBeforeProviderRequest(event, ctx, options);
	});
}

export function providerCompactionIdentity(
	record: Pick<CodexProviderRequestRecord, "sessionId" | "model" | "connection">,
): CodexCompactionIdentity | undefined {
	const authenticationBinding = authenticationSummary(
		record.connection.authentication,
		record.connection.accountId,
		record.connection.accountIdSource,
	);
	if (authenticationBinding === undefined) return undefined;
	return {
		sessionFingerprint: sessionFingerprint(record.sessionId),
		providerId: record.connection.providerId,
		api: record.model.api,
		baseUrl: record.connection.baseUrl,
		modelId: record.model.id,
		authenticationBinding,
	};
}

export function providerCompactionIdentityFromValues(options: {
	sessionId: string;
	model: Pick<import("@earendil-works/pi-ai").Model<string>, "id" | "api">;
	connection: import("../../application/codex-runtime.ts").CodexProviderConnection;
}): CodexCompactionIdentity | undefined {
	const authenticationBinding = authenticationSummary(
		options.connection.authentication,
		options.connection.accountId,
		options.connection.accountIdSource,
	);
	if (authenticationBinding === undefined) return undefined;
	return {
		sessionFingerprint: sessionFingerprint(options.sessionId),
		providerId: options.connection.providerId,
		api: options.model.api,
		baseUrl: options.connection.baseUrl,
		modelId: options.model.id,
		authenticationBinding,
	};
}

async function handleBeforeProviderRequest(
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
	options: CodexCompactionReplayOptions,
): Promise<unknown> {
	const record = options.guard.current();
	if (record === undefined) {
		// Pi also emits this hook for its direct native fallback. Only the adaptor
		// dispatcher opens a request record, so leave inactive-provider requests unchanged.
		if (!options.activation.isActive(ctx.model)) return event.payload;
		throw new Error(REPLAY_ERROR);
	}
	const origin = providerRequestOrigin(event, record.sessionId);
	options.guard.assertLive(record);
	options.guard.assertRoute(record, ctx.sessionManager.getSessionId());
	if (
		ctx.model === undefined ||
		ctx.model.id !== record.model.id ||
		ctx.model.provider !== record.model.provider ||
		ctx.model.api !== record.model.api
	) {
		throw new Error(REPLAY_ERROR);
	}
	if (ctx.signal !== record.signal) {
		throw new Error(REPLAY_ERROR);
	}
	if (!options.activation.isActive(record.model)) throw new Error(REPLAY_ERROR);

	const payload = requestRecord(event.payload);
	if (
		payload === undefined ||
		payload.model !== record.model.id ||
		digestJson(payload) !== record.requestDigest
	) {
		throw new Error(REPLAY_ERROR);
	}
	if (origin !== "agent") return options.guard.approve(record, payload);
	if (options.store.isReplayInvalid(record.sessionId)) throw new Error(REPLAY_ERROR);
	const input = responseInput(payload.input);
	const identity = providerCompactionIdentity(record);
	const initialLeafId = ctx.sessionManager.getLeafId();
	const branch = ctx.sessionManager.getBranch();
	const contextEntries = ctx.sessionManager.buildContextEntries();
	const candidateLeafId = ctx.sessionManager.getLeafId();
	if (candidateLeafId !== initialLeafId) throw new Error(REPLAY_ERROR);
	const checkpoint = findLatestCheckpoint(branch, identity);
	if (checkpoint.blocked) throw new Error(REPLAY_ERROR);

	const segmentation = segmentProviderInput({
		contextEntries,
		checkpoint: checkpoint.value,
		input,
	});
	if (segmentation === undefined) throw new Error(REPLAY_ERROR);

	let rewrittenInput = segmentation.rewrittenInput;
	if (
		shouldCreateAutomaticCheckpoint({
			mode: record.config.codex.compaction.mode,
			contextTokens: ctx.getContextUsage?.()?.tokens ?? null,
			threshold: resolveThreshold(record),
			hasUncheckpointedInput:
				candidateLeafId !== null &&
				(checkpoint.value === undefined || checkpoint.value.entry.id !== candidateLeafId),
			busy: options.coordinator.isBusy(record.sessionId),
		})
	) {
		rewrittenInput = await createAutomaticCheckpoint({
			record,
			ctx,
			payload,
			segmentation,
			candidateLeafId,
			options,
		});
	}

	const rewritten = deepFreeze({
		...structuredClone(payload),
		input: structuredClone(rewrittenInput),
	});
	options.guard.approve(record, rewritten);
	return rewritten;
}

function providerRequestOrigin(
	event: BeforeProviderRequestEvent,
	expectedSessionId: string,
): ProviderRequestOrigin {
	const attributed = event as BeforeProviderRequestEvent & {
		readonly origin?: unknown;
		readonly sessionId?: unknown;
	};
	if (attributed.origin === undefined && attributed.sessionId === undefined) return "agent";
	if (
		(attributed.origin === "agent" ||
			attributed.origin === "compaction_summary" ||
			attributed.origin === "branch_summary") &&
		typeof attributed.sessionId === "string" &&
		attributed.sessionId.length > 0 &&
		attributed.sessionId.trim() === attributed.sessionId &&
		attributed.sessionId === expectedSessionId
	) {
		return attributed.origin;
	}
	throw new Error(REPLAY_ERROR);
}

async function createAutomaticCheckpoint(options: {
	record: CodexProviderRequestRecord;
	ctx: ExtensionContext;
	payload: Record<string, unknown>;
	segmentation: InputSegmentation;
	candidateLeafId: string | null;
	options: CodexCompactionReplayOptions;
}): Promise<readonly StructuredResponseItem[]> {
	const { record, ctx, payload, segmentation, candidateLeafId, options: deps } = options;
	deps.guard.assertLive(record);
	if (isAborted(record.signal) || isAborted(ctx.signal)) throw new Error(REPLAY_ERROR);
	const identity = providerCompactionIdentity(record);
	if (identity === undefined) throw new Error(REPLAY_ERROR);
	if (!deps.coordinator.begin(record.sessionId)) throw new Error(REPLAY_ERROR);
	const input = segmentation.rewrittenInput;
	try {
		const remoteV2Context = remoteCompactionV2Context(
			record.capabilities.compaction.implementation,
			record.sessionId,
			"auto",
		);
		const result = await deps.runtime.compact({
			connection: record.connection,
			request: compactRequest(payload, input),
			implementation: record.capabilities.compaction.implementation ?? "compact_endpoint",
			transportMode: record.config.codex.transport.mode,
			providerSupportsWebsockets: record.capabilities.providerSupportsWebsockets,
			...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
			...(record.signal === undefined ? {} : { signal: record.signal }),
		});
		deps.guard.assertLive(record);
		if (isAborted(record.signal) || isAborted(ctx.signal)) {
			throw new Error(REPLAY_ERROR);
		}
		if (result.status !== "completed") throw new Error(REPLAY_ERROR);
		const output = validateCompactionOutput(recordOutput(result.result));
		deps.guard.assertLive(record);
		if (isAborted(record.signal) || isAborted(ctx.signal)) throw new Error(REPLAY_ERROR);
		await assertFreshBeforeAppend(
			record,
			ctx,
			candidateLeafId,
			deps.configuration,
			deps.profile,
			deps.guard,
		);
		if (candidateLeafId === null) throw new Error(REPLAY_ERROR);
		const checkpointId = randomUUID();
		const checkpoint = createCodexAutoCompactionCheckpoint(
			identity,
			checkpointId,
			candidateLeafId,
			output,
		);
		deps.guard.assertLive(record);
		if (isAborted(record.signal) || isAborted(ctx.signal)) throw new Error(REPLAY_ERROR);
		let appendStarted = false;
		try {
			deps.guard.assertLive(record);
			appendStarted = true;
			deps.pi.appendEntry(CODEX_AUTO_COMPACTION_KIND, checkpoint);
		} catch {
			deps.store.markReplayInvalid(record.sessionId);
			throw new Error(REPLAY_ERROR);
		}
		try {
			deps.guard.assertLive(record);
		} catch {
			if (appendStarted) deps.store.markReplayInvalid(record.sessionId);
			throw new Error(REPLAY_ERROR);
		}
		const entry = verifyCheckpointAppend(ctx, candidateLeafId, checkpointId);
		if (entry === undefined) {
			deps.store.markReplayInvalid(record.sessionId);
			throw new Error(REPLAY_ERROR);
		}
		try {
			deps.store.setAutomatic(record.sessionId, checkpoint, entry.id);
		} catch {
			deps.store.markReplayInvalid(record.sessionId);
			throw new Error(REPLAY_ERROR);
		}
		deps.guard.assertLive(record);
		if (isAborted(record.signal) || isAborted(ctx.signal)) {
			throw new Error(REPLAY_ERROR);
		}
		deps.coordinator.end(record.sessionId, "success");
		return [...output, ...segmentation.liveTail.map(cloneStructuredValue)];
	} catch (error) {
		// An append is irreversible through Pi's public API. Any invalidation after
		// it begins must leave this session instance replay-invalid.
		deps.coordinator.end(record.sessionId, "error");
		throw error instanceof Error && error.message === REPLAY_ERROR
			? error
			: new Error(REPLAY_ERROR);
	}
}

async function assertFreshBeforeAppend(
	record: CodexProviderRequestRecord,
	ctx: ExtensionContext,
	candidateLeafId: string | null,
	configuration: ConfigurationService,
	profile: CodexToolProfileCoordinator,
	guard: CodexProviderRequestGuard,
): Promise<void> {
	guard.assertLive(record);
	if (
		isAborted(record.signal) ||
		isAborted(ctx.signal) ||
		ctx.sessionManager.getSessionId() !== record.sessionId ||
		ctx.sessionManager.getLeafId() !== candidateLeafId
	) {
		throw new Error(REPLAY_ERROR);
	}
	if (
		ctx.model === undefined ||
		ctx.model.id !== record.model.id ||
		ctx.model.provider !== record.model.provider ||
		ctx.model.api !== record.model.api
	) {
		throw new Error(REPLAY_ERROR);
	}
	const latestConfig = await configuration.load();
	guard.assertLive(record);
	if (isAborted(record.signal) || isAborted(ctx.signal)) throw new Error(REPLAY_ERROR);
	if (digestJson(latestConfig) !== digestJson(record.config)) throw new Error(REPLAY_ERROR);
	const key = capabilityCacheKey({
		modelId: record.model.id,
		providerId: record.model.provider,
		config: record.config,
		contextWindow: record.model.contextWindow,
	});
	if (!profile.isHealthy(key)) throw new Error(REPLAY_ERROR);
}

function verifyCheckpointAppend(
	ctx: ExtensionContext,
	parentId: string,
	checkpointId: string,
): Extract<SessionEntry, { type: "custom" }> | undefined {
	const leafId = ctx.sessionManager.getLeafId();
	if (leafId === null) return undefined;
	const leaf = ctx.sessionManager.getLeafEntry();
	if (
		leaf?.type !== "custom" ||
		leaf.id !== leafId ||
		leaf.parentId !== parentId ||
		leaf.customType !== CODEX_AUTO_COMPACTION_KIND
	) {
		return undefined;
	}
	const checkpoint = parseCodexAutoCompactionCheckpoint(leaf.data);
	return checkpoint?.checkpointId === checkpointId ? leaf : undefined;
}

function findLatestCheckpoint(
	branch: readonly SessionEntry[],
	identity: CodexCompactionIdentity | undefined,
): { readonly value?: BranchCheckpoint; readonly blocked: boolean } {
	const ids = new Set<string>();
	let latest: BranchCheckpoint | undefined;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "custom" && entry.customType === CODEX_AUTO_COMPACTION_KIND) {
			const checkpoint = parseCodexAutoCompactionCheckpoint(entry.data);
			if (checkpoint === undefined || ids.has(checkpoint.checkpointId)) {
				return { blocked: true };
			}
			ids.add(checkpoint.checkpointId);
			if (latest === undefined) {
				if (identity === undefined || !sameIdentity(checkpoint, identity)) return { blocked: true };
				latest = {
					source: "automatic",
					entry,
					checkpoint,
					output: checkpoint.output,
					coveredEntryId: checkpoint.coveredEntryId,
				};
			}
			continue;
		}
		if (entry.type !== "compaction") continue;
		const details = parseCodexCompactionDetails(entry.details);
		if (details === undefined || details.version !== 2) return { blocked: true };
		if (latest === undefined) {
			if (identity === undefined || !sameIdentity(details, identity)) return { blocked: true };
			latest = {
				source: "manual",
				entry,
				details,
				output: details.output,
				firstKeptEntryId: entry.firstKeptEntryId,
			};
		}
	}
	return latest === undefined ? { blocked: false } : { blocked: false, value: latest };
}

function segmentProviderInput(options: {
	readonly contextEntries: readonly SessionEntry[];
	readonly checkpoint: BranchCheckpoint | undefined;
	readonly input: readonly StructuredResponseItem[];
}): InputSegmentation | undefined {
	const { contextEntries, checkpoint, input } = options;
	const candidates: Array<{
		readonly prefix: readonly unknown[];
		readonly coveredEntryId?: string;
		readonly output: readonly StructuredResponseItem[];
		readonly retainedTail?: readonly StructuredResponseItem[];
	}> = [];
	if (checkpoint === undefined) {
		candidates.push({ prefix: projectEntries(contextEntries), output: [] });
	} else if (checkpoint.source === "automatic" && checkpoint.checkpoint !== undefined) {
		const coveredEntryId = checkpoint.checkpoint.coveredEntryId;
		const coveredIndex = contextEntries.findIndex((entry) => entry.id === coveredEntryId);
		if (coveredIndex < 0) return undefined;
		const after = projectEntries(contextEntries.slice(coveredIndex + 1));
		candidates.push({
			prefix: projectEntries(contextEntries.slice(0, coveredIndex + 1)),
			coveredEntryId,
			output: checkpoint.output,
		});
		candidates.push({
			prefix: [...checkpoint.output, ...after],
			coveredEntryId,
			output: checkpoint.output,
			retainedTail: after,
		});
	} else {
		const index = contextEntries.findIndex((entry) => entry.id === checkpoint.entry.id);
		if (index < 0) return undefined;
		const after = projectEntries(contextEntries.slice(index + 1));
		candidates.push({
			prefix: [...checkpoint.output, ...after],
			coveredEntryId: checkpoint.entry.id,
			output: checkpoint.output,
			retainedTail: after,
		});
	}
	const matches = candidates
		.filter((candidate) => hasPrefix(input, candidate.prefix))
		.filter(
			(candidate, index, all) =>
				all.findIndex(
					(other) =>
						structuralEqual(candidate.prefix, other.prefix) &&
						structuralEqual(candidate.output, other.output) &&
						candidate.coveredEntryId === other.coveredEntryId,
				) === index,
		);
	if (matches.length !== 1) return undefined;
	const match = matches[0];
	if (match === undefined) return undefined;
	const liveTail = [
		...(match.retainedTail ?? []).map(cloneStructuredValue),
		...input.slice(match.prefix.length).map(cloneStructuredValue),
	];
	const rewrittenInput =
		match.output.length === 0
			? input.map(cloneStructuredValue)
			: [...match.output.map(cloneStructuredValue), ...liveTail];
	return {
		liveTail,
		rewrittenInput,
		coveredEntryId: match.coveredEntryId,
	};
}

function projectEntries(entries: readonly SessionEntry[]): readonly StructuredResponseItem[] {
	const items: StructuredResponseItem[] = [];
	for (const entry of entries) {
		if (entry.type === "custom") continue;
		if (entry.type === "compaction") {
			const details = parseCodexCompactionDetails(entry.details);
			if (details?.version === 2) items.push(...details.output.map(cloneStructuredValue));
			continue;
		}
		const projected = responseItemsFromMessages(sessionEntryToContextMessages(entry));
		for (const item of projected) {
			if (!isStructuredJsonValue(item) || !isSupportedStructuredResponseItem(item)) {
				throw new Error(REPLAY_ERROR);
			}
			items.push(item);
		}
	}
	return items;
}

function hasPrefix(input: readonly unknown[], prefix: readonly unknown[]): boolean {
	if (prefix.length > input.length) return false;
	for (let index = 0; index < prefix.length; index += 1) {
		if (!structuralEqual(input[index], prefix[index])) return false;
	}
	return true;
}

function sameIdentity(
	value: Pick<
		CodexCompactionIdentity,
		"sessionFingerprint" | "providerId" | "api" | "baseUrl" | "modelId" | "authenticationBinding"
	>,
	identity: CodexCompactionIdentity,
): boolean {
	return (
		value.sessionFingerprint === identity.sessionFingerprint &&
		value.providerId === identity.providerId &&
		value.api === identity.api &&
		value.baseUrl === identity.baseUrl &&
		value.modelId === identity.modelId &&
		structuralEqual(value.authenticationBinding, identity.authenticationBinding)
	);
}

function resolveThreshold(record: CodexProviderRequestRecord): number | undefined {
	return record.capabilities.compaction.threshold ?? undefined;
}

function compactRequest(
	payload: Record<string, unknown>,
	input: readonly StructuredResponseItem[],
): Record<string, unknown> {
	const request: Record<string, unknown> = {
		model: payload.model,
		input,
		instructions: payload.instructions,
		tools: payload.tools,
		parallel_tool_calls: payload.parallel_tool_calls,
		reasoning: payload.reasoning,
		service_tier: payload.service_tier,
		prompt_cache_key: payload.prompt_cache_key,
		text: payload.text,
	};
	return request;
}

function requestRecord(value: unknown): Record<string, unknown> | undefined {
	return isStrictPlainRecord(value) ? value : undefined;
}

function responseInput(value: unknown): readonly StructuredResponseItem[] {
	if (!isStrictJsonArray(value)) throw new Error(REPLAY_ERROR);
	for (const item of value) {
		if (!isStructuredJsonValue(item) || !isSupportedStructuredResponseItem(item)) {
			throw new Error(REPLAY_ERROR);
		}
	}
	return value as readonly StructuredResponseItem[];
}

function recordOutput(value: unknown): unknown {
	const result = requestRecord(value);
	return result?.output;
}

function cloneStructuredValue<T>(value: T): T {
	return structuredClone(value);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function structuralEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!isStrictJsonArray(left) || !isStrictJsonArray(right) || left.length !== right.length) {
			return false;
		}
		return left.every((value, index) => structuralEqual(value, right[index]));
	}
	const leftRecord = requestRecord(left);
	const rightRecord = requestRecord(right);
	if (leftRecord === undefined || rightRecord === undefined) return false;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return (
		structuralEqual(leftKeys, rightKeys) &&
		leftKeys.every((key) => structuralEqual(leftRecord[key], rightRecord[key]))
	);
}

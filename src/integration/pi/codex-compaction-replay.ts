import { randomUUID } from "node:crypto";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import {
	type CodexProviderConnection,
	type CodexRuntime,
	remoteCompactionV2Context,
} from "../../application/codex-runtime.ts";
import {
	CODEX_REMOTE_COMPACTION_KIND,
	type CodexCompactionCoordinator,
	type CodexCompactionIdentity,
	type CodexCompactionStore,
	type CodexRemoteCompactionCheckpointV1,
	createRemoteCompactionCheckpoint,
	isSupportedStructuredResponseItem,
	parseRemoteCompactionCheckpoint,
	type StructuredResponseItem,
	shouldCreateAutomaticCheckpoint,
	validateCompactionOutput,
} from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	capabilityCacheKey,
	type EffectiveCapabilitySnapshot,
	type ResolveEffectiveCapabilities,
	withSupplementalSessionInstructions,
} from "../../application/resolve-effective-capabilities.ts";
import {
	isStrictJsonArray,
	isStrictJsonValue,
	isStrictPlainRecord,
} from "../../application/structured-json.ts";
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
import {
	type BeforeProviderPayloadEvent,
	type BeforeProviderPayloadEventResult,
	fullActivePathSnapshot,
	onBeforeProviderPayload,
	type ProviderCheckpointProposal,
	type ProviderPayloadAttribution,
} from "./provider-payload-compaction-api.ts";

const REPLAY_ERROR = "OpenAI Codex request could not be safely reconstructed";
const IDENTITY_MISMATCH_WARNING =
	"Codex checkpoint identity changed; canonical session history is being used. Start a new session if it does not fit.";

export interface CodexCompactionReplayOptions {
	readonly pi: ExtensionAPI;
	readonly runtime: CodexRuntime;
	readonly configuration: ConfigurationService;
	readonly activation: ProviderActivationPolicy;
	readonly store: CodexCompactionStore;
	readonly coordinator: CodexCompactionCoordinator;
	readonly capabilities: ResolveEffectiveCapabilities;
	readonly profile: CodexToolProfileCoordinator;
	readonly guard: CodexProviderRequestGuard;
}

export interface CheckpointSelection {
	readonly entry: Extract<SessionEntry, { type: "custom" }>;
	readonly checkpoint: CodexRemoteCompactionCheckpointV1;
	readonly coveredIndex: number;
	readonly entryIndex: number;
}

export interface CheckpointScan {
	readonly matching?: CheckpointSelection;
	readonly hasIdentityMismatch: boolean;
}

export interface RemoteCheckpointRequestOptions {
	readonly runtime: CodexRuntime;
	readonly connection: CodexProviderConnection;
	readonly model: Model<string>;
	readonly config: Awaited<ReturnType<ConfigurationService["load"]>>;
	readonly capabilities: EffectiveCapabilitySnapshot;
	readonly input: readonly StructuredResponseItem[];
	readonly payload?: Record<string, unknown>;
	readonly sessionId: string;
	readonly coveredEntryId: string;
	readonly token: unknown;
	readonly trigger: "auto" | "manual";
	readonly signal: AbortSignal;
}

export function registerCodexCompactionReplay(options: CodexCompactionReplayOptions): void {
	onBeforeProviderPayload(options.pi, async (event, ctx) => {
		return handleBeforeProviderPayload(event, ctx, options);
	});
}

export function providerCompactionIdentity(
	record: Pick<CodexProviderRequestRecord, "sessionId" | "model" | "connection">,
): CodexCompactionIdentity | undefined {
	return providerCompactionIdentityFromValues({
		sessionId: record.sessionId,
		model: record.model,
		connection: record.connection,
	});
}

export function providerCompactionIdentityFromValues(options: {
	readonly sessionId: string;
	readonly model: Pick<Model<string>, "id" | "api">;
	readonly connection: CodexProviderConnection;
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

export async function restoreProviderCheckpointUsageBoundary(options: {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly activation: ProviderActivationPolicy;
	readonly store: CodexCompactionStore;
	readonly connection?: CodexProviderConnection;
}): Promise<void> {
	const setter = options.pi.setProviderCheckpointUsageBoundary;
	if (setter === undefined) return;
	const sessionId = options.ctx.sessionManager.getSessionId();
	const branch = activeBranch(options.ctx);
	const hasCheckpoint = hasValidRemoteCheckpoint(branch);
	const model = options.ctx.model;
	if (
		model === undefined ||
		!options.activation.isActive(model) ||
		options.connection === undefined
	) {
		setter();
		warnInactiveIdentity(options.ctx, options.store, sessionId, hasCheckpoint);
		return;
	}
	const identity = providerCompactionIdentityFromValues({
		sessionId,
		model,
		connection: options.connection,
	});
	if (identity === undefined) {
		setter();
		warnInactiveIdentity(options.ctx, options.store, sessionId, hasCheckpoint);
		return;
	}
	const scan = scanRemoteCompactionCheckpoints(branch, identity);
	if (scan.hasIdentityMismatch && options.store.warnOnce(sessionId, identity)) {
		options.ctx.ui.notify(IDENTITY_MISMATCH_WARNING, "warning");
	}
	setter(scan.matching?.entry.id);
}

export async function createRemoteCheckpointProposal(
	options: RemoteCheckpointRequestOptions,
): Promise<{
	readonly checkpoint: CodexRemoteCompactionCheckpointV1;
	readonly proposal: ProviderCheckpointProposal;
	readonly rewrittenInput: readonly StructuredResponseItem[];
}> {
	const implementation = options.capabilities.compaction.implementation;
	if (implementation === null) throw new Error("OpenAI Codex Remote Compaction is unavailable");
	if (options.signal.aborted) throw new Error("Compaction cancelled");
	const request = buildCompactRequest(options);
	const remoteCompactionContext = remoteCompactionV2Context(
		implementation,
		options.sessionId,
		options.trigger,
	);
	const result = await options.runtime.compact({
		connection: options.connection,
		request,
		implementation,
		transportMode: options.config.codex.transport.mode,
		providerSupportsWebsockets: options.capabilities.providerSupportsWebsockets,
		...(remoteCompactionContext === undefined
			? {}
			: { remoteCompactionV2Context: remoteCompactionContext }),
		signal: options.signal,
	});
	if (result.status === "aborted" || options.signal.aborted)
		throw new Error("Compaction cancelled");
	if (result.status !== "completed") {
		throw new Error(`OpenAI Codex Remote Compaction ended with status ${result.status}`);
	}
	const output = validateCompactionOutput(result.result.output);
	const checkpointId = randomUUID();
	const checkpoint = createRemoteCompactionCheckpoint(
		providerCompactionIdentityFromValues({
			sessionId: options.sessionId,
			model: options.model,
			connection: options.connection,
		}) ??
			(() => {
				throw new Error("OpenAI Codex compaction credentials are unsupported");
			})(),
		checkpointId,
		options.coveredEntryId,
		implementation,
		output,
		estimateTokens(options.input),
		result.result.usage,
	);
	const rewrittenInput = output;
	return {
		checkpoint,
		rewrittenInput,
		proposal: {
			token: options.token as ProviderCheckpointProposal["token"],
			customType: CODEX_REMOTE_COMPACTION_KIND,
			checkpointId,
			data: checkpoint,
			...(result.result.usage === undefined
				? {}
				: { usage: providerCheckpointUsage(result.result.usage) }),
		},
	};
}

function providerCheckpointUsage(usage: {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly reasoningTokens?: number;
}): Usage {
	return {
		input: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
		output: usage.outputTokens,
		cacheRead: usage.cachedInputTokens,
		cacheWrite: 0,
		totalTokens: usage.inputTokens + usage.outputTokens,
		...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function handleBeforeProviderPayload(
	event: BeforeProviderPayloadEvent,
	ctx: ExtensionContext,
	options: CodexCompactionReplayOptions,
): Promise<BeforeProviderPayloadEventResult> {
	const record = options.guard.current();
	if (record === undefined) {
		if (!options.activation.isActive(ctx.model)) return { payload: event.payload };
		throw new Error(REPLAY_ERROR);
	}
	options.guard.assertLive(record);
	options.guard.assertRoute(record, ctx.sessionManager.getSessionId());
	if (
		ctx.model === undefined ||
		ctx.model.id !== record.model.id ||
		ctx.model.provider !== record.model.provider ||
		ctx.model.api !== record.model.api ||
		event.attribution.sessionId !== record.sessionId ||
		event.attribution.signal !== record.signal
	) {
		throw new Error(REPLAY_ERROR);
	}
	if (!options.activation.isActive(record.model)) throw new Error(REPLAY_ERROR);
	refreshBoundaryForRequest(options.pi, ctx, options.store, record);
	const payload = requestRecord(event.payload);
	if (
		payload === undefined ||
		payload.model !== record.model.id ||
		digestJson(payload) !== record.requestDigest
	) {
		throw new Error(REPLAY_ERROR);
	}
	const attribution = event.attribution as unknown as ProviderPayloadAttribution;
	if (attribution.origin !== "agent") return { payload: options.guard.approve(record, payload) };
	const token = attribution.compaction?.token;
	if (token === undefined) return { payload: options.guard.approve(record, payload) };
	const input = responseInput(payload.input);
	const identity = providerCompactionIdentity(record);
	if (identity === undefined) throw new Error(REPLAY_ERROR);
	const branch = activeBranch(ctx);
	const scan = scanRemoteCompactionCheckpoints(branch, identity);
	if (scan.hasIdentityMismatch && options.store.warnOnce(record.sessionId, identity)) {
		ctx.ui.notify(IDENTITY_MISMATCH_WARNING, "warning");
	}
	const current = scan.matching;
	const replayInput = current === undefined ? input : checkpointPayload(current, branch);
	const config = await options.configuration.load();
	const capabilityKey = capabilityCacheKey({
		modelId: record.model.id,
		providerId: record.model.provider,
		config,
		contextWindow: record.model.contextWindow,
	});
	if (!options.profile.isHealthy(capabilityKey)) throw new Error(REPLAY_ERROR);
	const snapshot = await options.capabilities.resolve({
		modelId: record.model.id,
		providerId: record.model.provider,
		config,
		contextWindow: record.model.contextWindow,
	});
	const effectiveTokens = ctx.getContextUsage()?.tokens ?? estimateTokens(replayInput);
	const hasUncheckpointedInput =
		current === undefined
			? input.length > 0
			: checkpointSuffix(branch, current.coveredIndex).length > 0;
	const shouldCompact = shouldCreateAutomaticCheckpoint({
		mode: config.codex.compaction.mode,
		contextTokens: effectiveTokens,
		threshold: snapshot.compaction.threshold ?? undefined,
		hasUncheckpointedInput,
		busy: options.coordinator.isBusy(record.sessionId),
	});
	if (!shouldCompact)
		return { payload: options.guard.approve(record, rewritePayload(payload, replayInput)) };
	if (!options.coordinator.begin(record.sessionId)) throw new Error(REPLAY_ERROR);
	try {
		const coveredEntryId = ctx.sessionManager.getLeafId();
		if (coveredEntryId === null) throw new Error(REPLAY_ERROR);
		const compacted = await createRemoteCheckpointProposal({
			runtime: options.runtime,
			connection: record.connection,
			model: record.model as Model<string>,
			config,
			capabilities: snapshot,
			input: replayInput,
			payload,
			sessionId: record.sessionId,
			coveredEntryId,
			token,
			trigger: "auto",
			signal: record.signal,
		});
		options.guard.assertLive(record);
		if (ctx.sessionManager.getLeafId() !== coveredEntryId || record.signal.aborted)
			throw new Error(REPLAY_ERROR);
		const approvedPayload = rewritePayload(payload, compacted.rewrittenInput);
		return {
			payload: deepFreeze(approvedPayload),
			providerCheckpoint: compacted.proposal,
		};
	} finally {
		options.coordinator.end(record.sessionId, "success");
	}
}

function buildCompactRequest(options: RemoteCheckpointRequestOptions): Record<string, unknown> {
	const payload = options.payload;
	return {
		model: options.model.id,
		input: structuredClone(options.input),
		instructions:
			typeof payload?.instructions === "string"
				? payload.instructions
				: withSupplementalSessionInstructions("", options.capabilities),
		tools: payload?.tools ?? null,
		parallel_tool_calls: payload?.parallel_tool_calls ?? true,
		reasoning: payload?.reasoning ?? null,
		service_tier: payload?.service_tier ?? options.config.codex.serviceTier,
		prompt_cache_key: options.sessionId,
		text: payload?.text ?? { verbosity: options.config.codex.verbosity },
	};
}

function activeBranch(ctx: ExtensionContext): readonly SessionEntry[] {
	return fullActivePathSnapshot(ctx.sessionManager) ?? ctx.sessionManager.getBranch();
}

function hasValidRemoteCheckpoint(branch: readonly SessionEntry[]): boolean {
	return branch.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === CODEX_REMOTE_COMPACTION_KIND &&
			parseRemoteCompactionCheckpoint(entry.data) !== undefined,
	);
}

function warnInactiveIdentity(
	ctx: ExtensionContext,
	store: CodexCompactionStore,
	sessionId: string,
	hasCheckpoint: boolean,
): void {
	if (hasCheckpoint && store.warnSessionOnce(sessionId)) {
		ctx.ui.notify(IDENTITY_MISMATCH_WARNING, "warning");
	}
}

function refreshBoundaryForRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	store: CodexCompactionStore,
	record: CodexProviderRequestRecord,
): void {
	const setter = pi.setProviderCheckpointUsageBoundary;
	if (setter === undefined) return;
	const branch = activeBranch(ctx);
	const identity = providerCompactionIdentity(record);
	if (identity === undefined) {
		setter();
		warnInactiveIdentity(ctx, store, record.sessionId, hasValidRemoteCheckpoint(branch));
		return;
	}
	const scan = scanRemoteCompactionCheckpoints(branch, identity);
	if (scan.hasIdentityMismatch && store.warnOnce(record.sessionId, identity)) {
		ctx.ui.notify(IDENTITY_MISMATCH_WARNING, "warning");
	}
	setter(scan.matching?.entry.id);
}

export function scanRemoteCompactionCheckpoints(
	branch: readonly SessionEntry[],
	identity: CodexCompactionIdentity,
): CheckpointScan {
	let hasIdentityMismatch = false;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== CODEX_REMOTE_COMPACTION_KIND) continue;
		const checkpoint = parseRemoteCompactionCheckpoint(entry.data);
		if (checkpoint === undefined) continue;
		if (!sameIdentity(checkpoint, identity)) {
			hasIdentityMismatch = true;
			continue;
		}
		const coveredIndex = branch.findIndex(
			(candidate) => candidate.id === checkpoint.coveredEntryId,
		);
		if (coveredIndex < 0 || coveredIndex >= index) continue;
		return {
			matching: { entry, checkpoint, coveredIndex, entryIndex: index },
			hasIdentityMismatch,
		};
	}
	return { hasIdentityMismatch };
}

export function checkpointPayload(
	selection: CheckpointSelection,
	branch: readonly SessionEntry[],
): readonly StructuredResponseItem[] {
	return [...selection.checkpoint.output, ...checkpointSuffix(branch, selection.coveredIndex)].map(
		(item) => structuredClone(item),
	);
}

function checkpointSuffix(
	branch: readonly SessionEntry[],
	coveredIndex: number,
): readonly StructuredResponseItem[] {
	return projectCanonicalEntries(branch.slice(coveredIndex + 1));
}

export function projectCanonicalEntries(
	entries: readonly SessionEntry[],
): readonly StructuredResponseItem[] {
	const messages = entries.flatMap((entry) =>
		entry.type === "custom" ? [] : sessionEntryToContextMessages(entry),
	);
	const items = responseItemsFromMessages(convertToLlm(messages));
	if (
		!items.every(
			(item): item is StructuredResponseItem =>
				isStrictJsonValue(item) && isSupportedStructuredResponseItem(item),
		)
	) {
		throw new Error(REPLAY_ERROR);
	}
	return items.map((item) => structuredClone(item));
}

function responseInput(value: unknown): readonly StructuredResponseItem[] {
	if (!isStrictJsonArray(value)) throw new Error(REPLAY_ERROR);
	const items = validateCompactionInput(value);
	return items;
}

function validateCompactionInput(value: readonly unknown[]): readonly StructuredResponseItem[] {
	const items: StructuredResponseItem[] = [];
	for (const item of value) {
		if (!isStrictJsonValue(item) || !isSupportedStructuredResponseItem(item))
			throw new Error(REPLAY_ERROR);
		items.push(structuredClone(item));
	}
	return items;
}

function rewritePayload(
	payload: Record<string, unknown>,
	input: readonly StructuredResponseItem[],
): Record<string, unknown> {
	return deepFreeze({ ...structuredClone(payload), input: structuredClone(input) });
}

function requestRecord(value: unknown): Record<string, unknown> | undefined {
	return isStrictPlainRecord(value) ? value : undefined;
}

function sameIdentity(left: CodexCompactionIdentity, right: CodexCompactionIdentity): boolean {
	return (
		left.sessionFingerprint === right.sessionFingerprint &&
		left.providerId === right.providerId &&
		left.api === right.api &&
		left.baseUrl === right.baseUrl &&
		left.modelId === right.modelId &&
		left.authenticationBinding.kind === right.authenticationBinding.kind &&
		left.authenticationBinding.fingerprint === right.authenticationBinding.fingerprint
	);
}

function estimateTokens(input: readonly StructuredResponseItem[]): number {
	return Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
}

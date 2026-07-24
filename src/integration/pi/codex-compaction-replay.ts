import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type {
	BeforeProviderPayloadEvent,
	BeforeProviderPayloadEventResult,
	ExtensionAPI,
	ExtensionContext,
	ProviderCompactionProposal,
	ProviderPayloadAttribution,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import { type CodexRuntime, remoteCompactionV2Context } from "../../application/codex-runtime.ts";
import {
	CODEX_AUTO_COMPACTION_KIND,
	type CodexAutoCompactionCheckpointV1,
	type CodexCompactionIdentity,
	type CodexCompactionStore,
	type CodexLegacyCompactionDetailsV2,
	type CodexPortableCompactionDetailsV3,
	classifyPersistedCompaction,
	createPortableCompactionDetails,
	isStructuredJsonValue,
	isSupportedStructuredResponseItem,
	type PersistedCompactionEntryView,
	parseCodexCompactionDetails,
	type StructuredResponseItem,
	sameCompactionIdentity,
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
	sha256Hex,
} from "./codex-provider-request-guard.ts";
import type { CodexToolProfileCoordinator } from "./codex-tool-profile.ts";

const REPLAY_ERROR = "OpenAI Codex automatic compaction cannot safely replay this request";
type ProviderPayloadResult = {
	readonly payload: Record<string, unknown>;
	readonly compaction?: ProviderCompactionProposal;
};
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
	readonly output?: readonly StructuredResponseItem[];
	readonly checkpoint?: CodexAutoCompactionCheckpointV1;
	readonly details?: CodexPortableCompactionDetailsV3 | CodexLegacyCompactionDetailsV2;
	readonly coveredEntryId?: string;
	readonly retainedTail?: readonly StructuredResponseItem[];
}

interface LegacyMigrationCheckpoint {
	readonly source: "automatic" | "manual";
}

interface InputSegmentation {
	readonly compactPrefix: readonly StructuredResponseItem[];
	readonly retainedTail: readonly StructuredResponseItem[];
	readonly liveSuffix: readonly StructuredResponseItem[];
}

export function registerCodexCompactionReplay(options: CodexCompactionReplayOptions): void {
	options.pi.on("before_provider_payload", async (event, ctx) => {
		return handleBeforeProviderPayload(event, ctx, options);
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

async function handleBeforeProviderPayload(
	event: BeforeProviderPayloadEvent,
	ctx: ExtensionContext,
	options: CodexCompactionReplayOptions,
): Promise<BeforeProviderPayloadEventResult> {
	const record = options.guard.current();
	if (record === undefined) {
		// Pi also emits this hook for its direct native fallback. Only the adaptor
		// dispatcher opens a request record, so leave inactive-provider requests unchanged.
		if (!options.activation.isActive(ctx.model)) return { payload: event.payload };
		throw new Error(REPLAY_ERROR);
	}
	const attribution = providerPayloadAttribution(event.attribution, record.sessionId);
	const origin = attribution.origin;
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
	if (ctx.signal !== record.signal || attribution.signal !== record.signal) {
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
	if (origin !== "agent") {
		return { payload: options.guard.approve(record, payload) };
	}
	if (options.store.isReplayInvalid(record.sessionId)) throw new Error(REPLAY_ERROR);
	const input = responseInput(payload.input);
	const identity = providerCompactionIdentity(record);
	const initialLeafId = ctx.sessionManager.getLeafId();
	// Migration and checkpoint classification stay on Pi's session manager surface.
	// The adaptor never reaches into storage backends or infers paths from custom entry state.
	const branch = ctx.sessionManager.getBranch();
	const contextEntries = ctx.sessionManager.buildContextEntries();
	const candidateLeafId = ctx.sessionManager.getLeafId();
	if (candidateLeafId !== initialLeafId) throw new Error(REPLAY_ERROR);
	const migration = findLegacyMigrationCheckpoint(branch, identity);
	const checkpoint = findLatestCheckpoint(branch, identity);
	if (checkpoint.blocked && migration === undefined) throw new Error(REPLAY_ERROR);

	const candidate = attribution.compaction;
	if (candidate === undefined) {
		if (migration !== undefined) throw new Error(REPLAY_ERROR);
		return { payload: options.guard.approve(record, payload) };
	}
	const candidateRetainedTail = projectCandidateRetainedTail(candidate.candidateRetainedTail);
	let segmentation = segmentProviderInput({
		contextEntries,
		checkpoint: checkpoint.value,
		input,
		candidateRetainedTail,
	});
	if (migration !== undefined) {
		const currentRequestSegmentation = segmentCurrentRequestInput(
			contextEntries,
			input,
			candidateRetainedTail,
		);
		if (currentRequestSegmentation === undefined) throw new Error(REPLAY_ERROR);
		const canonical = projectMigrationCanonicalEntries(fullActivePath(ctx.sessionManager));
		if (!hasSuffix(canonical, candidateRetainedTail)) throw new Error(REPLAY_ERROR);
		segmentation = {
			compactPrefix: canonical
				.slice(0, canonical.length - candidateRetainedTail.length)
				.map(cloneStructuredValue),
			retainedTail: candidateRetainedTail,
			liveSuffix: currentRequestSegmentation.liveSuffix,
		};
	}
	if (segmentation === undefined) throw new Error(REPLAY_ERROR);

	let rewrittenPayload = payload;
	let proposal: ProviderCompactionProposal | undefined;
	if (
		migration !== undefined ||
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
		const result = await createInlineCompactionProposal({
			record,
			ctx,
			payload,
			segmentation,
			attribution,
			options,
		});
		rewrittenPayload = result.payload;
		proposal = result.compaction;
	} else if (migration === undefined && checkpoint.value?.output !== undefined) {
		rewrittenPayload = deepFreeze({
			...structuredClone(payload),
			input: structuredClone([
				...checkpoint.value.output.map(cloneStructuredValue),
				...segmentation.retainedTail.map(cloneStructuredValue),
				...segmentation.liveSuffix.map(cloneStructuredValue),
			]),
		});
	}

	return {
		payload: options.guard.approve(record, rewrittenPayload),
		...(proposal === undefined ? {} : { compaction: proposal }),
	};
}

function providerPayloadAttribution(
	attribution: ProviderPayloadAttribution,
	expectedSessionId: string,
): ProviderPayloadAttribution {
	if (
		(attribution.origin === "agent" ||
			attribution.origin === "compaction_summary" ||
			attribution.origin === "branch_summary") &&
		typeof attribution.sessionId === "string" &&
		attribution.sessionId.length > 0 &&
		attribution.sessionId.trim() === attribution.sessionId &&
		attribution.sessionId === expectedSessionId &&
		attribution.signal instanceof AbortSignal
	) {
		return attribution;
	}
	throw new Error(REPLAY_ERROR);
}

async function createInlineCompactionProposal(options: {
	record: CodexProviderRequestRecord;
	ctx: ExtensionContext;
	payload: Record<string, unknown>;
	segmentation: InputSegmentation;
	attribution: ProviderPayloadAttribution;
	options: CodexCompactionReplayOptions;
}): Promise<ProviderPayloadResult> {
	const { record, ctx, payload, segmentation, attribution, options: deps } = options;
	const compaction = attribution.compaction;
	if (compaction === undefined) throw new Error(REPLAY_ERROR);
	deps.guard.assertLive(record);
	if (isAborted(record.signal) || isAborted(ctx.signal)) throw new Error(REPLAY_ERROR);
	const compactInput = segmentation.compactPrefix;
	if (compactInput.length === 0) {
		return { payload };
	}
	if (!deps.coordinator.begin(record.sessionId)) throw new Error(REPLAY_ERROR);
	try {
		const sharedAbort = new AbortController();
		const releaseAbort = linkAbortSignal(record.signal, sharedAbort);
		try {
			const remoteV2Context = remoteCompactionV2Context(
				compactInput.at(0)?.type === "compaction"
					? record.capabilities.compaction.implementation
					: null,
				compactInput.at(0)?.type === "compaction" ? record.sessionId : undefined,
				"auto",
			);
			const summaryPromise = deps.runtime.summarizeContext({
				connection: record.connection,
				modelId: record.model.id,
				input: compactInput,
				transportMode: record.config.codex.transport.mode,
				providerSupportsWebsockets: record.capabilities.providerSupportsWebsockets,
				...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
				signal: sharedAbort.signal,
			});
			const compactPromise = deps.runtime
				.compact({
					connection: record.connection,
					request: compactRequest(payload, compactInput),
					implementation: record.capabilities.compaction.implementation ?? "compact_endpoint",
					transportMode: record.config.codex.transport.mode,
					providerSupportsWebsockets: record.capabilities.providerSupportsWebsockets,
					...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
					signal: sharedAbort.signal,
				})
				.catch(() => undefined);
			let summaryResult: Awaited<ReturnType<CodexRuntime["summarizeContext"]>>;
			try {
				summaryResult = await summaryPromise;
			} catch {
				sharedAbort.abort();
				throw new Error(REPLAY_ERROR);
			}
			if (
				summaryResult.status !== "completed" ||
				isAborted(record.signal) ||
				isAborted(ctx.signal)
			) {
				sharedAbort.abort();
				throw new Error(REPLAY_ERROR);
			}
			const tokensBefore = normalizeTokensBefore(ctx.getContextUsage?.()?.tokens);
			const summary = normalizeSummary(summaryResult.result.summary);
			let usage = usageFromNormalized(summaryResult.result.usage);
			let summaryPrefix = portableSummaryItems(summary, tokensBefore);
			let details = createPortableCompactionDetails(sha256Hex(summary));
			const compactResult = await compactPromise;
			if (compactResult?.status === "completed") {
				try {
					const output = validateCompactionOutput(recordOutput(compactResult.result));
					const identity = providerCompactionIdentity(record);
					if (identity !== undefined) {
						details = createPortableCompactionDetails(sha256Hex(summary), {
							identity,
							output,
						});
						summaryPrefix = output;
					}
					usage = combineUsage(usage, usageFromNormalized(compactResult.result.usage));
				} catch {
					// Portable summary remains the correctness path.
				}
			}
			if (usage !== undefined) calculateCost(record.model as Model<string>, usage);
			await assertFreshBeforeProposal(
				record,
				ctx,
				compaction.candidateLeafId,
				deps.configuration,
				deps.profile,
			);
			const rewrittenInput = [
				...summaryPrefix.map(cloneStructuredValue),
				...segmentation.retainedTail.map(cloneStructuredValue),
				...segmentation.liveSuffix.map(cloneStructuredValue),
			];
			const rewrittenPayload = deepFreeze({
				...structuredClone(payload),
				input: structuredClone(rewrittenInput),
			});
			deps.store.setPendingCommit(record.sessionId, {
				parentId: compaction.candidateLeafId,
				summary,
				summarySha256: details.portable.summarySha256,
				usage,
				retainedTail: compaction.candidateRetainedTail,
				details,
			});
			deps.coordinator.end(record.sessionId, "success");
			return {
				payload: rewrittenPayload,
				compaction: {
					token: compaction.token,
					summary,
					tokensBefore,
					...(usage === undefined ? {} : { usage }),
					details,
				},
			};
		} finally {
			releaseAbort();
		}
	} catch (error) {
		deps.coordinator.end(
			record.sessionId,
			isAborted(record.signal) || isAborted(ctx.signal) ? "cancel" : "error",
		);
		throw error instanceof Error && error.message === REPLAY_ERROR
			? error
			: new Error(REPLAY_ERROR);
	}
}

async function assertFreshBeforeProposal(
	record: CodexProviderRequestRecord,
	ctx: ExtensionContext,
	candidateLeafId: string | null,
	configuration: ConfigurationService,
	profile: CodexToolProfileCoordinator,
): Promise<void> {
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

function findLatestCheckpoint(
	branch: readonly SessionEntry[],
	identity: CodexCompactionIdentity | undefined,
): { readonly value?: BranchCheckpoint; readonly blocked: boolean } {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type !== "compaction" && entry.type !== "custom") continue;
		const kind = classifyPersistedCompaction(
			toPersistedEntryView(entry),
			entry.type === "compaction" && typeof entry.summary === "string"
				? sha256Hex(entry.summary)
				: undefined,
		);
		if (kind.source === "portable_pi") {
			// Ordinary Pi compaction is a portable boundary without opaque replay state.
			if (entry.type === "compaction") return { blocked: false };
			continue;
		}
		if (kind.source === "malformed_adaptor") return { blocked: true };
		if (kind.source === "legacy_opaque") {
			const details = kind.details;
			if (details.kind === CODEX_AUTO_COMPACTION_KIND) {
				if (identity === undefined || !sameCompactionIdentity(details, identity)) {
					return { blocked: true };
				}
				return {
					blocked: false,
					value: {
						source: "automatic",
						entry,
						checkpoint: details,
						output: details.output,
						coveredEntryId: details.coveredEntryId,
					},
				};
			}
			if (details.version === 1) return { blocked: true };
			if (identity === undefined || !sameCompactionIdentity(details, identity)) {
				return { blocked: true };
			}
			return {
				blocked: false,
				value: {
					source: "manual",
					entry,
					details,
					output: details.output,
				},
			};
		}
		const retainedTail = projectRetainedTail(entry);
		if (retainedTail === undefined) return { blocked: true };
		if (kind.details.opaque === undefined || identity === undefined) {
			return {
				blocked: false,
				value: {
					source: "manual",
					entry,
					details: kind.details,
					retainedTail,
				},
			};
		}
		return sameCompactionIdentity(kind.details.opaque, identity)
			? {
					blocked: false,
					value: {
						source: "manual",
						entry,
						details: kind.details,
						output: kind.details.opaque.output,
						retainedTail,
					},
				}
			: {
					blocked: false,
					value: {
						source: "manual",
						entry,
						details: kind.details,
						retainedTail,
					},
				};
	}
	return { blocked: false };
}

function fullActivePath(
	sessionManager: ExtensionContext["sessionManager"],
): readonly SessionEntry[] {
	if (typeof sessionManager.getFullActivePathSnapshot !== "function") {
		throw new Error(REPLAY_ERROR);
	}
	const entries = sessionManager.getFullActivePathSnapshot();
	if (!Array.isArray(entries)) throw new Error(REPLAY_ERROR);
	return entries;
}

function findLegacyMigrationCheckpoint(
	branch: readonly SessionEntry[],
	identity: CodexCompactionIdentity | undefined,
): LegacyMigrationCheckpoint | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type !== "compaction" && entry.type !== "custom") continue;
		const kind = classifyPersistedCompaction(
			toPersistedEntryView(entry),
			entry.type === "compaction" && typeof entry.summary === "string"
				? sha256Hex(entry.summary)
				: undefined,
		);
		if (kind.source === "portable_pi" || kind.source === "adaptor_v3") return undefined;
		if (kind.source === "malformed_adaptor") return undefined;
		const details = kind.details;
		if (details.kind === CODEX_AUTO_COMPACTION_KIND) {
			return identity !== undefined && sameCompactionIdentity(details, identity)
				? undefined
				: { source: "automatic" };
		}
		if (details.version === 1) return { source: "manual" };
		if (details.version === 2) {
			return identity !== undefined && sameCompactionIdentity(details, identity)
				? undefined
				: { source: "manual" };
		}
		return undefined;
	}
	return undefined;
}

function toPersistedEntryView(entry: SessionEntry): PersistedCompactionEntryView {
	if (entry.type === "custom") {
		return {
			type: "custom",
			id: entry.id,
			parentId: entry.parentId,
			customType: entry.customType,
			data: entry.data,
		};
	}
	if (entry.type === "compaction") {
		return {
			type: "compaction",
			id: entry.id,
			parentId: entry.parentId,
			summary: entry.summary,
			...(entry.details === undefined ? {} : { details: entry.details }),
			...(entry.firstKeptEntryId === undefined ? {} : { firstKeptEntryId: entry.firstKeptEntryId }),
			...(entry.usage === undefined ? {} : { usage: entry.usage }),
			...(entry.retainedTail === undefined ? {} : { retainedTail: entry.retainedTail }),
		};
	}
	return { type: "custom", id: entry.id, parentId: entry.parentId };
}

function segmentProviderInput(options: {
	readonly contextEntries: readonly SessionEntry[];
	readonly checkpoint: BranchCheckpoint | undefined;
	readonly input: readonly StructuredResponseItem[];
	readonly candidateRetainedTail: readonly StructuredResponseItem[];
}): InputSegmentation | undefined {
	const { contextEntries, checkpoint, input, candidateRetainedTail } = options;
	const candidates: Array<{
		readonly contextPrefix: readonly StructuredResponseItem[];
	}> = [];
	if (checkpoint === undefined) {
		candidates.push({ contextPrefix: projectCanonicalEntries(contextEntries) });
	} else if (checkpoint.source === "automatic" && checkpoint.checkpoint !== undefined) {
		const coveredEntryId = checkpoint.checkpoint.coveredEntryId;
		const coveredIndex = contextEntries.findIndex((entry) => entry.id === coveredEntryId);
		if (coveredIndex < 0) return undefined;
		const after = projectProviderEntries(contextEntries.slice(coveredIndex + 1));
		const output = checkpoint.output;
		if (output === undefined) return undefined;
		candidates.push({
			contextPrefix: projectProviderEntries(contextEntries.slice(0, coveredIndex + 1)),
		});
		candidates.push({
			contextPrefix: [...output, ...after],
		});
	} else {
		candidates.push({ contextPrefix: projectCanonicalEntries(contextEntries) });
		if (checkpoint.output !== undefined) {
			candidates.push({
				contextPrefix: [...checkpoint.output, ...(checkpoint.retainedTail ?? [])],
			});
		}
	}
	const matches = candidates
		.filter((candidate) => hasPrefix(input, candidate.contextPrefix))
		.filter((candidate) => hasSuffix(candidate.contextPrefix, candidateRetainedTail))
		.filter(
			(candidate, index, all) =>
				all.findIndex((other) => structuralEqual(candidate.contextPrefix, other.contextPrefix)) ===
				index,
		);
	if (matches.length !== 1) return undefined;
	const match = matches[0];
	if (match === undefined) return undefined;
	const compactPrefix = match.contextPrefix
		.slice(0, match.contextPrefix.length - candidateRetainedTail.length)
		.map(cloneStructuredValue);
	const liveSuffix = input.slice(match.contextPrefix.length).map(cloneStructuredValue);
	return {
		compactPrefix,
		retainedTail: candidateRetainedTail.map(cloneStructuredValue),
		liveSuffix,
	};
}

function projectCanonicalEntries(
	entries: readonly SessionEntry[],
): readonly StructuredResponseItem[] {
	return projectEntries(entries, true);
}

function projectProviderEntries(
	entries: readonly SessionEntry[],
): readonly StructuredResponseItem[] {
	// Once an automatic snapshot supersedes a manual one, buildCodexRequest no longer
	// canonicalizes Pi's older compaction marker. Match the model-facing projection
	// after Pi converts that marker to a user message, then replace the covered prefix.
	return projectEntries(entries, false);
}

function projectEntries(
	entries: readonly SessionEntry[],
	replayManualCompaction: boolean,
): readonly StructuredResponseItem[] {
	const items: StructuredResponseItem[] = [];
	let messages: ReturnType<typeof sessionEntryToContextMessages> = [];
	const flushMessages = (): void => {
		if (messages.length === 0) return;
		const projected = responseItemsFromMessages(convertToLlm(messages));
		for (const item of projected) {
			if (!isStructuredJsonValue(item) || !isSupportedStructuredResponseItem(item)) {
				throw new Error(REPLAY_ERROR);
			}
			items.push(item);
		}
		messages = [];
	};
	for (const entry of entries) {
		if (entry.type === "custom") continue;
		if (entry.type === "compaction" && replayManualCompaction) {
			flushMessages();
			const details = parseCodexCompactionDetails(entry.details);
			if (details?.version === 2) {
				items.push(...details.output.map(cloneStructuredValue));
				continue;
			}
		}
		messages.push(...sessionEntryToContextMessages(entry));
	}
	flushMessages();
	return items;
}

function projectMigrationCanonicalEntries(
	entries: readonly SessionEntry[],
): readonly StructuredResponseItem[] {
	const items: StructuredResponseItem[] = [];
	let messages: ReturnType<typeof sessionEntryToContextMessages> = [];
	const flushMessages = (): void => {
		if (messages.length === 0) return;
		const projected = responseItemsFromMessages(convertToLlm(messages));
		for (const item of projected) {
			if (!isStructuredJsonValue(item) || !isSupportedStructuredResponseItem(item)) {
				throw new Error(REPLAY_ERROR);
			}
			items.push(item);
		}
		messages = [];
	};
	for (const entry of entries) {
		if (entry.type === "custom") continue;
		if (entry.type === "compaction") {
			const details = parseCodexCompactionDetails(entry.details);
			if (details?.version === 1 || details?.version === 2) continue;
		}
		messages.push(...sessionEntryToContextMessages(entry));
	}
	flushMessages();
	return items;
}

function projectCurrentRequestContext(
	entries: readonly SessionEntry[],
): readonly StructuredResponseItem[] {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	const items: StructuredResponseItem[] = [];
	const projected = responseItemsFromMessages(convertToLlm(messages));
	for (const item of projected) {
		if (!isStructuredJsonValue(item) || !isSupportedStructuredResponseItem(item)) {
			throw new Error(REPLAY_ERROR);
		}
		items.push(item);
	}
	return items;
}

function segmentCurrentRequestInput(
	contextEntries: readonly SessionEntry[],
	input: readonly StructuredResponseItem[],
	candidateRetainedTail: readonly StructuredResponseItem[],
): InputSegmentation | undefined {
	const currentContextPrefix = projectCurrentRequestContext(contextEntries);
	if (
		!hasPrefix(input, currentContextPrefix) ||
		!hasSuffix(currentContextPrefix, candidateRetainedTail)
	) {
		return undefined;
	}
	return {
		compactPrefix: currentContextPrefix
			.slice(0, currentContextPrefix.length - candidateRetainedTail.length)
			.map(cloneStructuredValue),
		retainedTail: candidateRetainedTail.map(cloneStructuredValue),
		liveSuffix: input.slice(currentContextPrefix.length).map(cloneStructuredValue),
	};
}

function hasPrefix(input: readonly unknown[], prefix: readonly unknown[]): boolean {
	if (prefix.length > input.length) return false;
	for (let index = 0; index < prefix.length; index += 1) {
		if (!structuralEqual(input[index], prefix[index])) return false;
	}
	return true;
}

function hasSuffix(input: readonly unknown[], suffix: readonly unknown[]): boolean {
	if (suffix.length > input.length) return false;
	const offset = input.length - suffix.length;
	for (let index = 0; index < suffix.length; index += 1) {
		if (!structuralEqual(input[offset + index], suffix[index])) return false;
	}
	return true;
}

function projectRetainedTail(entry: SessionEntry): readonly StructuredResponseItem[] | undefined {
	const retainedTail = requestRecord(entry)?.retainedTail;
	if (!Array.isArray(retainedTail)) return undefined;
	const projected = responseItemsFromMessages(retainedTail);
	if (
		!projected.every(
			(item) => isStructuredJsonValue(item) && isSupportedStructuredResponseItem(item),
		)
	) {
		return undefined;
	}
	return projected.map(cloneStructuredValue);
}

function projectCandidateRetainedTail(
	value: readonly unknown[],
): readonly StructuredResponseItem[] {
	const projected = responseItemsFromMessages(value);
	if (
		!projected.every(
			(item) => isStructuredJsonValue(item) && isSupportedStructuredResponseItem(item),
		)
	) {
		throw new Error(REPLAY_ERROR);
	}
	return projected.map(cloneStructuredValue);
}

function portableSummaryItems(
	summary: string,
	tokensBefore: number,
): readonly StructuredResponseItem[] {
	const projected = responseItemsFromMessages([
		{
			role: "compactionSummary",
			summary,
			tokensBefore,
			timestamp: Date.now(),
		},
	]);
	if (
		!projected.every(
			(item) => isStructuredJsonValue(item) && isSupportedStructuredResponseItem(item),
		)
	) {
		throw new Error(REPLAY_ERROR);
	}
	return projected.map(cloneStructuredValue);
}

function normalizeSummary(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(REPLAY_ERROR);
	}
	return value;
}

function normalizeTokensBefore(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(REPLAY_ERROR);
	}
	return Math.trunc(value);
}

function usageFromNormalized(
	value:
		| {
				inputTokens: number;
				outputTokens: number;
				cachedInputTokens: number;
				reasoningTokens?: number;
		  }
		| undefined,
): Usage | undefined {
	if (value === undefined) return undefined;
	const cachedInputTokens = toCount(value.cachedInputTokens);
	const inputTokens = Math.max(0, toCount(value.inputTokens) - cachedInputTokens);
	return {
		input: inputTokens,
		output: toCount(value.outputTokens),
		cacheRead: cachedInputTokens,
		cacheWrite: 0,
		totalTokens: inputTokens + toCount(value.outputTokens) + cachedInputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(value.reasoningTokens === undefined ? {} : { reasoning: toCount(value.reasoningTokens) }),
	};
}

function combineUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
	};
}

function toCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
	if (signal === undefined) return () => {};
	if (signal.aborted) {
		controller.abort(signal.reason);
		return () => {};
	}
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	return () => signal.removeEventListener("abort", abort);
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

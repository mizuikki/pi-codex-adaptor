import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderCheckpointProposal,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { CodexRuntime } from "../../application/codex-runtime.ts";
import {
	CodexCompactionCoordinator,
	type CodexCompactionStore,
} from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	capabilityCacheKey,
	ResolveEffectiveCapabilities,
} from "../../application/resolve-effective-capabilities.ts";
import {
	createRemoteCheckpointProposal,
	projectCanonicalEntries,
	providerCompactionIdentityFromValues,
	registerCodexCompactionReplay,
	restoreProviderCheckpointUsageBoundary,
} from "./codex-compaction-replay.ts";
import type { CodexProviderRequestGuard } from "./codex-provider-request-guard.ts";
import {
	type CodexToolProfileCoordinator,
	createUnavailableCodexToolProfile,
} from "./codex-tool-profile.ts";
import { resolveProviderConnection } from "./provider-connection.ts";

type SessionBeforeCompactResult =
	| { readonly cancel: true; readonly errorMessage?: string; readonly providerCheckpoint?: never }
	| { readonly cancel?: false; readonly providerCheckpoint: ProviderCheckpointProposal };

export function registerCodexCompaction(
	pi: ExtensionAPI,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	store: CodexCompactionStore,
	activation: ProviderActivationPolicy,
	coordinator: CodexCompactionCoordinator = new CodexCompactionCoordinator(),
	capabilities = new ResolveEffectiveCapabilities(runtime),
	profile: CodexToolProfileCoordinator = createUnavailableCodexToolProfile(),
	requestGuard?: CodexProviderRequestGuard,
): void {
	const restore = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const connection = await resolveProviderConnection(
				ctx,
				activation,
				"Codex compaction is inactive for the selected provider and API",
			);
			await restoreProviderCheckpointUsageBoundary({ pi, ctx, activation, store, connection });
		} catch {
			try {
				await restoreProviderCheckpointUsageBoundary({ pi, ctx, activation, store });
			} catch {
				try {
					pi.setProviderCheckpointUsageBoundary?.();
				} catch {
					// Session lifecycle restoration is fail-closed and must not reject host events.
				}
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.dispose(sessionId);
		store.dispose(sessionId);
		await restore(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		await restore(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await restore(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.dispose(sessionId);
		store.dispose(sessionId);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		return compactForPi(event, ctx, {
			runtime,
			configuration,
			activation,
			coordinator,
			capabilities,
			profile,
		});
	});
	if (requestGuard !== undefined) {
		registerCodexCompactionReplay({
			pi,
			runtime,
			configuration,
			activation,
			store,
			coordinator,
			capabilities,
			profile,
			guard: requestGuard,
		});
	}
}

async function compactForPi(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	state: {
		readonly runtime: CodexRuntime;
		readonly configuration: ConfigurationService;
		readonly activation: ProviderActivationPolicy;
		readonly coordinator: CodexCompactionCoordinator;
		readonly capabilities: ResolveEffectiveCapabilities;
		readonly profile: CodexToolProfileCoordinator;
	},
): Promise<SessionBeforeCompactResult | undefined> {
	const sessionId = ctx.sessionManager.getSessionId();
	const model = ctx.model;
	if (model === undefined || !state.activation.isActive(model)) return undefined;
	if (event.customInstructions?.trim()) {
		return {
			cancel: true,
			errorMessage: "Codex remote compaction does not support custom instructions",
		};
	}
	if (event.reason === "threshold") return { cancel: true };
	if (event.signal.aborted) return { cancel: true };
	if (event.checkpointToken === undefined) {
		return { cancel: true, errorMessage: "Codex checkpoint capability is unavailable" };
	}
	let execution = false;
	try {
		const connection = await resolveProviderConnection(
			ctx,
			state.activation,
			"Codex compaction is inactive for the selected provider and API",
		);
		const config = await state.configuration.load();
		if (config.codex.compaction.mode === "off") return { cancel: true };
		const hostToolNames = state.profile.registeredManagedTools();
		const capabilityKey = capabilityCacheKey({
			modelId: model.id,
			providerId: model.provider,
			config,
			contextWindow: model.contextWindow,
			hostToolNames,
		});
		if (!state.profile.isHealthy(capabilityKey)) {
			throw new Error("Codex tool profile is unavailable for the selected capability");
		}
		const snapshot = await state.capabilities.resolve({
			modelId: model.id,
			providerId: model.provider,
			config,
			contextWindow: model.contextWindow,
			hostToolNames,
		});
		if (snapshot.compaction.implementation === null) {
			throw new Error("OpenAI Codex Remote Compaction is unavailable");
		}
		if (!state.coordinator.beginExecution(sessionId)) return { cancel: true };
		execution = true;
		const branch = event.branchEntries;
		const firstKeptIndex = branch.findIndex(
			(entry) => entry.id === event.preparation.firstKeptEntryId,
		);
		const coveredEntry = firstKeptIndex > 0 ? branch[firstKeptIndex - 1] : undefined;
		if (coveredEntry === undefined) throw new Error("Codex compaction boundary is unavailable");
		const input = projectCanonicalEntries(branch.slice(0, firstKeptIndex));
		if (input.length === 0) throw new Error("Codex compaction input is empty");
		if (providerCompactionIdentityFromValues({ sessionId, model, connection }) === undefined) {
			throw new Error("OpenAI Codex compaction credentials are unsupported");
		}
		const compacted = await createRemoteCheckpointProposal({
			runtime: state.runtime,
			connection,
			model,
			config,
			capabilities: snapshot,
			input,
			sessionId,
			coveredEntryId: coveredEntry.id,
			token: event.checkpointToken,
			trigger: event.reason === "manual" ? "manual" : "auto",
			signal: event.signal,
		});
		if (event.signal.aborted || ctx.sessionManager.getLeafId() !== branch.at(-1)?.id) {
			throw new Error("Codex compaction became stale");
		}
		state.coordinator.end(sessionId, "success");
		return { providerCheckpoint: compacted.proposal };
	} catch (error) {
		if (execution) state.coordinator.end(sessionId, event.signal.aborted ? "cancel" : "error");
		const message = error instanceof Error ? error.message : String(error);
		if (event.signal.aborted) return { cancel: true };
		return { cancel: true, errorMessage: message };
	}
}

export type { SessionBeforeCompactEvent };

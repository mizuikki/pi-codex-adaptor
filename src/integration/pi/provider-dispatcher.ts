import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Pi's extension loader only virtualizes/aliases the compat entrypoint, not the
// package `api/*` subpaths. These legacy-named exports are the direct native
// stream implementations re-exported from compat; they are not registry lookups.
import {
	streamSimpleOpenAICodexResponses,
	streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CodexRuntime } from "../../application/codex-runtime.ts";
import { CodexCompactionStore } from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import type { ResolveEffectiveCapabilities } from "../../application/resolve-effective-capabilities.ts";
import { createCodexStreamSimple } from "./codex-provider.ts";
import type { CodexProviderRequestGuard } from "./codex-provider-request-guard.ts";
import type { CodexToolProfileCoordinator } from "./codex-tool-profile.ts";

/** Direct Pi-native `openai-responses` stream; never consults the API registry. */
export const piNativeOpenAiResponsesStreamSimple =
	streamSimpleOpenAIResponses as StreamSimpleDispatcher;

/** Direct Pi-native `openai-codex-responses` stream; never consults the API registry. */
export const piNativeOpenAiCodexResponsesStreamSimple =
	streamSimpleOpenAICodexResponses as StreamSimpleDispatcher;

export type StreamSimpleDispatcher = (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function createCodexProviderDispatchers(
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
	compactions = new CodexCompactionStore(),
	capabilities?: ResolveEffectiveCapabilities,
	profile?: CodexToolProfileCoordinator,
	requestGuard?: CodexProviderRequestGuard,
): {
	codexResponses: StreamSimpleDispatcher;
	openAiResponses: StreamSimpleDispatcher;
} {
	const codex = createCodexStreamSimple(
		runtime,
		configuration,
		activation,
		compactions,
		capabilities,
		profile,
		requestGuard,
	);
	return {
		codexResponses: createDispatcher(activation, codex, piNativeOpenAiCodexResponsesStreamSimple),
		openAiResponses: createDispatcher(activation, codex, piNativeOpenAiResponsesStreamSimple),
	};
}

export function registerCodexProviderRoutes(
	registerProvider: ExtensionAPI["registerProvider"],
	handlers: {
		readonly codexResponses: StreamSimpleDispatcher;
		readonly openAiResponses: StreamSimpleDispatcher;
	},
	providerIds: readonly string[],
): void {
	const selected = new Set(["openai-codex", ...providerIds]);
	for (const providerId of selected) {
		if (providerId === "openai-codex") {
			registerProvider(providerId, {
				api: "openai-codex-responses",
				streamSimple: handlers.codexResponses,
			});
			continue;
		}
		registerProvider(providerId, {
			api: "openai-responses",
			streamSimple: handlers.openAiResponses,
		});
	}
}

function createDispatcher(
	activation: ProviderActivationPolicy,
	adaptor: StreamSimpleDispatcher,
	fallback: StreamSimpleDispatcher,
): StreamSimpleDispatcher {
	return (model, context, options) =>
		activation.isActive(model)
			? adaptor(model, context, options)
			: fallback(model, context, options);
}

export function createProviderDispatcher(
	activation: ProviderActivationPolicy,
	adaptor: StreamSimpleDispatcher,
	fallback: StreamSimpleDispatcher,
): StreamSimpleDispatcher {
	return createDispatcher(activation, adaptor, fallback);
}

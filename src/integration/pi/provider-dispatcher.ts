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

import type { CodexRuntime } from "../../application/codex-runtime.ts";
import { CodexCompactionStore } from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import type { ResolveEffectiveCapabilities } from "../../application/resolve-effective-capabilities.ts";
import { createCodexStreamSimple } from "./codex-provider.ts";
import type { CodexToolProfileCoordinator } from "./codex-tool-profile.ts";

/** Direct Pi-native `openai-responses` stream; never consults the API registry. */
export const piNativeOpenAiResponsesStreamSimple =
	streamSimpleOpenAIResponses as StreamSimpleDispatcher;

/** Direct Pi-native `openai-codex-responses` stream; never consults the API registry. */
export const piNativeOpenAiCodexResponsesStreamSimple =
	streamSimpleOpenAICodexResponses as StreamSimpleDispatcher;

export function createCodexProviderDispatchers(
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
	compactions = new CodexCompactionStore(),
	capabilities?: ResolveEffectiveCapabilities,
	profile?: CodexToolProfileCoordinator,
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
	);
	return {
		codexResponses: createDispatcher(activation, codex, piNativeOpenAiCodexResponsesStreamSimple),
		openAiResponses: createDispatcher(activation, codex, piNativeOpenAiResponsesStreamSimple),
	};
}

type StreamSimpleDispatcher = (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

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

import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamPiNative } from "@earendil-works/pi-ai/compat";

import type { CodexRuntime } from "../../application/codex-runtime.ts";
import { CodexCompactionStore } from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import { createCodexStreamSimple } from "./codex-provider.ts";

export function createCodexProviderDispatchers(
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
	compactions = new CodexCompactionStore(),
): {
	codexResponses: StreamSimpleDispatcher;
	openAiResponses: StreamSimpleDispatcher;
} {
	const codex = createCodexStreamSimple(runtime, configuration, activation, compactions);
	return {
		codexResponses: createDispatcher(
			activation,
			codex,
			streamPiNative as unknown as StreamSimpleDispatcher,
		),
		openAiResponses: createDispatcher(
			activation,
			codex,
			streamPiNative as unknown as StreamSimpleDispatcher,
		),
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

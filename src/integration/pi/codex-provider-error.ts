import { CapabilityError } from "../../domain/capability.ts";
import { ConfigurationError } from "../../domain/config.ts";
import {
	BridgeConnectionError,
	BridgeRemoteError,
} from "../../infrastructure/codex-bridge/client.ts";

const PI_RETRYABLE_PROVIDER_ERROR = "OpenAI provider service unavailable";

export class CodexProviderContextWindowError extends Error {
	constructor() {
		super("the request reached the model context checkpoint threshold");
		this.name = "CodexProviderContextWindowError";
	}
}

/**
 * Map a caught provider-stream error to a safe Pi assistant errorMessage.
 * Retryability is trusted only from BridgeRemoteError.retryable. The local context
 * preflight enters Pi's overflow lifecycle without issuing a provider request.
 */
export function toPiProviderErrorMessage(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "Request aborted";
	}
	if (error instanceof CapabilityError) {
		return error.reason;
	}
	if (error instanceof CodexProviderContextWindowError) {
		return "context_length_exceeded: the request reached the model context checkpoint threshold";
	}
	if (error instanceof BridgeRemoteError && error.code === "context_window_exceeded") {
		return "context_length_exceeded: the request exceeded the model context window";
	}
	if (error instanceof BridgeRemoteError && error.retryable) {
		return `${PI_RETRYABLE_PROVIDER_ERROR}: ${error.message}`;
	}
	if (isExistingSafeProviderError(error)) {
		return error.message;
	}
	return "OpenAI Codex request failed";
}

function isExistingSafeProviderError(
	error: unknown,
): error is BridgeRemoteError | BridgeConnectionError | ConfigurationError {
	return (
		error instanceof BridgeRemoteError ||
		error instanceof BridgeConnectionError ||
		error instanceof ConfigurationError
	);
}

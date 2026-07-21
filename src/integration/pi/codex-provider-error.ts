import { CapabilityError } from "../../domain/capability.ts";
import { ConfigurationError } from "../../domain/config.ts";
import {
	BridgeConnectionError,
	BridgeRemoteError,
} from "../../infrastructure/codex-bridge/client.ts";

const PI_RETRYABLE_PROVIDER_ERROR = "OpenAI provider service unavailable";

/**
 * Map a caught provider-stream error to a safe Pi assistant errorMessage.
 * Retryability is trusted only from BridgeRemoteError.retryable; this helper never
 * schedules a retry or issues a second provider request.
 */
export function toPiProviderErrorMessage(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "Request aborted";
	}
	if (error instanceof CapabilityError) {
		return error.reason;
	}
	if (error instanceof BridgeRemoteError && error.retryable) {
		return PI_RETRYABLE_PROVIDER_ERROR;
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

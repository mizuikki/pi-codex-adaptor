import { describe, expect, test } from "bun:test";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";

import { CapabilityError } from "../../src/domain/capability.ts";
import { ConfigurationError } from "../../src/domain/config.ts";
import {
	BridgeConnectionError,
	BridgeRemoteError,
} from "../../src/infrastructure/codex-bridge/client.ts";
import { toPiProviderErrorMessage } from "../../src/integration/pi/codex-provider-error.ts";

const RETRYABLE_TEXT = "OpenAI provider service unavailable";
const GENERIC_TEXT = "OpenAI Codex request failed";

function bridgeError(options: {
	message: string;
	retryable: boolean;
	code?: string;
}): BridgeRemoteError {
	return new BridgeRemoteError({
		category: "NativeToolError",
		code: options.code ?? "openai_request_failed",
		message: options.message,
		retryable: options.retryable,
	});
}

function classifierInput(
	stopReason: AssistantMessage["stopReason"],
	errorMessage: string,
): AssistantMessage {
	return { stopReason, errorMessage } as AssistantMessage;
}

describe("toPiProviderErrorMessage", () => {
	test("maps retryable BridgeRemoteError to the fixed Pi-compatible text", () => {
		const secretSource = "upstream body contains fixture-secret-token";
		const message = toPiProviderErrorMessage(
			bridgeError({ message: secretSource, retryable: true }),
		);
		expect(message).toBe(RETRYABLE_TEXT);
		expect(message).not.toContain("fixture-secret-token");
		expect(message).not.toContain(secretSource);
		expect(isRetryableAssistantError(classifierInput("error", message))).toBe(true);
	});

	test("preserves non-retryable BridgeRemoteError protocol-safe messages", () => {
		const message = toPiProviderErrorMessage(
			bridgeError({ message: "The OpenAI request failed", retryable: false }),
		);
		expect(message).toBe("The OpenAI request failed");
		expect(message).not.toBe(RETRYABLE_TEXT);
		expect(isRetryableAssistantError(classifierInput("error", message))).toBe(false);
	});

	test("does not promote a spoofed ordinary Error by message text", () => {
		const spoofed = new Error(RETRYABLE_TEXT);
		spoofed.name = "BridgeRemoteError";
		const message = toPiProviderErrorMessage(spoofed);
		expect(message).toBe(GENERIC_TEXT);
		expect(isRetryableAssistantError(classifierInput("error", message))).toBe(false);
	});

	test("preserves abort semantics", () => {
		const message = toPiProviderErrorMessage(
			new DOMException("The OpenAI Codex request was aborted", "AbortError"),
		);
		expect(message).toBe("Request aborted");
		expect(isRetryableAssistantError(classifierInput("aborted", message))).toBe(false);
	});

	test("preserves CapabilityError reasons", () => {
		const message = toPiProviderErrorMessage(
			new CapabilityError("provider_session_unavailable", "Provider route is unavailable"),
		);
		expect(message).toBe("Provider route is unavailable");
	});

	test("preserves BridgeConnectionError and ConfigurationError messages", () => {
		expect(
			toPiProviderErrorMessage(
				new BridgeConnectionError("connection_closed", "The bridge connection closed"),
			),
		).toBe("The bridge connection closed");
		expect(toPiProviderErrorMessage(new ConfigurationError([]))).toBe(
			"The Codex adaptor configuration is invalid",
		);
	});

	test("falls back for unknown errors", () => {
		expect(toPiProviderErrorMessage(new Error("unexpected"))).toBe(GENERIC_TEXT);
		expect(toPiProviderErrorMessage("string failure")).toBe(GENERIC_TEXT);
	});
});

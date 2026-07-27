import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CodexRuntime } from "../../application/codex-runtime.ts";

export const REQUIRED_EXTENSION_SDK_API_VERSION = 1;
export const REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION = 1;
export const REQUIRED_COMPACTION_FAILURE_RESULT_API_VERSION = 1;
export const REQUIRED_PROVIDER_CHECKPOINT_COMMIT_API_VERSION = 1;

export function assertProviderPayloadCompactionHost(pi: ExtensionAPI): void {
	if (capabilityVersion(pi, "extensionSdkApiVersion") !== REQUIRED_EXTENSION_SDK_API_VERSION) {
		throw new Error(
			`Pi host is incompatible: requires extension SDK API version ${REQUIRED_EXTENSION_SDK_API_VERSION}`,
		);
	}
	if (
		capabilityVersion(pi, "providerPayloadCompactionApiVersion") !==
		REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION
	) {
		throw new Error(
			`Pi host is incompatible: requires provider payload compaction API version ${REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION}`,
		);
	}
	if (
		capabilityVersion(pi, "compactionFailureResultApiVersion") !==
		REQUIRED_COMPACTION_FAILURE_RESULT_API_VERSION
	) {
		throw new Error(
			`Pi host is incompatible: requires compaction failure result API version ${REQUIRED_COMPACTION_FAILURE_RESULT_API_VERSION}`,
		);
	}
	if (
		capabilityVersion(pi, "providerCheckpointCommitApiVersion") !==
			REQUIRED_PROVIDER_CHECKPOINT_COMMIT_API_VERSION ||
		typeof pi.setProviderCheckpointUsageBoundary !== "function"
	) {
		throw new Error(
			`Pi host is incompatible: requires provider checkpoint commit API version ${REQUIRED_PROVIDER_CHECKPOINT_COMMIT_API_VERSION}`,
		);
	}
}

export async function assertRemoteCompactionBridge(runtime: CodexRuntime): Promise<void> {
	const diagnostics = await runtime.readDiagnostics?.();
	if (typeof diagnostics !== "object" || diagnostics === null || Array.isArray(diagnostics)) {
		throw new Error(
			"Native bridge is incompatible: verified Remote Compaction capabilities are unavailable",
		);
	}
	const capabilities = (diagnostics as Record<string, unknown>).capabilities;
	if (
		!Array.isArray(capabilities) ||
		!capabilities.every((value) => typeof value === "string") ||
		(!capabilities.includes("remote_compaction_v2") && !capabilities.includes("compact_endpoint"))
	) {
		throw new Error("Native bridge is incompatible: Remote Compaction is unavailable");
	}
}

function capabilityVersion(value: unknown, name: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[name];
}

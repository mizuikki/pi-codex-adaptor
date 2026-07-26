import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REQUIRED_EXTENSION_SDK_API_VERSION = 1;
export const REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION = 1;
export const REQUIRED_COMPACTION_FAILURE_RESULT_API_VERSION = 1;

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
}

function capabilityVersion(value: unknown, name: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[name];
}

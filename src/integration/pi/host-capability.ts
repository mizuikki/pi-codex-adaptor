import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION = 1;

export function assertProviderPayloadCompactionHost(pi: ExtensionAPI): void {
	if (
		providerPayloadCompactionApiVersion(pi) === REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION
	) {
		return;
	}
	throw new Error(
		`Pi host is incompatible: requires provider payload compaction API version ${REQUIRED_PROVIDER_PAYLOAD_COMPACTION_API_VERSION}`,
	);
}

function providerPayloadCompactionApiVersion(value: unknown): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>).providerPayloadCompactionApiVersion;
}

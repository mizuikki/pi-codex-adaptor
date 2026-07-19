import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BridgeClient, spawnBridgeTransport } from "./client.ts";
import {
	nativeTargetFor,
	SUPPORTED_NATIVE_TARGETS,
	type SupportedNativeTarget,
} from "./identity.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
} from "./protocol.ts";

export type { SupportedNativeTarget };
export { SUPPORTED_NATIVE_TARGETS };

export interface NativeArtifactManifest {
	schemaVersion: 1;
	target: SupportedNativeTarget;
	executable: string;
	executableSize: number;
	executableSha256: string;
	projectSourceCommit: string;
	bridgeProtocolVersion: number;
	officialCodexVersion: string;
	officialCodexTag: string;
	officialSourceCommit: string;
	vendorTreeSha256: string;
}

export interface VerifiedPackagedBridgeArtifact {
	executablePath: string;
	manifest: NativeArtifactManifest;
}

export interface ConnectBundledBridgeOptions {
	packageRoot: string;
	clientVersion: string;
	allowDevelopmentBuild?: boolean;
	expectedBuildSourceCommit?: string;
	handshakeTimeoutMs?: number;
	platform?: NodeJS.Platform;
	architecture?: string;
	executable?: string;
	buildTarget?: SupportedNativeTarget;
}

export class BridgeLoaderError extends Error {
	readonly code:
		| "unsupported_target"
		| "missing_artifact"
		| "invalid_artifact"
		| "artifact_tampered"
		| "development_override_required";

	constructor(code: BridgeLoaderError["code"], message: string) {
		super(message);
		this.name = "BridgeLoaderError";
		this.code = code;
	}
}

export function resolveNativeTarget(
	platform: NodeJS.Platform = process.platform,
	architecture: string = process.arch,
): SupportedNativeTarget {
	const target = nativeTargetFor(platform, architecture);
	if (target === undefined) {
		throw new BridgeLoaderError(
			"unsupported_target",
			`No codex-bridge binary is available for ${platform}/${architecture}`,
		);
	}
	return target;
}

export function resolveBridgeExecutable(
	packageRoot: string,
	target: SupportedNativeTarget,
): string {
	return resolve(packageRoot, "native", "bin", target, expectedExecutableName(target));
}

export function resolveBridgeArtifactManifest(
	packageRoot: string,
	target: SupportedNativeTarget,
): string {
	return resolve(packageRoot, "native", "bin", target, "native-artifact.json");
}

/**
 * Fail-closed verification of a packaged sidecar before process spawn.
 * Reads the target manifest, validates identity fields, then streams the
 * executable through SHA-256 and compares size and digest.
 */
export async function verifyPackagedBridgeArtifact(
	packageRoot: string,
	target: SupportedNativeTarget,
): Promise<VerifiedPackagedBridgeArtifact> {
	const manifestPath = resolveBridgeArtifactManifest(packageRoot, target);
	let raw: string;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch {
		throw new BridgeLoaderError("missing_artifact", "Packaged codex-bridge artifact is missing");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new BridgeLoaderError("invalid_artifact", "Packaged codex-bridge artifact is invalid");
	}

	const manifest = parseNativeArtifactManifest(parsed, target);
	const executablePath = resolve(packageRoot, "native", "bin", target, manifest.executable);
	let digest: { size: number; sha256: string };
	try {
		digest = await hashFileSha256(executablePath);
	} catch {
		throw new BridgeLoaderError("missing_artifact", "Packaged codex-bridge artifact is missing");
	}

	if (digest.size !== manifest.executableSize || digest.sha256 !== manifest.executableSha256) {
		throw new BridgeLoaderError(
			"artifact_tampered",
			"Packaged codex-bridge artifact failed integrity verification",
		);
	}

	return { executablePath, manifest };
}

export async function connectBundledBridge(
	options: ConnectBundledBridgeOptions,
): Promise<BridgeClient> {
	const target = options.buildTarget ?? resolveNativeTarget(options.platform, options.architecture);
	const resolved = await resolveBundledBridgeLaunch(options, target);
	return BridgeClient.connect({
		buildTarget: target,
		clientVersion: options.clientVersion,
		transport: spawnBridgeTransport(resolved.executable),
		...(options.allowDevelopmentBuild === undefined
			? {}
			: { allowDevelopmentBuild: options.allowDevelopmentBuild }),
		...(options.handshakeTimeoutMs === undefined
			? {}
			: { handshakeTimeoutMs: options.handshakeTimeoutMs }),
		...(resolved.expectedBuildSourceCommit === undefined
			? {}
			: { expectedBuildSourceCommit: resolved.expectedBuildSourceCommit }),
	});
}

/**
 * Resolve the executable and handshake identity for a bundled launch.
 * Production packaged launches always verify native-artifact.json first.
 * Explicit executable overrides require allowDevelopmentBuild and never
 * silently skip that requirement.
 */
export async function resolveBundledBridgeLaunch(
	options: ConnectBundledBridgeOptions,
	target: SupportedNativeTarget = options.buildTarget ??
		resolveNativeTarget(options.platform, options.architecture),
): Promise<{ executable: string; expectedBuildSourceCommit?: string }> {
	if (options.executable !== undefined) {
		if (options.allowDevelopmentBuild !== true) {
			throw new BridgeLoaderError(
				"development_override_required",
				"Development bridge overrides require allowDevelopmentBuild",
			);
		}
		return {
			executable: options.executable,
			...(options.expectedBuildSourceCommit === undefined
				? {}
				: { expectedBuildSourceCommit: options.expectedBuildSourceCommit }),
		};
	}

	const verified = await verifyPackagedBridgeArtifact(options.packageRoot, target);
	return {
		executable: verified.executablePath,
		expectedBuildSourceCommit: verified.manifest.projectSourceCommit,
	};
}

export function expectedExecutableName(target: SupportedNativeTarget): string {
	return target === "x86_64-pc-windows-msvc" ? "codex-bridge.exe" : "codex-bridge";
}

function parseNativeArtifactManifest(
	value: unknown,
	expectedTarget: SupportedNativeTarget,
): NativeArtifactManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BridgeLoaderError("invalid_artifact", "Packaged codex-bridge artifact is invalid");
	}

	const record = value as Record<string, unknown>;
	const executableName = expectedExecutableName(expectedTarget);
	const schemaVersion = record.schemaVersion;
	const target = record.target;
	const executable = record.executable;
	const executableSize = record.executableSize;
	const executableSha256 = record.executableSha256;
	const projectSourceCommit = record.projectSourceCommit;
	const bridgeProtocolVersion = record.bridgeProtocolVersion;
	const officialCodexVersion = record.officialCodexVersion;
	const officialCodexTag = record.officialCodexTag;
	const officialSourceCommit = record.officialSourceCommit;
	const vendorTreeSha256 = record.vendorTreeSha256;

	if (
		schemaVersion !== 1 ||
		target !== expectedTarget ||
		executable !== executableName ||
		typeof executableSize !== "number" ||
		!Number.isInteger(executableSize) ||
		executableSize < 1 ||
		typeof executableSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(executableSha256) ||
		typeof projectSourceCommit !== "string" ||
		!/^[0-9a-f]{40}$/.test(projectSourceCommit) ||
		bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION ||
		officialCodexVersion !== OFFICIAL_CODEX_VERSION ||
		officialCodexTag !== OFFICIAL_CODEX_TAG ||
		officialSourceCommit !== OFFICIAL_SOURCE_COMMIT ||
		vendorTreeSha256 !== VENDOR_TREE_SHA256
	) {
		throw new BridgeLoaderError("invalid_artifact", "Packaged codex-bridge artifact is invalid");
	}

	return {
		schemaVersion: 1,
		target: expectedTarget,
		executable: executableName,
		executableSize,
		executableSha256,
		projectSourceCommit,
		bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
		officialCodexVersion: OFFICIAL_CODEX_VERSION,
		officialCodexTag: OFFICIAL_CODEX_TAG,
		officialSourceCommit: OFFICIAL_SOURCE_COMMIT,
		vendorTreeSha256: VENDOR_TREE_SHA256,
	};
}

async function hashFileSha256(path: string): Promise<{ size: number; sha256: string }> {
	const hash = createHash("sha256");
	let size = 0;
	const stream = createReadStream(path);
	try {
		for await (const chunk of stream) {
			const bytes = chunk as Buffer;
			size += bytes.byteLength;
			hash.update(bytes);
		}
	} catch (error) {
		stream.destroy();
		throw error;
	}
	return { size, sha256: hash.digest("hex") };
}

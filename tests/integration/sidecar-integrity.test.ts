import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
	BridgeLoaderError,
	connectBundledBridge,
	resolveBundledBridgeLaunch,
	type SupportedNativeTarget,
} from "../../src/infrastructure/codex-bridge/binary.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
} from "../../src/infrastructure/codex-bridge/protocol.ts";
import { resolveIntegrationBridgeExecutable } from "./helpers/native-bridge.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("packaged sidecar integrity integration", () => {
	test("development override requires an explicit allowDevelopmentBuild flag", async () => {
		const { executable, buildTarget } = await resolveIntegrationBridgeExecutable();
		const packageRoot = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-dev-override-"));
		cleanups.push(async () => {
			await rm(packageRoot, { force: true, recursive: true });
		});

		await expect(
			resolveBundledBridgeLaunch({
				packageRoot,
				clientVersion: "0.0.0",
				buildTarget: buildTarget as SupportedNativeTarget,
				executable,
			}),
		).rejects.toMatchObject({
			name: "BridgeLoaderError",
			code: "development_override_required",
		});

		const client = await connectBundledBridge({
			packageRoot,
			clientVersion: "0.0.0",
			buildTarget: buildTarget as SupportedNativeTarget,
			executable,
			allowDevelopmentBuild: true,
		});
		cleanups.push(async () => {
			await client.shutdown();
		});
		expect(client.isReady).toBe(true);
	});

	test("valid packaged artifact verifies and supplies handshake source identity", async () => {
		const { executable, buildTarget } = await resolveIntegrationBridgeExecutable();
		const packageRoot = await stagePackagedArtifact(
			executable,
			buildTarget as SupportedNativeTarget,
			{
				projectSourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
		);

		// A development binary cannot satisfy a release source commit expectation, but launch
		// resolution must still accept the packaged integrity envelope and pass that commit through.
		const launch = await resolveBundledBridgeLaunch({
			packageRoot,
			clientVersion: "1.0.0",
			buildTarget: buildTarget as SupportedNativeTarget,
		});
		expect(launch.expectedBuildSourceCommit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(basename(launch.executable)).toBe(basename(executable));
	});

	test("tampered packaged binary fails closed before the process is trusted", async () => {
		const { executable, buildTarget } = await resolveIntegrationBridgeExecutable();
		const packageRoot = await stagePackagedArtifact(
			executable,
			buildTarget as SupportedNativeTarget,
			{
				projectSourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				tamperExecutable: true,
			},
		);
		const marker = resolve(packageRoot, "executed.marker");

		await expect(
			connectBundledBridge({
				packageRoot,
				clientVersion: "1.0.0",
				buildTarget: buildTarget as SupportedNativeTarget,
				handshakeTimeoutMs: 1_000,
			}),
		).rejects.toBeInstanceOf(BridgeLoaderError);
		await expect(
			connectBundledBridge({
				packageRoot,
				clientVersion: "1.0.0",
				buildTarget: buildTarget as SupportedNativeTarget,
				handshakeTimeoutMs: 1_000,
			}),
		).rejects.toMatchObject({ code: "artifact_tampered" });
		await expect(Bun.file(marker).exists()).resolves.toBe(false);
	});

	test("missing packaged manifest fails closed", async () => {
		const { buildTarget } = await resolveIntegrationBridgeExecutable();
		const packageRoot = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-missing-manifest-"));
		cleanups.push(async () => {
			await rm(packageRoot, { force: true, recursive: true });
		});
		const directory = resolve(packageRoot, "native", "bin", buildTarget);
		await mkdir(directory, { recursive: true });
		await writeFile(resolve(directory, basenameExecutable(buildTarget)), "not-verified\n");

		await expect(
			resolveBundledBridgeLaunch({
				packageRoot,
				clientVersion: "1.0.0",
				buildTarget: buildTarget as SupportedNativeTarget,
			}),
		).rejects.toMatchObject({ code: "missing_artifact" });
	});

	test("wrong packaged target fails closed", async () => {
		const { executable, buildTarget } = await resolveIntegrationBridgeExecutable();
		const packageRoot = await stagePackagedArtifact(
			executable,
			buildTarget as SupportedNativeTarget,
			{
				projectSourceCommit: "cccccccccccccccccccccccccccccccccccccccc",
				targetOverride: "x86_64-apple-darwin",
			},
		);

		await expect(
			resolveBundledBridgeLaunch({
				packageRoot,
				clientVersion: "1.0.0",
				buildTarget: buildTarget as SupportedNativeTarget,
			}),
		).rejects.toMatchObject({ code: "invalid_artifact" });
	});
});

async function stagePackagedArtifact(
	sourceExecutable: string,
	target: SupportedNativeTarget,
	options: {
		projectSourceCommit: string;
		tamperExecutable?: boolean;
		targetOverride?: string;
	},
): Promise<string> {
	const packageRoot = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-packaged-"));
	cleanups.push(async () => {
		await rm(packageRoot, { force: true, recursive: true });
	});
	const directory = resolve(packageRoot, "native", "bin", target);
	await mkdir(directory, { recursive: true });
	const executableName = basenameExecutable(target);
	const destination = resolve(directory, executableName);
	await copyFile(sourceExecutable, destination);
	await chmod(destination, 0o755);
	const bytes = await readFile(destination);
	const hash = createHash("sha256").update(bytes).digest("hex");
	if (options.tamperExecutable === true) {
		await writeFile(destination, Buffer.concat([bytes, Buffer.from("\n#tampered\n")]));
		await chmod(destination, 0o755);
	}
	const manifest = {
		schemaVersion: 1,
		target: options.targetOverride ?? target,
		executable: executableName,
		executableSize: bytes.byteLength,
		executableSha256: hash,
		projectSourceCommit: options.projectSourceCommit,
		bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
		officialCodexVersion: OFFICIAL_CODEX_VERSION,
		officialCodexTag: OFFICIAL_CODEX_TAG,
		officialSourceCommit: OFFICIAL_SOURCE_COMMIT,
		vendorTreeSha256: VENDOR_TREE_SHA256,
	};
	await writeFile(
		resolve(directory, "native-artifact.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return packageRoot;
}

function basenameExecutable(target: string): string {
	return target === "x86_64-pc-windows-msvc" ? "codex-bridge.exe" : "codex-bridge";
}

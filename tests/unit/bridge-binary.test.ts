import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	BridgeLoaderError,
	resolveBridgeExecutable,
	resolveBundledBridgeLaunch,
	resolveNativeTarget,
	type SupportedNativeTarget,
	verifyPackagedBridgeArtifact,
} from "../../src/infrastructure/codex-bridge/binary.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
} from "../../src/infrastructure/codex-bridge/protocol.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("native bridge binary resolution", () => {
	test.each([
		["linux", "x64", "x86_64-unknown-linux-musl"],
		["linux", "arm64", "aarch64-unknown-linux-musl"],
		["darwin", "x64", "x86_64-apple-darwin"],
		["darwin", "arm64", "aarch64-apple-darwin"],
		["win32", "x64", "x86_64-pc-windows-msvc"],
	] as const)("maps %s/%s to its declared target", (platform, architecture, expected) => {
		expect(resolveNativeTarget(platform, architecture)).toBe(expected);
	});

	test("does not claim unsupported Windows ARM64 delivery", () => {
		expect(() => resolveNativeTarget("win32", "arm64")).toThrow(BridgeLoaderError);
	});

	test("uses a target-scoped executable path", () => {
		expect(resolveBridgeExecutable("/package", "x86_64-unknown-linux-musl")).toBe(
			resolve("/package", "native", "bin", "x86_64-unknown-linux-musl", "codex-bridge"),
		);
		expect(resolveBridgeExecutable("C:\\package", "x86_64-pc-windows-msvc")).toBe(
			resolve("C:\\package", "native", "bin", "x86_64-pc-windows-msvc", "codex-bridge.exe"),
		);
	});
});

describe("packaged sidecar integrity", () => {
	const target: SupportedNativeTarget = "x86_64-unknown-linux-musl";
	const projectSourceCommit = "0123456789abcdef0123456789abcdef01234567";

	test("accepts a valid packaged artifact and returns source identity", async () => {
		const packageRoot = await createPackageRoot();
		const { executablePath, bytes } = await writeExecutable(packageRoot, target, "valid-binary\n");
		await writeManifest(packageRoot, target, {
			executableSize: bytes.byteLength,
			executableSha256: sha256(bytes),
			projectSourceCommit,
		});

		const verified = await verifyPackagedBridgeArtifact(packageRoot, target);
		expect(verified.executablePath).toBe(executablePath);
		expect(verified.manifest.projectSourceCommit).toBe(projectSourceCommit);
		expect(verified.manifest.officialSourceCommit).toBe(OFFICIAL_SOURCE_COMMIT);

		const launch = await resolveBundledBridgeLaunch({
			packageRoot,
			clientVersion: "1.0.0",
			buildTarget: target,
		});
		expect(launch).toEqual({
			executable: executablePath,
			expectedBuildSourceCommit: projectSourceCommit,
		});
	});

	test("fails closed on a missing manifest before any executable is trusted", async () => {
		const packageRoot = await createPackageRoot();
		await writeExecutable(packageRoot, target, "orphan-binary\n");

		await expect(verifyPackagedBridgeArtifact(packageRoot, target)).rejects.toMatchObject({
			name: "BridgeLoaderError",
			code: "missing_artifact",
		});
	});

	test("fails closed when the executable is missing after a present manifest", async () => {
		const packageRoot = await createPackageRoot();
		await writeManifest(packageRoot, target, {
			executableSize: 12,
			executableSha256: "a".repeat(64),
			projectSourceCommit,
		});

		await expect(verifyPackagedBridgeArtifact(packageRoot, target)).rejects.toMatchObject({
			name: "BridgeLoaderError",
			code: "missing_artifact",
		});
	});

	test("fails closed on a tampered executable hash or size", async () => {
		const packageRoot = await createPackageRoot();
		const marker = join(packageRoot, "executed.marker");
		const script = `#!/bin/sh\necho ran > "${marker}"\n`;
		const { bytes } = await writeExecutable(packageRoot, target, script, { executable: true });
		await writeManifest(packageRoot, target, {
			executableSize: bytes.byteLength,
			executableSha256: "b".repeat(64),
			projectSourceCommit,
		});

		await expect(
			resolveBundledBridgeLaunch({
				packageRoot,
				clientVersion: "1.0.0",
				buildTarget: target,
			}),
		).rejects.toMatchObject({
			name: "BridgeLoaderError",
			code: "artifact_tampered",
		});
		await expect(Bun.file(marker).exists()).resolves.toBe(false);
	});

	test("fails closed on wrong target identity", async () => {
		const packageRoot = await createPackageRoot();
		const { bytes } = await writeExecutable(packageRoot, target, "binary\n");
		await writeManifest(packageRoot, target, {
			target: "aarch64-unknown-linux-musl",
			executableSize: bytes.byteLength,
			executableSha256: sha256(bytes),
			projectSourceCommit,
		});

		await expect(verifyPackagedBridgeArtifact(packageRoot, target)).rejects.toMatchObject({
			name: "BridgeLoaderError",
			code: "invalid_artifact",
		});
	});

	test("fails closed on wrong project source commit shape or baseline fields", async () => {
		const packageRoot = await createPackageRoot();
		const { bytes } = await writeExecutable(packageRoot, target, "binary\n");
		const good = {
			executableSize: bytes.byteLength,
			executableSha256: sha256(bytes),
			projectSourceCommit,
		};

		await writeManifest(packageRoot, target, {
			...good,
			projectSourceCommit: "not-a-commit",
		});
		await expect(verifyPackagedBridgeArtifact(packageRoot, target)).rejects.toMatchObject({
			code: "invalid_artifact",
		});

		await writeManifest(packageRoot, target, {
			...good,
			officialCodexVersion: "0.0.0",
		});
		await expect(verifyPackagedBridgeArtifact(packageRoot, target)).rejects.toMatchObject({
			code: "invalid_artifact",
		});

		await writeManifest(packageRoot, target, {
			...good,
			bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION + 1,
		});
		await expect(verifyPackagedBridgeArtifact(packageRoot, target)).rejects.toMatchObject({
			code: "invalid_artifact",
		});
	});

	test("requires allowDevelopmentBuild for executable overrides", async () => {
		const packageRoot = await createPackageRoot();
		const override = resolve(packageRoot, "override-bridge");
		await writeFile(override, "#!/bin/sh\necho override\n");

		await expect(
			resolveBundledBridgeLaunch({
				packageRoot,
				clientVersion: "0.0.0",
				buildTarget: target,
				executable: override,
			}),
		).rejects.toMatchObject({
			name: "BridgeLoaderError",
			code: "development_override_required",
		});

		const launch = await resolveBundledBridgeLaunch({
			packageRoot,
			clientVersion: "0.0.0",
			buildTarget: target,
			executable: override,
			allowDevelopmentBuild: true,
		});
		expect(launch).toEqual({ executable: override });
	});

	test("development override cannot silently replace packaged verification", async () => {
		const packageRoot = await createPackageRoot();
		const { bytes } = await writeExecutable(packageRoot, target, "packaged\n");
		await writeManifest(packageRoot, target, {
			executableSize: bytes.byteLength,
			executableSha256: "c".repeat(64),
			projectSourceCommit,
		});

		// allowDevelopmentBuild alone does not skip packaged integrity checks.
		await expect(
			resolveBundledBridgeLaunch({
				packageRoot,
				clientVersion: "0.0.0",
				buildTarget: target,
				allowDevelopmentBuild: true,
			}),
		).rejects.toMatchObject({
			code: "artifact_tampered",
		});
	});
});

async function createPackageRoot(): Promise<string> {
	const packageRoot = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-artifact-"));
	cleanups.push(async () => {
		await rm(packageRoot, { force: true, recursive: true });
	});
	return packageRoot;
}

async function writeExecutable(
	packageRoot: string,
	target: SupportedNativeTarget,
	contents: string,
	options?: { executable?: boolean },
): Promise<{ executablePath: string; bytes: Buffer }> {
	const directory = resolve(packageRoot, "native", "bin", target);
	await mkdir(directory, { recursive: true });
	const executablePath = resolve(
		directory,
		target === "x86_64-pc-windows-msvc" ? "codex-bridge.exe" : "codex-bridge",
	);
	const bytes = Buffer.from(contents, "utf8");
	await writeFile(executablePath, bytes);
	if (options?.executable === true) {
		await chmod(executablePath, 0o755);
	}
	return { executablePath, bytes };
}

async function writeManifest(
	packageRoot: string,
	target: SupportedNativeTarget,
	overrides: Record<string, unknown>,
): Promise<void> {
	const directory = resolve(packageRoot, "native", "bin", target);
	await mkdir(directory, { recursive: true });
	const manifest = {
		schemaVersion: 1,
		target,
		executable: target === "x86_64-pc-windows-msvc" ? "codex-bridge.exe" : "codex-bridge",
		executableSize: 1,
		executableSha256: "d".repeat(64),
		projectSourceCommit: "0123456789abcdef0123456789abcdef01234567",
		bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
		officialCodexVersion: OFFICIAL_CODEX_VERSION,
		officialCodexTag: OFFICIAL_CODEX_TAG,
		officialSourceCommit: OFFICIAL_SOURCE_COMMIT,
		vendorTreeSha256: VENDOR_TREE_SHA256,
		...overrides,
	};
	await writeFile(
		resolve(directory, "native-artifact.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

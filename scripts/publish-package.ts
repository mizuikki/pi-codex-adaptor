import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_NATIVE_TARGETS } from "../src/infrastructure/codex-bridge/binary.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
} from "../src/infrastructure/codex-bridge/protocol.ts";
import {
	npmDistTagForVersion,
	RELEASE_ARTIFACT_RETENTION_DAYS,
	type ReleaseManifestTarball,
} from "./verify-release.ts";

interface PackResult {
	filename: string;
	files: Array<{ path: string; size: number }>;
	unpackedSize?: number;
}

interface NativeManifest {
	schemaVersion: number;
	target: string;
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

interface ToolchainFixture {
	runtime: {
		biome: string;
		bun: string;
		node: string;
		npm: string;
		pi: string;
		rust: string;
		typebox: string;
		typesNode: string;
		typescript: string;
	};
}

interface ConformanceLock {
	cli: { package: string; version: string; integrity: string };
	sdk: { package: string; version: string; integrity: string };
}

export interface ReleaseManifest {
	schemaVersion: 1;
	package: string;
	version: string;
	projectSourceCommit: string;
	bridgeProtocolVersion: number;
	officialCodexVersion: string;
	officialCodexTag: string;
	officialSourceCommit: string;
	vendorTreeSha256: string;
	npmDistTag: "rc" | "latest";
	toolchain: ToolchainFixture["runtime"];
	conformance: ConformanceLock;
	tarball: ReleaseManifestTarball;
	native: NativeManifest[];
	artifactRetentionDays: number;
}

export function buildReleaseManifest(input: {
	packageName: string;
	version: string;
	sourceCommit: string;
	toolchain: ToolchainFixture["runtime"];
	conformance: ConformanceLock;
	tarball: ReleaseManifestTarball;
	native: NativeManifest[];
}): ReleaseManifest {
	if (input.toolchain.rust !== "1.95.0") {
		throw new Error(
			`Release manifest rust toolchain must be 1.95.0, received ${input.toolchain.rust}`,
		);
	}
	if (input.conformance.cli.version !== OFFICIAL_CODEX_VERSION) {
		throw new Error("Conformance CLI version does not match the official Codex baseline");
	}
	if (input.conformance.sdk.version !== OFFICIAL_CODEX_VERSION) {
		throw new Error("Conformance SDK version does not match the official Codex baseline");
	}

	return {
		schemaVersion: 1,
		package: input.packageName,
		version: input.version,
		projectSourceCommit: input.sourceCommit,
		bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
		officialCodexVersion: OFFICIAL_CODEX_VERSION,
		officialCodexTag: OFFICIAL_CODEX_TAG,
		officialSourceCommit: OFFICIAL_SOURCE_COMMIT,
		vendorTreeSha256: VENDOR_TREE_SHA256,
		npmDistTag: npmDistTagForVersion(input.version),
		toolchain: input.toolchain,
		conformance: input.conformance,
		tarball: input.tarball,
		native: input.native,
		artifactRetentionDays: RELEASE_ARTIFACT_RETENTION_DAYS,
	};
}

export function tarballIntegrity(bytes: Uint8Array | Buffer): ReleaseManifestTarball["integrity"] {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function buildNpmPublishArgs(options: {
	tarballPath: string;
	version: string;
	provenance?: boolean;
}): string[] {
	const args = ["npm", "publish", options.tarballPath, "--access", "public"];
	const tag = npmDistTagForVersion(options.version);
	args.push("--tag", tag);
	if (options.provenance !== false) args.push("--provenance");
	return args;
}

async function main(): Promise<void> {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const packageJson = JSON.parse(
		await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
	) as {
		name: string;
		version: string;
	};
	if (packageJson.name !== "pi-codex-adaptor" || packageJson.version === "0.0.0") {
		throw new Error("A published package must have a non-skeleton package version");
	}

	const nativeArtifactsDir = argument("--native-artifacts-dir");
	if (nativeArtifactsDir === undefined) {
		throw new Error("--native-artifacts-dir is required for release assembly");
	}

	const releaseDirectory = resolve(repositoryRoot, "dist/release");
	await rm(releaseDirectory, { recursive: true, force: true });
	await mkdir(releaseDirectory, { recursive: true });
	await run(["bun", "scripts/assemble-package.ts", "--native-artifacts-dir", nativeArtifactsDir]);

	const packOutput = await run([
		"npm",
		"pack",
		"./dist/package",
		"--json",
		"--pack-destination",
		releaseDirectory,
	]);
	const packResult = parsePackResult(packOutput);
	const tarball = resolve(releaseDirectory, packResult.filename);
	await run([
		"bun",
		"scripts/verify-package.ts",
		"--tarball",
		tarball,
		"--require-native",
		"--smoke-install",
	]);

	const sourceCommit = (await run(["git", "rev-parse", "HEAD"])).trim();
	if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
		throw new Error("Unable to resolve release source commit");
	}
	const native = await collectNativeManifests(repositoryRoot, sourceCommit);
	const tarballBytes = await readFile(tarball);
	const toolchain = await readToolchain(repositoryRoot);
	const conformance = await readConformance(repositoryRoot);
	const manifest = buildReleaseManifest({
		packageName: packageJson.name,
		version: packageJson.version,
		sourceCommit,
		toolchain,
		conformance,
		tarball: {
			filename: packResult.filename,
			size: tarballBytes.byteLength,
			sha256: createHash("sha256").update(tarballBytes).digest("hex"),
			integrity: tarballIntegrity(tarballBytes),
		},
		native,
	});
	const manifestPath = resolve(releaseDirectory, "release-manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(JSON.stringify({ ...manifest, tarballPath: tarball, manifestPath }, null, 2));

	if (process.argv.includes("--prepare-only")) process.exit(0);

	const publishArgs = buildNpmPublishArgs({
		tarballPath: tarball,
		version: packageJson.version,
	});
	await run(publishArgs);
	console.log(
		JSON.stringify({
			published: true,
			version: packageJson.version,
			npmDistTag: manifest.npmDistTag,
			tarball,
		}),
	);
}

async function collectNativeManifests(
	repositoryRoot: string,
	sourceCommit: string,
): Promise<NativeManifest[]> {
	const root = resolve(repositoryRoot, "dist/package/native/bin");
	const targets = (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const expected = [...SUPPORTED_NATIVE_TARGETS].sort();
	if (JSON.stringify(targets) !== JSON.stringify(expected)) {
		throw new Error(
			`Release package targets ${targets.join(", ")} do not match ${expected.join(", ")}`,
		);
	}

	const manifests: NativeManifest[] = [];
	for (const target of targets) {
		const path = resolve(root, target, "native-artifact.json");
		const value = JSON.parse(await readFile(path, "utf8")) as NativeManifest;
		const executablePath = resolve(root, target, value.executable);
		const bytes = await readFile(executablePath);
		if (
			value.schemaVersion !== 1 ||
			value.target !== target ||
			value.executableSize !== bytes.byteLength ||
			value.executableSha256 !== createHash("sha256").update(bytes).digest("hex") ||
			value.projectSourceCommit !== sourceCommit ||
			value.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION ||
			value.officialCodexVersion !== OFFICIAL_CODEX_VERSION ||
			value.officialCodexTag !== OFFICIAL_CODEX_TAG ||
			value.officialSourceCommit !== OFFICIAL_SOURCE_COMMIT ||
			value.vendorTreeSha256 !== VENDOR_TREE_SHA256
		) {
			throw new Error(`Native manifest identity is invalid for ${target}`);
		}
		manifests.push(value);
	}
	return manifests;
}

async function readToolchain(repositoryRoot: string): Promise<ToolchainFixture["runtime"]> {
	const fixture = JSON.parse(
		await readFile(resolve(repositoryRoot, "fixtures/toolchain.json"), "utf8"),
	) as ToolchainFixture;
	return fixture.runtime;
}

async function readConformance(repositoryRoot: string): Promise<ConformanceLock> {
	const text = await readFile(resolve(repositoryRoot, "UPSTREAM_CODEX.toml"), "utf8");
	const cli = {
		package: sectionField(text, "conformance.cli", "package") ?? "@openai/codex",
		version: sectionField(text, "conformance.cli", "version") ?? "",
		integrity: sectionField(text, "conformance.cli", "integrity") ?? "",
	};
	const sdk = {
		package: sectionField(text, "conformance.sdk", "package") ?? "@openai/codex-sdk",
		version: sectionField(text, "conformance.sdk", "version") ?? "",
		integrity: sectionField(text, "conformance.sdk", "integrity") ?? "",
	};
	if (!cli.version || !cli.integrity || !sdk.version || !sdk.integrity) {
		throw new Error("UPSTREAM_CODEX.toml is missing conformance lock fields");
	}
	return { cli, sdk };
}

function sectionField(text: string, section: string, field: string): string | undefined {
	const sectionPattern = new RegExp(
		`\\[${section.replaceAll(".", "\\.")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
	);
	const body = sectionPattern.exec(text)?.[1];
	if (body === undefined) return undefined;
	const fieldPattern = new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, "m");
	return fieldPattern.exec(body)?.[1];
}

function parsePackResult(output: string): PackResult {
	const parsed = JSON.parse(output) as PackResult[] | Record<string, PackResult>;
	const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (result === undefined || typeof result.filename !== "string") {
		throw new Error("npm pack returned no tarball");
	}
	return result;
}

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, {
		cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
		stderr: "inherit",
		stdout: "pipe",
	});
	const output = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
	return output;
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

if (import.meta.main) {
	await main();
}

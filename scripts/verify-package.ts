import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_NATIVE_TARGETS } from "../src/infrastructure/codex-bridge/identity.ts";

interface PackFile {
	path: string;
	size: number;
}

interface PackResult {
	files: PackFile[];
	filename?: string;
	unpackedSize?: number;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piSdkPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

export function normalizePackagePath(path: string): string {
	return path.startsWith("package/") ? path.slice("package/".length) : path;
}

export function unexpectedPackagePaths(
	paths: readonly string[],
	allowedPaths: readonly RegExp[],
): string[] {
	return paths.filter((path) => !allowedPaths.some((pattern) => pattern.test(path)));
}

export const PACKAGE_PATH_ALLOWLIST = [
	/^LICENSE$/,
	/^README\.md$/,
	/^package\.json$/,
	/^src\/.+\.(?:md|ts)$/,
	/^native\/bin\/[a-zA-Z0-9._-]+\/(?:codex-bridge(?:\.exe)?|native-artifact\.json)$/,
] as const;

export const REQUIRED_PACKAGE_FILES = [
	"LICENSE",
	"README.md",
	"package.json",
	"src/extension.ts",
] as const;

async function main(): Promise<void> {
	const tarball = argument("--tarball");
	const nativeArtifactsDir = argument("--native-artifacts-dir");
	const requireNative = process.argv.includes("--require-native");
	const smokeInstall = process.argv.includes("--smoke-install");
	const runCleanConsumerFixtures = tarball === undefined || smokeInstall;
	const fixtureRoot = runCleanConsumerFixtures
		? await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pack-verify-"))
		: undefined;

	try {
		await runBunScript([
			"scripts/assemble-package.ts",
			...(nativeArtifactsDir === undefined ? [] : ["--native-artifacts-dir", nativeArtifactsDir]),
		]);

		const packOutput = await run(["npm", "pack", "./dist/package", "--dry-run", "--json"]);
		const result = parsePackResult(packOutput);
		const paths = result.files.map((file) => normalizePackagePath(file.path));
		const unexpected = unexpectedPackagePaths(paths, PACKAGE_PATH_ALLOWLIST);
		if (unexpected.length > 0) {
			throw new Error(`Unexpected npm package files: ${unexpected.join(", ")}`);
		}

		for (const requiredFile of REQUIRED_PACKAGE_FILES) {
			if (!paths.includes(requiredFile)) {
				throw new Error(`Required npm package file is missing: ${requiredFile}`);
			}
		}

		const packageJson = JSON.parse(
			await readFile(resolve(repositoryRoot, "dist/package/package.json"), "utf8"),
		) as {
			dependencies?: Record<string, unknown>;
			name?: unknown;
			peerDependencies?: Record<string, unknown>;
			version?: unknown;
		};
		if (packageJson.name !== "pi-codex-adaptor" || typeof packageJson.version !== "string") {
			throw new Error("Staged package metadata is invalid");
		}
		for (const packageName of piSdkPackages) {
			if (packageJson.peerDependencies?.[packageName] !== "*") {
				throw new Error(
					`Staged package must declare ${packageName} as a host-provided wildcard peer`,
				);
			}
			if (packageJson.dependencies?.[packageName] !== undefined) {
				throw new Error(
					`Staged package must not include ${packageName} as a production dependency`,
				);
			}
		}

		const nativeFiles = paths.filter((path) => path.startsWith("native/bin/"));
		if (requireNative && !hasCompleteNativeArtifact(nativeFiles)) {
			throw new Error("Release package must contain native bridge artifacts");
		}
		let exactTarball: string;
		if (tarball === undefined) {
			if (fixtureRoot === undefined) throw new Error("Clean consumer fixture root is unavailable");
			exactTarball = await packStagedTarball(resolve(fixtureRoot, "adaptor-tarball"));
		} else {
			exactTarball = resolve(tarball);
		}
		const tarballResult = await verifyTarball(exactTarball, paths);
		const maximumUnpackedSize = requireNative ? 250 * 1024 * 1024 : 5 * 1024 * 1024;
		const unpackedSize =
			tarballResult.unpackedSize ?? tarballResult.files.reduce((sum, file) => sum + file.size, 0);
		if (unpackedSize > maximumUnpackedSize) {
			throw new Error(`Package is too large: ${unpackedSize} bytes`);
		}
		if (runCleanConsumerFixtures) {
			if (fixtureRoot === undefined) throw new Error("Clean consumer fixture root is unavailable");
			await smokeInstallManifestTarball(exactTarball, fixtureRoot);
			await smokeInstallExactTarball(exactTarball);
		}

		console.log(
			JSON.stringify(
				{
					files: result.files.length,
					unpackedSize,
					native: nativeFiles.length > 0,
					smokeInstall: runCleanConsumerFixtures,
					...(tarball === undefined ? {} : { tarball: resolve(tarball) }),
				},
				null,
				2,
			),
		);
	} finally {
		if (fixtureRoot !== undefined) await rm(fixtureRoot, { force: true, recursive: true });
	}
}

async function packStagedTarball(destination: string): Promise<string> {
	await mkdir(destination, { recursive: true });
	const output = await run([
		"npm",
		"pack",
		"./dist/package",
		"--json",
		"--ignore-scripts",
		"--pack-destination",
		destination,
	]);
	const filename = parsePackResult(output).filename;
	if (typeof filename !== "string")
		throw new Error("npm pack returned no adaptor tarball filename");
	return resolve(destination, filename);
}

async function smokeInstallManifestTarball(
	tarballPath: string,
	fixtureRoot: string,
): Promise<void> {
	const piDirectory = resolve(process.env.PI_FORK_DIR ?? join(repositoryRoot, "../pi"));
	const piRef = process.env.PI_EXTENSION_SDK_REF ?? process.env.PI_FORK_REF ?? "HEAD";
	const piFixture = resolve(fixtureRoot, "pi-fixture");
	const consumerDirectory = resolve(fixtureRoot, "manifest-consumer");
	const helper = resolve(piDirectory, "scripts/local-fork-fixture.mjs");
	await run([process.execPath, helper, "prepare", "--out", piFixture, "--ref", piRef]);
	await run([
		process.execPath,
		helper,
		"create-consumer",
		"--manifest",
		resolve(piFixture, "pi-sdk-manifest.json"),
		"--directory",
		consumerDirectory,
		"--dependency",
		`pi-codex-adaptor=file:${tarballPath}`,
	]);

	const packageRoot = resolve(consumerDirectory, "node_modules", "pi-codex-adaptor");
	const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
		name?: unknown;
		pi?: { extensions?: unknown[] };
	};
	if (metadata.name !== "pi-codex-adaptor")
		throw new Error("Manifest consumer installed an unexpected package");
	const extensionPath = await resolveInstalledPackageExtension(
		packageRoot,
		metadata.pi?.extensions,
	);
	await installPoisonPackages(packageRoot);
	const loaderProbe = resolve(consumerDirectory, "verify-private-host.mjs");
	await writeFile(
		loaderProbe,
		[
			'import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";',
			"const extensionPath = process.argv[2];",
			"const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), process.env.HOME);",
			'if (result.errors.length > 0 || result.extensions.length !== 1) throw new Error(result.errors.map((entry) => entry.error).join("; "));',
		].join("\n"),
	);
	const piHome = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-private-host-"));
	try {
		await run([process.execPath, loaderProbe, extensionPath], {
			cwd: consumerDirectory,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: piHome,
				PI_OFFLINE: "1",
				HOME: piHome,
				CODEX_HOME: resolve(piHome, "codex-home"),
			},
		});
	} finally {
		await rm(piHome, { force: true, recursive: true });
	}
}

async function installPoisonPackages(packageRoot: string): Promise<void> {
	for (const packageName of piSdkPackages) {
		const packageDirectory = resolve(packageRoot, "node_modules", packageName);
		await mkdir(packageDirectory, { recursive: true });
		await Bun.write(
			resolve(packageDirectory, "package.json"),
			`${JSON.stringify({ name: packageName, type: "module", exports: "./index.js" })}\n`,
		);
		await Bun.write(
			resolve(packageDirectory, "index.js"),
			`throw new Error(${JSON.stringify(`poison package imported: ${packageName}`)});\n`,
		);
	}
}

async function smokeInstallExactTarball(tarballPath: string): Promise<void> {
	const installRoot = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pack-"));
	const piHome = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pi-home-"));
	try {
		await run([
			"npm",
			"install",
			"@earendil-works/pi-agent-core@0.81.1",
			"@earendil-works/pi-ai@0.81.1",
			"@earendil-works/pi-coding-agent@0.81.1",
			"@earendil-works/pi-tui@0.81.1",
			"typebox@1.3.6",
			"--prefix",
			installRoot,
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--no-fund",
			"--no-audit",
		]);
		await run([
			"npm",
			"install",
			tarballPath,
			"--prefix",
			installRoot,
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--no-fund",
			"--no-audit",
		]);
		const installedPackageJson = resolve(
			installRoot,
			"node_modules",
			"pi-codex-adaptor",
			"package.json",
		);
		const metadata = JSON.parse(await readFile(installedPackageJson, "utf8")) as {
			name?: unknown;
			version?: unknown;
			pi?: { extensions?: unknown[] };
		};
		if (metadata.name !== "pi-codex-adaptor" || typeof metadata.version !== "string") {
			throw new Error("Clean install did not produce the expected package metadata");
		}
		const packageRoot = resolve(installRoot, "node_modules", "pi-codex-adaptor");
		const extensionPath = await resolveInstalledPackageExtension(
			packageRoot,
			metadata.pi?.extensions,
		);
		const loaderProbe = resolve(installRoot, "verify-upstream-host.mjs");
		await writeFile(
			loaderProbe,
			[
				'import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";',
				"const extensionPath = process.argv[2];",
				"const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), process.env.HOME);",
				'if (result.errors.length > 0) throw new Error(result.errors.map((entry) => entry.error).join("; "));',
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, loaderProbe, extensionPath], {
			cwd: installRoot,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: piHome,
				PI_OFFLINE: "1",
				HOME: piHome,
				CODEX_HOME: resolve(piHome, "codex-home"),
			},
			stderr: "pipe",
			stdout: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		assertIncompatiblePiHostRejected(exitCode, stderr);
	} finally {
		await rm(installRoot, { force: true, recursive: true });
		await rm(piHome, { force: true, recursive: true });
	}
}

export function assertIncompatiblePiHostRejected(exitCode: number, stderr: string): void {
	if (
		stderr.includes("Pi host is incompatible: requires extension SDK API version 1") &&
		exitCode !== 0
	) {
		return;
	}
	throw new Error(
		`Exact-tarball clean install did not reject the incompatible Pi host (status ${exitCode})`,
	);
}

async function verifyTarball(path: string, expectedPaths: readonly string[]): Promise<PackResult> {
	const actualResult = parsePackResult(await run(["npm", "pack", path, "--dry-run", "--json"]));
	const actual = actualResult.files.map((file) => normalizePackagePath(file.path)).sort();
	const expected = [...expectedPaths].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error("Exact tarball file list differs from the verified staging file list");
	}
	const bytes = await readFile(path);
	console.log(`Tarball SHA-256: ${createHash("sha256").update(bytes).digest("hex")}`);
	return actualResult;
}

export function hasCompleteNativeArtifact(paths: readonly string[]): boolean {
	const supportedTargets = new Set<string>(SUPPORTED_NATIVE_TARGETS);
	const targets = new Map<string, Set<string>>();
	for (const path of paths) {
		const match = /^native\/bin\/([^/]+)\/(codex-bridge(?:\.exe)?|native-artifact\.json)$/.exec(
			path,
		);
		if (match === null) continue;
		const target = match[1];
		const file = match[2];
		if (target === undefined || file === undefined || !supportedTargets.has(target)) continue;
		const files = targets.get(target) ?? new Set<string>();
		files.add(file);
		targets.set(target, files);
	}
	return [...targets].some(([target, files]) => {
		const executable = target.includes("windows") ? "codex-bridge.exe" : "codex-bridge";
		return files.has("native-artifact.json") && files.has(executable);
	});
}

export function resolveDeclaredPackageExtension(packageRoot: string, entries: unknown): string {
	if (!Array.isArray(entries) || entries.length !== 1) {
		throw new Error("Installed package must declare exactly one Pi extension entry");
	}
	return resolvePackageExtension(packageRoot, entries[0]);
}

export async function resolveInstalledPackageExtension(
	packageRoot: string,
	entries: unknown,
): Promise<string> {
	const extension = resolveDeclaredPackageExtension(packageRoot, entries);
	const [realRoot, realExtension] = await Promise.all([realpath(packageRoot), realpath(extension)]);
	const relativePath = relative(realRoot, realExtension);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error("Installed Pi extension entry escapes the package root");
	}
	return realExtension;
}

export function resolvePackageExtension(packageRoot: string, entry: unknown): string {
	if (
		typeof entry !== "string" ||
		entry.length === 0 ||
		entry !== entry.trim() ||
		entry.includes("\\") ||
		entry.includes("\0") ||
		/^[A-Za-z]:/.test(entry)
	) {
		throw new Error("Installed package does not declare a valid Pi extension entry");
	}
	const root = resolve(packageRoot);
	const extension = resolve(root, entry);
	const relativePath = relative(root, extension);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new Error("Installed Pi extension entry escapes the package root");
	}
	return extension;
}

function parsePackResult(output: string): PackResult {
	const parsed = JSON.parse(output) as PackResult[] | Record<string, PackResult>;
	const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (result === undefined || !Array.isArray(result.files)) {
		throw new Error("npm pack returned no package result");
	}
	return result;
}

async function runBunScript(args: string[]): Promise<void> {
	await run(["bun", ...args]);
}

async function run(
	command: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	const child = Bun.spawn(command, {
		cwd: options.cwd ?? repositoryRoot,
		...(options.env === undefined ? {} : { env: options.env }),
		stderr: "pipe",
		stdout: "pipe",
	});
	const [output, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
		new Response(child.stderr).text(),
	]);
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

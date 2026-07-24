import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

	if (nativeArtifactsDir !== undefined || !tarball) {
		await runBunScript([
			"scripts/assemble-package.ts",
			...(nativeArtifactsDir === undefined ? [] : ["--native-artifacts-dir", nativeArtifactsDir]),
		]);
	}

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
		name?: unknown;
		version?: unknown;
	};
	if (packageJson.name !== "pi-codex-adaptor" || typeof packageJson.version !== "string") {
		throw new Error("Staged package metadata is invalid");
	}

	const nativeFiles = paths.filter((path) => path.startsWith("native/bin/"));
	if (requireNative && !hasCompleteNativeArtifact(nativeFiles)) {
		throw new Error("Release package must contain native bridge artifacts");
	}
	const tarballResult =
		tarball === undefined ? undefined : await verifyTarball(resolve(tarball), paths);
	const maximumUnpackedSize = requireNative ? 250 * 1024 * 1024 : 5 * 1024 * 1024;
	const unpackedSize =
		tarballResult?.unpackedSize ??
		tarballResult?.files.reduce((sum, file) => sum + file.size, 0) ??
		result.unpackedSize ??
		result.files.reduce((sum, file) => sum + file.size, 0);
	if (unpackedSize > maximumUnpackedSize) {
		throw new Error(`Package is too large: ${unpackedSize} bytes`);
	}
	if (tarball !== undefined && smokeInstall) {
		await smokeInstallExactTarball(resolve(tarball));
	}

	console.log(
		JSON.stringify(
			{
				files: result.files.length,
				unpackedSize,
				native: nativeFiles.length > 0,
				smokeInstall: Boolean(tarball && smokeInstall),
				...(tarball === undefined ? {} : { tarball: resolve(tarball) }),
			},
			null,
			2,
		),
	);
}

async function smokeInstallExactTarball(tarballPath: string): Promise<void> {
	const installRoot = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pack-"));
	const piHome = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pi-home-"));
	try {
		await run([
			"npm",
			"install",
			tarballPath,
			"--prefix",
			installRoot,
			"--ignore-scripts",
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
		const loaderProbe = resolve(
			repositoryRoot,
			"tests/smoke/helpers/verify-packed-tool-provenance.ts",
		);
		const child = Bun.spawn([process.execPath, loaderProbe, extensionPath], {
			cwd: repositoryRoot,
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
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (
			!stderr.includes(
				"Pi host is incompatible: requires provider payload compaction API version 1",
			) ||
			exitCode === 0
		) {
			throw new Error(
				`Exact-tarball clean install did not reject the transaction-less Pi host with status ${exitCode}: ${stderr.trim()}`,
			);
		}
	} finally {
		await rm(installRoot, { force: true, recursive: true });
		await rm(piHome, { force: true, recursive: true });
	}
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

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { cwd: repositoryRoot, stderr: "inherit", stdout: "pipe" });
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

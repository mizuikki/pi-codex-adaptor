import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
	if (requireNative && nativeFiles.length === 0) {
		throw new Error("Release package must contain native bridge artifacts");
	}
	if (tarball !== undefined) await verifyTarball(resolve(tarball), paths);
	if (tarball !== undefined && smokeInstall) {
		await smokeInstallExactTarball(resolve(tarball));
	}

	const maximumUnpackedSize = requireNative ? 250 * 1024 * 1024 : 5 * 1024 * 1024;
	const unpackedSize =
		result.unpackedSize ?? result.files.reduce((sum, file) => sum + file.size, 0);
	if (unpackedSize > maximumUnpackedSize) {
		throw new Error(`Package is too large: ${unpackedSize} bytes`);
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
			pi?: { extensions?: string[] };
		};
		if (metadata.name !== "pi-codex-adaptor" || typeof metadata.version !== "string") {
			throw new Error("Clean install did not produce the expected package metadata");
		}
		const extensionEntry = metadata.pi?.extensions?.[0];
		if (extensionEntry === undefined) {
			throw new Error("Installed package does not declare a Pi extension entry");
		}
		const extensionPath = resolve(installRoot, "node_modules", "pi-codex-adaptor", extensionEntry);
		const piCli = resolve(
			repositoryRoot,
			"node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		);
		const child = Bun.spawn(
			[
				process.execPath,
				piCli,
				"--offline",
				"--no-session",
				"--no-tools",
				"--no-extensions",
				"--extension",
				extensionPath,
				"--list-models",
				"__pi_codex_adaptor_pack_smoke__",
			],
			{
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
			},
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (stderr.includes("Failed to load extension") || exitCode !== 0) {
			throw new Error(
				`Exact-tarball clean install smoke failed with status ${exitCode}: ${stderr.trim()}`,
			);
		}
	} finally {
		await rm(installRoot, { force: true, recursive: true });
		await rm(piHome, { force: true, recursive: true });
	}
}

async function verifyTarball(path: string, expectedPaths: readonly string[]): Promise<void> {
	const listing = await run(["tar", "-tzf", path]);
	const actual = listing
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => (value.startsWith("package/") ? value.slice("package/".length) : value))
		.filter((value) => !value.endsWith("/"))
		.sort();
	const expected = [...expectedPaths].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error("Exact tarball file list differs from the verified staging file list");
	}
	const bytes = await readFile(path);
	console.log(`Tarball SHA-256: ${createHash("sha256").update(bytes).digest("hex")}`);
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

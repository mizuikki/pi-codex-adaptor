import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
	expectedExecutableName,
	verifyPackagedBridgeArtifact,
} from "../src/infrastructure/codex-bridge/binary.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	nativeTargetFor,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	SUPPORTED_NATIVE_TARGETS,
	type SupportedNativeTarget,
} from "../src/infrastructure/codex-bridge/identity.ts";

export interface LocalNativeOptions {
	target: SupportedNativeTarget;
	profile: "debug" | "release";
	checkOnly: boolean;
}

export interface LocalNativePaths {
	executable: string;
	assembledArtifact: string;
	installedArtifact: string;
}

const repositoryRoot = resolve(import.meta.dir, "..");

export function parseLocalNativeOptions(
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	architecture: string = process.arch,
): LocalNativeOptions {
	let target: SupportedNativeTarget | undefined;
	let profile: LocalNativeOptions["profile"] = "release";
	let checkOnly = false;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		switch (argument) {
			case "--debug":
				profile = "debug";
				break;
			case "--check":
				checkOnly = true;
				break;
			case "--target": {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("--")) {
					throw new Error("--target requires a supported Rust target triple");
				}
				if (!(SUPPORTED_NATIVE_TARGETS as readonly string[]).includes(value)) {
					throw new Error(`Unsupported native build target: ${value}`);
				}
				target = value as SupportedNativeTarget;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unknown local native option: ${argument}`);
		}
	}

	const resolvedTarget = target ?? nativeTargetFor(platform, architecture);
	if (resolvedTarget === undefined) {
		throw new Error(`Unsupported native build target: ${platform}/${architecture}`);
	}
	if (checkOnly && profile === "debug") {
		throw new Error("--check cannot be combined with --debug");
	}
	return { target: resolvedTarget, profile, checkOnly };
}

export function resolveLocalNativePaths(
	root: string,
	options: Pick<LocalNativeOptions, "target" | "profile">,
): LocalNativePaths {
	const executableName = expectedExecutableName(options.target);
	return {
		executable: resolve(root, "native", "target", options.target, options.profile, executableName),
		assembledArtifact: resolve(root, "native", "artifacts", options.target),
		installedArtifact: resolve(root, "native", "bin", options.target),
	};
}

export async function replaceArtifactDirectory(
	source: string,
	destination: string,
	verify: () => Promise<void>,
): Promise<void> {
	const parent = dirname(destination);
	const name = basename(destination);
	const suffix = `${process.pid}-${randomUUID()}`;
	const staging = resolve(parent, `.${name}.staging-${suffix}`);
	const backup = resolve(parent, `.${name}.backup-${suffix}`);
	let movedPrevious = false;
	let installed = false;

	await mkdir(parent, { recursive: true });
	try {
		await cp(source, staging, { recursive: true, errorOnExist: true });
		if (await pathExists(destination)) {
			await rename(destination, backup);
			movedPrevious = true;
		}
		await rename(staging, destination);
		installed = true;
		await verify();
		if (movedPrevious) await rm(backup, { recursive: true, force: true });
	} catch (error) {
		try {
			if (installed) await rm(destination, { recursive: true, force: true });
			if (movedPrevious) await rename(backup, destination);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"Local native deployment failed and could not restore the previous artifact",
			);
		}
		throw error;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	if (process.argv.includes("--help")) {
		printHelp();
		return;
	}
	const options = parseLocalNativeOptions(process.argv.slice(2));
	const sourceCommit = await gitHead();
	const paths = resolveLocalNativePaths(repositoryRoot, options);

	if (!options.checkOnly) {
		await run([
			process.execPath,
			"scripts/build-native.ts",
			...(options.profile === "release" ? ["--release"] : []),
			"--target",
			options.target,
		]);
		await run([
			process.execPath,
			"scripts/assemble-native-artifact.ts",
			"--target",
			options.target,
			"--executable",
			paths.executable,
			"--source-commit",
			sourceCommit,
		]);
		await replaceArtifactDirectory(paths.assembledArtifact, paths.installedArtifact, async () => {
			await verifyLocalArtifact(options.target, sourceCommit);
		});
	} else {
		await verifyLocalArtifact(options.target, sourceCommit);
	}

	console.log(
		options.checkOnly
			? `Verified local native artifact for ${options.target} at ${paths.installedArtifact}`
			: `Installed local ${options.profile} native artifact for ${options.target} at ${paths.installedArtifact}`,
	);
}

async function verifyLocalArtifact(
	target: SupportedNativeTarget,
	sourceCommit: string,
): Promise<void> {
	const verified = await verifyPackagedBridgeArtifact(repositoryRoot, target);
	if (verified.manifest.projectSourceCommit !== sourceCommit) {
		throw new Error("Local native artifact does not match the current source commit");
	}
	if (target !== nativeTargetFor(process.platform, process.arch)) {
		console.log(`Runtime identity check skipped for cross target ${target}`);
		return;
	}
	const version = await executableVersion(verified.executablePath);
	const match =
		/^codex-bridge\s+\S+\s+\(protocol\s+(\d+),\s+codex\s+([^,]+),\s+source\s+([0-9a-f]{40}),\s+target\s+([^,]+),\s+build\s+([0-9a-f]{40})\)$/.exec(
			version,
		);
	if (
		match === null ||
		Number(match[1]) !== BRIDGE_PROTOCOL_VERSION ||
		match[2] !== OFFICIAL_CODEX_VERSION ||
		match[3] !== OFFICIAL_SOURCE_COMMIT ||
		match[4] !== target ||
		match[5] !== sourceCommit
	) {
		throw new Error("Local native executable identity does not match its artifact manifest");
	}
}

async function executableVersion(executable: string): Promise<string> {
	const child = Bun.spawn([executable, "--version"], {
		cwd: repositoryRoot,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	if (exitCode !== 0) throw new Error("Local native executable did not report its identity");
	return stdout.trim();
}

async function gitHead(): Promise<string> {
	const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	const sourceCommit = stdout.trim();
	if (exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
		throw new Error("Current Git source commit is unavailable");
	}
	return sourceCommit;
}

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, {
		cwd: repositoryRoot,
		stderr: "inherit",
		stdout: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0)
		throw new Error(
			`${basename(command[1] ?? command[0] ?? "command")} exited with status ${exitCode}`,
		);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function printHelp(): void {
	console.log(`Usage: bun run native:local -- [options]

Build, assemble, transactionally install, and verify the local native bridge.

Options:
  --debug            Build and install the debug profile instead of release
  --target <triple>  Build a declared target instead of the current host target
  --check            Verify the installed artifact without rebuilding it
  --help             Show this help`);
}

if (import.meta.main) {
	await main();
}

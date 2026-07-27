import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ForkOptions {
	readonly piDir: string;
	readonly piRef: string;
	readonly keepTemp: boolean;
}

interface PackedPiSdk {
	readonly forkCommit: string;
	readonly manifestPath: string;
	readonly sdkVersion: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piPackages = [
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
] as const;
const focusedTests = [
	"tests/smoke/pi-fork-provenance.test.ts",
	"tests/smoke/tool-surface.test.ts",
	"tests/unit/compaction-checkpoint.test.ts",
	"tests/unit/codex-provider-request-guard.test.ts",
	"tests/unit/provider-session-router.test.ts",
	"tests/unit/codex-tool-profile.test.ts",
] as const;

async function main(): Promise<void> {
	if (process.argv.includes("--help")) {
		printHelp();
		return;
	}

	const options = parseOptions(process.argv.slice(2));
	const tempRoot = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pi-fork-"));
	let succeeded = false;
	try {
		const sdk = await packLocalSdk(options, tempRoot);
		console.log(`Pi fork commit: ${sdk.forkCommit} (${options.piRef})`);
		const tarballDirectory = resolve(tempRoot, "tarballs");
		const projectDirectory = resolve(tempRoot, "project");
		await copyProject(projectDirectory, tempRoot);
		await verifyPiLocalInstall(resolve(tempRoot, "pi"), tempRoot, projectDirectory);
		await installForkConsumer(projectDirectory, sdk.manifestPath, options.piDir);
		const adaptorTarball = await assembleAndPackAdaptor(projectDirectory, tarballDirectory);
		await verifyPackagedAdaptorConsumer(tempRoot, sdk.manifestPath, adaptorTarball, options.piDir);
		await runFocusedTests(projectDirectory, sdk.forkCommit, sdk.sdkVersion);
		succeeded = true;
		console.log(`Pi fork compatibility passed: ${sdk.forkCommit}`);
	} finally {
		if (succeeded || !options.keepTemp) {
			await rm(tempRoot, { force: true, recursive: true });
		} else {
			console.error(`Pi fork compatibility failed; temporary directory retained at ${tempRoot}`);
		}
	}
}

function parseOptions(args: readonly string[]): ForkOptions {
	let piDir: string | undefined;
	let piRef: string | undefined;
	let keepTemp = false;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		switch (argument) {
			case "--pi-dir":
				piDir = requiredValue(args, index, argument);
				index += 1;
				break;
			case "--pi-ref":
				piRef = requiredValue(args, index, argument);
				index += 1;
				break;
			case "--keep-temp":
				keepTemp = true;
				break;
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}

	if (piDir === undefined || piRef === undefined) {
		throw new Error("--pi-dir and --pi-ref are required");
	}
	return { piDir: resolve(piDir), piRef, keepTemp };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

async function packLocalSdk(options: ForkOptions, tempRoot: string): Promise<PackedPiSdk> {
	await run("node", [
		resolve(options.piDir, "scripts/local-fork-fixture.mjs"),
		"prepare",
		"--out",
		tempRoot,
		"--ref",
		options.piRef,
	]);
	const manifest = JSON.parse(
		await readFile(resolve(tempRoot, "pi-sdk-manifest.json"), "utf8"),
	) as {
		forkCommit?: unknown;
		sdkVersion?: unknown;
		capabilities?: {
			extensionSdkApiVersion?: unknown;
			providerPayloadCompactionApiVersion?: unknown;
			providerCheckpointCommitApiVersion?: unknown;
			compactionFailureResultApiVersion?: unknown;
		};
		packages?: { name?: unknown; path?: unknown; sha256?: unknown; version?: unknown }[];
	};
	if (
		typeof manifest.forkCommit !== "string" ||
		typeof manifest.sdkVersion !== "string" ||
		manifest.capabilities?.extensionSdkApiVersion !== 1 ||
		manifest.capabilities?.providerPayloadCompactionApiVersion !== 1 ||
		manifest.capabilities?.providerCheckpointCommitApiVersion !== 1 ||
		manifest.capabilities?.compactionFailureResultApiVersion !== 1 ||
		manifest.packages?.length !== piPackages.length
	) {
		throw new Error("Pi SDK manifest has an invalid commit, capability level, or package count");
	}
	const packageNames = await Promise.all(
		manifest.packages.map(async (entry): Promise<(typeof piPackages)[number]> => {
			if (
				typeof entry.name !== "string" ||
				!piPackages.includes(entry.name as (typeof piPackages)[number]) ||
				entry.version !== manifest.sdkVersion ||
				typeof entry.path !== "string" ||
				typeof entry.sha256 !== "string"
			) {
				throw new Error("Pi SDK manifest contains an invalid package entry");
			}
			const tarball = resolve(tempRoot, entry.path);
			const relativeTarball = relative(tempRoot, tarball);
			if (relativeTarball.startsWith("..") || isAbsolute(relativeTarball)) {
				throw new Error("Pi SDK manifest package path escapes the fixture directory");
			}
			const digest = new Bun.CryptoHasher("sha256").update(await readFile(tarball)).digest("hex");
			if (digest !== entry.sha256) throw new Error(`Pi SDK digest mismatch: ${entry.name}`);
			return entry.name as (typeof piPackages)[number];
		}),
	);
	if (new Set(packageNames).size !== piPackages.length) {
		throw new Error("Pi SDK manifest contains duplicate packages");
	}
	return {
		forkCommit: manifest.forkCommit,
		manifestPath: resolve(tempRoot, "pi-sdk-manifest.json"),
		sdkVersion: manifest.sdkVersion,
	};
}

async function copyProject(projectDirectory: string, tempRoot: string): Promise<void> {
	const archive = resolve(tempRoot, "adaptor.tar");
	await mkdir(projectDirectory, { recursive: true });
	await run("tar", [
		"--exclude=./.git",
		"--exclude=./bun.lock",
		"--exclude=./dist",
		"--exclude=./native/artifacts",
		"--exclude=./native/bin",
		"--exclude=./native/official/target",
		"--exclude=./native/target",
		"--exclude=./node_modules",
		"-C",
		repositoryRoot,
		"-cf",
		archive,
		".",
	]);
	await run("tar", ["-xf", archive, "-C", projectDirectory]);
}

async function verifyPiLocalInstall(
	piDirectory: string,
	tempRoot: string,
	projectDirectory: string,
): Promise<void> {
	console.log("Verifying Pi's real local install and remove commands.");
	const cliPath = resolve(piDirectory, "packages/coding-agent/dist/cli.js");
	const piHome = await mkdtemp(resolve(tempRoot, "pi-home-"));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: piHome,
		PI_OFFLINE: "1",
		HOME: piHome,
		CODEX_HOME: resolve(piHome, "codex-home"),
	};
	const sourcePath = resolve(projectDirectory);
	await run(process.execPath, [cliPath, "install", "-l", sourcePath, "--approve"], {
		cwd: projectDirectory,
		env,
	});
	const settingsPath = resolve(projectDirectory, ".pi", "settings.json");
	const installedSettings = JSON.parse(await readFile(settingsPath, "utf8")) as {
		packages?: unknown;
	};
	if (
		!Array.isArray(installedSettings.packages) ||
		!(
			await Promise.all(
				installedSettings.packages
					.filter((entry): entry is string => typeof entry === "string")
					.map(async (entry) => {
						try {
							return (
								(await realpath(resolve(projectDirectory, ".pi", entry))) ===
								(await realpath(sourcePath))
							);
						} catch {
							return false;
						}
					}),
			)
		).some(Boolean)
	) {
		throw new Error("Pi local install did not persist the absolute adaptor source");
	}
	await run(process.execPath, [cliPath, "remove", sourcePath, "-l", "--approve"], {
		cwd: projectDirectory,
		env,
	});
	const removedSettings = JSON.parse(await readFile(settingsPath, "utf8")) as {
		packages?: unknown;
	};
	if (Array.isArray(removedSettings.packages) && removedSettings.packages.length !== 0) {
		throw new Error("Pi local remove did not clear the adaptor source");
	}
}

async function installForkConsumer(
	projectDirectory: string,
	manifestPath: string,
	piDirectory: string,
): Promise<void> {
	console.log(
		"Installing the adaptor copy, then replacing its SDK with verified manifest tarballs.",
	);
	await run(
		"npm",
		["install", "--ignore-scripts", "--legacy-peer-deps", "--no-save", "--no-fund", "--no-audit"],
		{
			cwd: projectDirectory,
		},
	);
	const packageJsonPath = resolve(projectDirectory, "package.json");
	const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
		devDependencies?: Record<string, string>;
		overrides?: Record<string, string>;
	};
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		packages?: Array<{ name?: unknown; path?: unknown }>;
	};
	if (packageJson.devDependencies === undefined || manifest.packages === undefined) {
		throw new Error("Fork consumer metadata is missing development dependencies or SDK packages");
	}
	for (const entry of manifest.packages) {
		if (
			typeof entry.name !== "string" ||
			!piPackages.includes(entry.name as (typeof piPackages)[number]) ||
			typeof entry.path !== "string"
		) {
			throw new Error("Pi SDK manifest contains an invalid package entry");
		}
		packageJson.devDependencies[entry.name] = `file:${resolve(dirname(manifestPath), entry.path)}`;
		const packageName = entry.name;
		delete packageJson.overrides?.[packageName];
	}
	await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
	await run(process.execPath, [
		resolve(piDirectory, "scripts/local-fork-fixture.mjs"),
		"install-sdk",
		"--manifest",
		manifestPath,
		"--prefix",
		projectDirectory,
	]);
}

async function assembleAndPackAdaptor(
	projectDirectory: string,
	tarballDirectory: string,
): Promise<string> {
	console.log("Assembling and packing the adaptor tarball.");
	await run(process.execPath, ["scripts/assemble-package.ts"], { cwd: projectDirectory });
	await run(
		"npm",
		[
			"pack",
			"--silent",
			"./dist/package",
			"--ignore-scripts",
			"--pack-destination",
			tarballDirectory,
		],
		{ cwd: projectDirectory },
	);
	return findAdaptorTarball(tarballDirectory);
}

async function verifyPackagedAdaptorConsumer(
	tempRoot: string,
	manifestPath: string,
	adaptorTarball: string,
	piDirectory: string,
): Promise<void> {
	console.log("Loading the assembled adaptor tarball with the packed Pi fork.");
	const consumerDirectory = resolve(tempRoot, "consumer");
	await run(process.execPath, [
		resolve(piDirectory, "scripts/local-fork-fixture.mjs"),
		"create-consumer",
		"--manifest",
		manifestPath,
		"--directory",
		consumerDirectory,
		"--dependency",
		`pi-codex-adaptor=file:${adaptorTarball}`,
	]);

	const loaderPath = resolve(consumerDirectory, "verify-extension-load.mjs");
	await writeFile(
		loaderPath,
		[
			'import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";',
			"const extensionPath = process.argv[2];",
			'if (extensionPath === undefined) throw new Error("Adaptor extension path is required");',
			"const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), process.env.HOME);",
			'if (result.errors.length > 0 || result.extensions.length !== 1) throw new Error(result.errors.map((entry) => entry.error).join("; "));',
		].join("\n"),
	);
	const extensionPath = resolve(
		consumerDirectory,
		"node_modules",
		"pi-codex-adaptor",
		"src",
		"extension.ts",
	);
	await verifyPackagedProviderDispatch(consumerDirectory, dirname(dirname(extensionPath)));
	await installPoisonPackages(dirname(dirname(extensionPath)));
	await run(process.execPath, [loaderPath, extensionPath], {
		cwd: consumerDirectory,
		env: {
			...process.env,
			PI_OFFLINE: "1",
			HOME: resolve(consumerDirectory, "home"),
			CODEX_HOME: resolve(consumerDirectory, "codex-home"),
		},
	});
}

async function installPoisonPackages(packageRoot: string): Promise<void> {
	for (const packageName of piPackages) {
		const packageDirectory = resolve(packageRoot, "node_modules", packageName);
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			resolve(packageDirectory, "package.json"),
			`${JSON.stringify({ name: packageName, type: "module", exports: "./index.js" })}\n`,
		);
		await writeFile(
			resolve(packageDirectory, "index.js"),
			`throw new Error(${JSON.stringify(`poison package imported: ${packageName}`)});\n`,
		);
	}
}

async function verifyPackagedProviderDispatch(
	consumerDirectory: string,
	packageRoot: string,
): Promise<void> {
	console.log("Driving provider dispatch through the installed adaptor tarball.");
	const sourceTest = await readFile(
		resolve(repositoryRoot, "tests/smoke/tool-surface.test.ts"),
		"utf8",
	);
	const testPath = resolve(packageRoot, "tests/smoke/tool-surface.test.ts");
	await mkdir(dirname(testPath), { recursive: true });
	await writeFile(testPath, sourceTest);
	await run(process.execPath, ["test", testPath], {
		cwd: packageRoot,
		env: {
			...process.env,
			PI_OFFLINE: "1",
			HOME: resolve(consumerDirectory, "home"),
			CODEX_HOME: resolve(consumerDirectory, "codex-home"),
		},
	});
}

async function runFocusedTests(
	projectDirectory: string,
	forkCommit: string,
	sdkVersion: string,
): Promise<void> {
	console.log(
		"Running loader, provider-route, tool-profile, and compaction tests against the fork tarballs.",
	);
	await run(process.execPath, ["test", ...focusedTests], {
		cwd: projectDirectory,
		env: {
			...process.env,
			PI_EXTENSION_SDK_COMMIT: forkCommit,
			PI_FORK_PROJECT_ROOT: projectDirectory,
			PI_FORK_SDK_VERSION: sdkVersion,
			PI_OFFLINE: "1",
		},
	});
}

async function findAdaptorTarball(tarballDirectory: string): Promise<string> {
	const glob = new Bun.Glob("pi-codex-adaptor-*.tgz");
	const matches: string[] = [];
	for await (const entry of glob.scan({ cwd: tarballDirectory, onlyFiles: true })) {
		matches.push(resolve(tarballDirectory, entry));
	}
	if (matches.length !== 1 || matches[0] === undefined) {
		throw new Error("Expected one packed adaptor tarball");
	}
	return matches[0];
}

async function run(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const spawnOptions = {
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.env === undefined ? {} : { env: options.env }),
		stderr: "inherit",
		stdout: "inherit",
	} as const;
	const child = Bun.spawn([command, ...args], spawnOptions);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${basename(command)} exited with status ${exitCode}`);
}

function printHelp(): void {
	console.log(`Usage: bun run test:pi-fork -- --pi-dir <checkout> --pi-ref <commit> [options]

	Consume the exact Pi SDK manifest, install it into an isolated adaptor copy without this checkout's
	Bun lockfile or node_modules, install the assembled adaptor tarball into a separate clean consumer,
	then run focused compatibility tests.

Options:
  --pi-dir <checkout>  Clean Pi Git checkout with the selected ref at HEAD
  --pi-ref <commit>    Immutable Pi commit or ref to verify
  --keep-temp          Preserve the temporary directory after a failure
  --help               Show this help`);
}

if (import.meta.main) {
	await main();
}

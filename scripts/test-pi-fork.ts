import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ForkOptions {
	readonly piDir: string;
	readonly piRef: string;
	readonly keepTemp: boolean;
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
	"tests/unit/codex-compaction-replay.test.ts",
	"tests/unit/codex-provider-request-guard.test.ts",
	"tests/unit/provider-session-router.test.ts",
	"tests/unit/codex-tool-profile.test.ts",
	"tests/integration/automatic-compaction-continuation.test.ts",
	"tests/integration/compaction-failure-ownership.test.ts",
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
		const forkCommit = await resolvedCommit(options.piDir, options.piRef);
		await assertCleanCurrentPiCheckout(options.piDir, forkCommit);
		console.log(`Pi fork commit: ${forkCommit} (${options.piRef})`);

		const forkDirectory = resolve(tempRoot, "pi");
		const tarballDirectory = resolve(tempRoot, "tarballs");
		const projectDirectory = resolve(tempRoot, "project");
		await archivePiFork(options.piDir, forkCommit, forkDirectory, tempRoot);
		await copyGeneratedPiModelData(options.piDir, forkDirectory);
		await buildAndPackPi(forkDirectory, tarballDirectory);
		await copyProject(projectDirectory, tempRoot);
		await installForkConsumer(projectDirectory, tarballDirectory);
		const adaptorTarball = await assembleAndPackAdaptor(projectDirectory, tarballDirectory);
		await verifyPackagedAdaptorConsumer(tempRoot, tarballDirectory, adaptorTarball);
		await runFocusedTests(projectDirectory, forkCommit);
		succeeded = true;
		console.log(`Pi fork compatibility passed: ${forkCommit}`);
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

async function resolvedCommit(piDir: string, piRef: string): Promise<string> {
	const commit = await commandOutput("git", [
		"-C",
		piDir,
		"rev-parse",
		"--verify",
		`${piRef}^{commit}`,
	]);
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Pi fork ref did not resolve to a commit");
	return commit;
}

async function assertCleanCurrentPiCheckout(piDir: string, commit: string): Promise<void> {
	const [head, status] = await Promise.all([
		commandOutput("git", ["-C", piDir, "rev-parse", "HEAD"]),
		commandOutput("git", ["-C", piDir, "status", "--porcelain", "--untracked-files=all"]),
	]);
	if (head !== commit) {
		throw new Error(
			"Pi fork verification requires the selected immutable commit to be checked out at HEAD",
		);
	}
	if (status.length > 0) {
		throw new Error(
			"Pi fork verification requires a clean checkout so the archived commit is the tested host",
		);
	}
}

async function archivePiFork(
	piDir: string,
	commit: string,
	forkDirectory: string,
	tempRoot: string,
) {
	const archive = resolve(tempRoot, "pi.tar");
	await mkdir(forkDirectory, { recursive: true });
	await run("git", ["-C", piDir, "archive", "--format=tar", "--output", archive, commit]);
	await run("tar", ["-xf", archive, "-C", forkDirectory]);
}

async function copyGeneratedPiModelData(piDir: string, forkDirectory: string): Promise<void> {
	// Pi intentionally omits generated model JSON from Git. A CI checkout therefore uses the
	// pinned development package's generated catalog without querying external providers.
	const source = await firstExistingDirectory([
		resolve(piDir, "packages/ai/src/providers/data"),
		resolve(repositoryRoot, "node_modules/@earendil-works/pi-ai/dist/providers/data"),
	]);
	if (source === undefined) {
		throw new Error("Pi model data is unavailable for fork compatibility verification");
	}
	await cp(source, resolve(forkDirectory, "packages/ai/src/providers/data"), { recursive: true });
}

async function firstExistingDirectory(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		try {
			const metadata = await Bun.file(candidate).stat();
			if (metadata.isDirectory()) return candidate;
		} catch {
			// Try the next checked-in or installed catalog source.
		}
	}
	return undefined;
}

async function buildAndPackPi(forkDirectory: string, tarballDirectory: string): Promise<void> {
	console.log("Installing and packing the archived Pi workspaces.");
	await mkdir(tarballDirectory, { recursive: true });
	await run("npm", ["ci", "--ignore-scripts", "--prefix", forkDirectory]);
	await run("npm", ["run", "build", "--prefix", resolve(forkDirectory, "packages/tui")]);
	await run(resolve(forkDirectory, "node_modules/.bin/tsgo"), [
		"-p",
		resolve(forkDirectory, "packages/ai/tsconfig.build.json"),
	]);
	await rm(resolve(forkDirectory, "packages/ai/dist/providers/data"), {
		force: true,
		recursive: true,
	});
	await cp(
		resolve(forkDirectory, "packages/ai/src/providers/data"),
		resolve(forkDirectory, "packages/ai/dist/providers/data"),
		{ recursive: true },
	);
	await run("npm", ["run", "build", "--prefix", resolve(forkDirectory, "packages/agent")]);
	await run("npm", ["run", "build", "--prefix", resolve(forkDirectory, "packages/coding-agent")]);

	for (const packageName of piPackages) {
		const workspace = packageName.replace("@earendil-works/pi-", "");
		await run(
			"npm",
			["pack", "--silent", "--ignore-scripts", "--pack-destination", tarballDirectory],
			{
				cwd: resolve(forkDirectory, "packages", workspace === "agent-core" ? "agent" : workspace),
			},
		);
	}

	for (const packageName of piPackages) {
		const tarball = await findTarball(tarballDirectory, packageName);
		const digest = new Bun.CryptoHasher("sha256").update(await readFile(tarball)).digest("hex");
		console.log(`Pi tarball sha256: ${digest}  ${basename(tarball)}`);
	}
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

async function installForkConsumer(
	projectDirectory: string,
	tarballDirectory: string,
): Promise<void> {
	console.log(
		"Installing the adaptor copy without its Bun lockfile, then unpacking fork tarballs.",
	);
	await run(process.execPath, ["install", "--ignore-scripts", "--no-save"], {
		cwd: projectDirectory,
	});
	const tarballs = await Promise.all(
		piPackages.map((packageName) => findTarball(tarballDirectory, packageName)),
	);
	for (let index = 0; index < piPackages.length; index += 1) {
		const packageName = piPackages[index];
		const tarball = tarballs[index];
		if (packageName === undefined || tarball === undefined) {
			throw new Error("Pi package and tarball lists are inconsistent");
		}
		const packageDirectory = resolve(projectDirectory, "node_modules", packageName);
		await rm(packageDirectory, { force: true, recursive: true });
		await mkdir(packageDirectory, { recursive: true });
		await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", packageDirectory]);
	}
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
	return findTarball(tarballDirectory, "pi-codex-adaptor");
}

async function verifyPackagedAdaptorConsumer(
	tempRoot: string,
	tarballDirectory: string,
	adaptorTarball: string,
): Promise<void> {
	console.log("Loading the assembled adaptor tarball with the packed Pi fork.");
	const consumerDirectory = resolve(tempRoot, "consumer");
	const piTarballs = await Promise.all(
		piPackages.map((packageName) => findTarball(tarballDirectory, packageName)),
	);
	await run("npm", [
		"install",
		"--ignore-scripts",
		"--no-fund",
		"--no-audit",
		"--prefix",
		consumerDirectory,
		...piTarballs,
		adaptorTarball,
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
	await run(process.execPath, [loaderPath, extensionPath], {
		cwd: consumerDirectory,
		env: {
			...process.env,
			PI_OFFLINE: "1",
			HOME: resolve(consumerDirectory, "home"),
			CODEX_HOME: resolve(consumerDirectory, "codex-home"),
		},
	});
	await verifyPackagedProviderDispatch(consumerDirectory, dirname(dirname(extensionPath)));
}

async function verifyPackagedProviderDispatch(
	consumerDirectory: string,
	packageRoot: string,
): Promise<void> {
	console.log("Driving provider dispatch through the installed adaptor tarball.");
	const sourceTest = await readFile(
		resolve(repositoryRoot, "tests/integration/automatic-compaction-continuation.test.ts"),
		"utf8",
	);
	const testPath = resolve(
		packageRoot,
		"tests/integration/automatic-compaction-continuation.test.ts",
	);
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

async function runFocusedTests(projectDirectory: string, forkCommit: string): Promise<void> {
	console.log(
		"Running loader, provider-route, tool-profile, and compaction tests against the fork tarballs.",
	);
	await run(process.execPath, ["test", ...focusedTests], {
		cwd: projectDirectory,
		env: {
			...process.env,
			PI_FORK_COMMIT: forkCommit,
			PI_FORK_PROJECT_ROOT: projectDirectory,
			PI_OFFLINE: "1",
		},
	});
}

async function findTarball(tarballDirectory: string, packageName: string): Promise<string> {
	const packageStem = packageName.startsWith("@")
		? packageName.slice(1).replace("/", "-")
		: packageName;
	const glob = new Bun.Glob(`${packageStem}-*.tgz`);
	const matches: string[] = [];
	for await (const entry of glob.scan({ cwd: tarballDirectory, onlyFiles: true })) {
		matches.push(resolve(tarballDirectory, entry));
	}
	if (matches.length !== 1 || matches[0] === undefined) {
		throw new Error(`Expected one packed tarball for ${packageName}`);
	}
	return matches[0];
}

async function commandOutput(command: string, args: readonly string[]): Promise<string> {
	const child = Bun.spawn([command, ...args], { stderr: "pipe", stdout: "pipe" });
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${basename(command)} exited with status ${exitCode}`);
	return stdout.trim();
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

Archive an exact Pi commit, build and pack the four consumed workspaces, install them into an isolated
adaptor copy without this checkout's Bun lockfile or node_modules, install the assembled adaptor tarball
into a separate clean consumer, then run focused compatibility tests.

Options:
  --pi-dir <checkout>  Clean Pi Git checkout with the selected ref at HEAD
  --pi-ref <commit>    Immutable Pi commit or ref to verify
  --keep-temp          Preserve the temporary directory after a failure
  --help               Show this help`);
}

if (import.meta.main) {
	await main();
}

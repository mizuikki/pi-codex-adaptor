import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
	"tests/smoke/pi-loader.test.ts",
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
		console.log(`Pi fork commit: ${forkCommit} (${options.piRef})`);

		const forkDirectory = resolve(tempRoot, "pi");
		const tarballDirectory = resolve(tempRoot, "tarballs");
		const projectDirectory = resolve(tempRoot, "project");
		await archivePiFork(options.piDir, forkCommit, forkDirectory, tempRoot);
		await buildAndPackPi(forkDirectory, tarballDirectory);
		await copyProject(projectDirectory, tempRoot);
		await installForkConsumer(projectDirectory, tarballDirectory);
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

async function buildAndPackPi(forkDirectory: string, tarballDirectory: string): Promise<void> {
	console.log("Installing and packing the archived Pi workspaces.");
	await mkdir(tarballDirectory, { recursive: true });
	await run("npm", ["ci", "--ignore-scripts", "--prefix", forkDirectory]);
	await run("npm", ["run", "build", "--prefix", resolve(forkDirectory, "packages/tui")]);
	await run("npm", ["run", "build", "--prefix", resolve(forkDirectory, "packages/ai")]);
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
	console.log("Installing the adaptor copy without its Bun lockfile, then replacing Pi packages.");
	await run(process.execPath, ["install", "--ignore-scripts", "--no-save"], {
		cwd: projectDirectory,
	});
	const tarballs = await Promise.all(
		piPackages.map((packageName) => findTarball(tarballDirectory, packageName)),
	);
	await run(process.execPath, ["add", "--ignore-scripts", "--no-save", ...tarballs], {
		cwd: projectDirectory,
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
	const packageStem = packageName.slice(1).replace("/", "-");
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
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${command} failed: ${stderr.trim()}`);
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
adaptor copy without this checkout's Bun lockfile or node_modules, then run focused compatibility tests.

Options:
  --pi-dir <checkout>  Pi Git checkout containing the selected ref
  --pi-ref <commit>    Immutable Pi commit or ref to verify
  --keep-temp          Preserve the temporary directory after a failure
  --help               Show this help`);
}

if (import.meta.main) {
	await main();
}

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;

if (targetIndex >= 0 && target === undefined) {
	throw new Error("--target requires a Rust target triple");
}

const command = [
	"cargo",
	"build",
	"--manifest-path",
	resolve(repositoryRoot, "native/Cargo.toml"),
	"--workspace",
];

if (release) {
	command.push("--release");
}
if (target !== undefined) {
	command.push("--target", target);
}

const processResult = Bun.spawn(command, {
	cwd: repositoryRoot,
	env: {
		...process.env,
		PI_CODEX_ADAPTOR_SOURCE_COMMIT: (await Bun.$`git rev-parse HEAD`.cwd(repositoryRoot).quiet())
			.text()
			.trim(),
	},
	stderr: "inherit",
	stdout: "inherit",
});

const exitCode = await processResult.exited;
if (exitCode !== 0) {
	process.exit(exitCode);
}

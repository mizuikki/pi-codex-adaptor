import { resolve } from "node:path";

import { nativeTargetFor } from "../src/infrastructure/codex-bridge/identity.ts";

const root = resolve(import.meta.dir, "..");
const target = nativeTargetFor(process.platform, process.arch);
if (target === undefined) {
	throw new Error(`Unsupported native build target: ${process.platform}/${process.arch}`);
}

await run(["cargo", "fmt", "--manifest-path", "native/Cargo.toml", "--all", "--check"]);
await run([
	"cargo",
	"clippy",
	"--manifest-path",
	"native/Cargo.toml",
	"--workspace",
	"--all-targets",
	"--target",
	target,
	"--",
	"-D",
	"warnings",
]);
await run([
	"cargo",
	"test",
	"--manifest-path",
	"native/Cargo.toml",
	"--workspace",
	"--target",
	target,
]);
await run([
	"cargo",
	"build",
	"--manifest-path",
	"native/Cargo.toml",
	"--bin",
	"codex-bridge",
	"--target",
	target,
]);

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, { cwd: root, stderr: "inherit", stdout: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${command[0]} exited with status ${code}`);
}

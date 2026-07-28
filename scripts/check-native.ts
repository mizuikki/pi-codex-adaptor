import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { nativeTargetFor } from "../src/infrastructure/codex-bridge/identity.ts";

const root = resolve(import.meta.dir, "..");
const target = nativeTargetFor(process.platform, process.arch);
if (target === undefined) {
	throw new Error(`Unsupported native build target: ${process.platform}/${process.arch}`);
}
const executable = process.platform === "win32" ? "codex-bridge.exe" : "codex-bridge";

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
await run(["bun", "scripts/build-native.ts", "--release", "--target", target]);
await run([
	"bun",
	"scripts/verify-bridge-integration.ts",
	"--target",
	target,
	"--executable",
	resolve(root, "native", "target", target, "release", executable),
]);
const sourceCommit = (await Bun.$`git rev-parse HEAD`.cwd(root).quiet()).text().trim();
await run([
	"bun",
	"scripts/assemble-native-artifact.ts",
	"--target",
	target,
	"--executable",
	resolve(root, "native", "target", target, "release", executable),
	"--source-commit",
	sourceCommit,
]);
const installedArtifact = resolve(root, "native", "bin", target);
await rm(installedArtifact, { force: true, recursive: true });
await mkdir(resolve(root, "native", "bin"), { recursive: true });
await cp(resolve(root, "native", "artifacts", target), installedArtifact, { recursive: true });

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, { cwd: root, stderr: "pipe", stdout: "inherit" });
	const [code] = await Promise.all([child.exited, new Response(child.stderr).arrayBuffer()]);
	if (code !== 0) throw new Error(`${command[0]} exited with status ${code}`);
}

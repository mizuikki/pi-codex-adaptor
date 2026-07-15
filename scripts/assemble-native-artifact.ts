import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
} from "../src/infrastructure/codex-bridge/identity.ts";

export function resolveArtifactOutput(target: string, artifactsRoot: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) {
		throw new Error("--target must be a plain target directory name");
	}
	const output = resolve(artifactsRoot, target);
	const relativeOutput = relative(artifactsRoot, output);
	if (
		relativeOutput.length === 0 ||
		relativeOutput === ".." ||
		relativeOutput.startsWith(`..${sep}`) ||
		isAbsolute(relativeOutput)
	) {
		throw new Error("--target must name a child directory of native/artifacts");
	}
	return output;
}

async function main(): Promise<void> {
	const target = requiredArgument("--target");
	const executable = resolve(requiredArgument("--executable"));
	const sourceCommit = requiredArgument("--source-commit");
	if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
		throw new Error("--source-commit must be a 40-character Git object id");
	}

	const output = resolveArtifactOutput(target, resolve("native", "artifacts"));
	await rm(output, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	const executableName = basename(executable);
	const destination = resolve(output, executableName);
	await copyFile(executable, destination);
	const bytes = await readFile(destination);
	const metadata = await stat(destination);
	const manifest = {
		schemaVersion: 1,
		target,
		executable: executableName,
		executableSize: metadata.size,
		executableSha256: createHash("sha256").update(bytes).digest("hex"),
		projectSourceCommit: sourceCommit,
		bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
		officialCodexVersion: OFFICIAL_CODEX_VERSION,
		officialCodexTag: OFFICIAL_CODEX_TAG,
		officialSourceCommit: OFFICIAL_SOURCE_COMMIT,
		vendorTreeSha256: VENDOR_TREE_SHA256,
	};
	await writeFile(
		resolve(output, "native-artifact.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

function requiredArgument(name: string): string {
	const index = process.argv.indexOf(name);
	const value = index < 0 ? undefined : process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

if (import.meta.main) {
	await main();
}

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface TypeScriptSubsetEntry {
	source: string;
	file: string;
}

interface SchemaManifest {
	schemaVersion: number;
	officialCodexVersion: string;
	officialSourceCommit: string;
	generation: {
		stable: boolean;
		jsonBundleCanonicalSha256: string;
		jsonV2BundleCanonicalSha256: string;
		typescriptTreeSha256: string;
	};
	typescriptSubset: TypeScriptSubsetEntry[];
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repositoryRoot, "fixtures", "app-server-schema");
const manifest = JSON.parse(
	await readFile(resolve(root, "manifest.json"), "utf8"),
) as SchemaManifest;

validateManifest(manifest);
await rejectCommittedJsonBundles();

const generatedRoot = await mkdtemp(resolve(tmpdir(), "pi-codex-app-server-schema-"));
try {
	const codexHome = resolve(generatedRoot, "codex-home");
	const jsonRoot = resolve(generatedRoot, "json");
	const typescriptGeneratedRoot = resolve(generatedRoot, "typescript");
	await Promise.all([
		mkdir(codexHome, { recursive: true }),
		mkdir(jsonRoot, { recursive: true }),
		mkdir(typescriptGeneratedRoot, { recursive: true }),
	]);

	await runCodexGenerator("generate-json-schema", jsonRoot, codexHome);
	await runCodexGenerator("generate-ts", typescriptGeneratedRoot, codexHome);

	await assertCanonicalJsonHash(
		resolve(jsonRoot, "codex_app_server_protocol.schemas.json"),
		manifest.generation.jsonBundleCanonicalSha256,
	);
	await assertCanonicalJsonHash(
		resolve(jsonRoot, "codex_app_server_protocol.v2.schemas.json"),
		manifest.generation.jsonV2BundleCanonicalSha256,
	);

	const typescriptRoot = resolve(root, "typescript");
	const subsetFiles = manifest.typescriptSubset.map((entry) => entry.file).sort();
	const present = (await readdir(typescriptRoot)).filter((file) => file.endsWith(".ts")).sort();
	if (JSON.stringify(present) !== JSON.stringify(subsetFiles)) {
		throw new Error(
			"App-server TypeScript subset does not match the committed TypeScript tree exactly",
		);
	}

	for (const entry of manifest.typescriptSubset) {
		const generated = await readFile(resolve(typescriptGeneratedRoot, entry.source));
		const committed = await readFile(resolve(typescriptRoot, entry.file));
		if (!generated.equals(committed)) {
			throw new Error(`App-server TypeScript subset is stale: ${entry.file}`);
		}
	}

	const treeSha256 = await hashTypeScriptTree(typescriptRoot, subsetFiles);
	if (treeSha256 !== manifest.generation.typescriptTreeSha256) {
		throw new Error(
			`App-server TypeScript tree hash mismatch: expected ${manifest.generation.typescriptTreeSha256}, received ${treeSha256}`,
		);
	}
} finally {
	await rm(generatedRoot, { recursive: true, force: true });
}

console.log(
	`Regenerated the stable app-server schema and verified ${manifest.typescriptSubset.length} ` +
		`committed TypeScript files against Codex ${manifest.officialCodexVersion}.`,
);

function validateManifest(value: SchemaManifest): void {
	if (
		value.schemaVersion !== 1 ||
		value.officialCodexVersion !== "0.144.3" ||
		value.officialSourceCommit !== "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c" ||
		value.generation.stable !== true
	) {
		throw new Error("App-server schema manifest does not match the pinned stable baseline");
	}
	for (const hash of [
		value.generation.jsonBundleCanonicalSha256,
		value.generation.jsonV2BundleCanonicalSha256,
		value.generation.typescriptTreeSha256,
	]) {
		if (!/^[0-9a-f]{64}$/.test(hash)) {
			throw new Error("App-server schema manifest contains an invalid SHA-256 value");
		}
	}
	if (
		value.typescriptSubset.length === 0 ||
		new Set(value.typescriptSubset.map((entry) => entry.file)).size !==
			value.typescriptSubset.length ||
		new Set(value.typescriptSubset.map((entry) => entry.source)).size !==
			value.typescriptSubset.length
	) {
		throw new Error("App-server TypeScript subset must be non-empty and unique");
	}
	for (const entry of value.typescriptSubset) {
		if (!isSafeRelativePath(entry.source) || !isPlainTypeScriptFile(entry.file)) {
			throw new Error("App-server TypeScript subset contains an unsafe path");
		}
	}
}

async function rejectCommittedJsonBundles(): Promise<void> {
	const jsonRoot = resolve(root, "json");
	try {
		const files = await readdir(jsonRoot);
		if (files.length > 0) {
			throw new Error(
				"Complete app-server JSON bundles must not be committed; retain canonical checksums only",
			);
		}
	} catch (error) {
		if (isMissingPath(error)) return;
		throw error;
	}
}

async function runCodexGenerator(
	command: "generate-json-schema" | "generate-ts",
	output: string,
	codexHome: string,
): Promise<void> {
	const codexCli = resolve(repositoryRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
	const child = Bun.spawn([process.execPath, codexCli, "app-server", command, "--out", output], {
		cwd: repositoryRoot,
		env: generatorEnvironment(codexHome),
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = await new Response(child.stderr).text();
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(
			`Pinned Codex app-server ${command} failed${stderr.length > 0 ? ` with status ${exitCode}` : ""}`,
		);
	}
}

function generatorEnvironment(codexHome: string): Record<string, string> {
	const environment: Record<string, string> = {
		CODEX_HOME: codexHome,
		HOME: codexHome,
		NO_COLOR: "1",
		PATH: process.env.PATH ?? "",
		TEMP: codexHome,
		TMP: codexHome,
		TMPDIR: codexHome,
		USERPROFILE: codexHome,
	};
	for (const key of ["ComSpec", "PATHEXT", "SystemRoot", "SYSTEMROOT"]) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

async function assertCanonicalJsonHash(path: string, expected: string): Promise<void> {
	const value = JSON.parse(await readFile(path, "utf8")) as unknown;
	const actual = createHash("sha256")
		.update(JSON.stringify(sortJson(value)))
		.digest("hex");
	if (actual !== expected) {
		throw new Error(`App-server canonical schema checksum mismatch for ${path}`);
	}
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, sortJson(record[key])]),
	);
}

async function hashTypeScriptTree(directory: string, files: string[]): Promise<string> {
	const tree = createHash("sha256");
	for (const file of files) {
		const bytes = await readFile(resolve(directory, file));
		const fileHash = createHash("sha256").update(bytes).digest("hex");
		tree.update(`${file}\0${fileHash}\n`);
	}
	return tree.digest("hex");
}

function isSafeRelativePath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
	const parts = path.split("/");
	return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isPlainTypeScriptFile(file: string): boolean {
	return file.endsWith(".ts") && !file.includes("/") && !file.includes(sep) && file === file.trim();
}

function isMissingPath(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

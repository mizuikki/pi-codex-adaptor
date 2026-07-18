import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = resolve(repositoryRoot, "dist/package");
const nativeArtifactsArgument = argument("--native-artifacts-dir");
const nativeArtifactsDirectory = nativeArtifactsArgument
	? resolve(nativeArtifactsArgument)
	: undefined;

async function main(): Promise<void> {
	await rm(stagingDirectory, { force: true, recursive: true });
	await mkdir(stagingDirectory, { recursive: true });

	await Promise.all([
		cp(resolve(repositoryRoot, "LICENSE"), resolve(stagingDirectory, "LICENSE")),
		cp(resolve(repositoryRoot, "README.md"), resolve(stagingDirectory, "README.md")),
		cp(resolve(repositoryRoot, "src"), resolve(stagingDirectory, "src"), { recursive: true }),
	]);

	if (nativeArtifactsDirectory !== undefined) {
		await copyNativeArtifacts(nativeArtifactsDirectory);
	}

	const packageJson = JSON.parse(
		await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
	) as Record<string, unknown>;

	delete packageJson.devDependencies;
	delete packageJson.files;
	delete packageJson.scripts;

	await writeFile(
		resolve(stagingDirectory, "package.json"),
		`${JSON.stringify(packageJson, null, 2)}\n`,
	);

	console.log(stagingDirectory);
}

async function copyNativeArtifacts(sourceRoot: string): Promise<void> {
	const targets = (await readdir(sourceRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	if (targets.length === 0) throw new Error("No native artifact targets were found");

	for (const target of targets) {
		const source = resolve(sourceRoot, target);
		const manifestPath = resolve(source, "native-artifact.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as NativeArtifactManifest;
		if (manifest.schemaVersion !== 1 || manifest.target !== target) {
			throw new Error(`Native artifact manifest is invalid for ${target}`);
		}
		if (!isSafeFileName(manifest.executable)) {
			throw new Error(`Native artifact executable path is invalid for ${target}`);
		}
		const executable = resolve(source, manifest.executable);
		const bytes = await readFile(executable);
		const hash = createHash("sha256").update(bytes).digest("hex");
		if (hash !== manifest.executableSha256 || bytes.byteLength !== manifest.executableSize) {
			throw new Error(`Native artifact checksum mismatch for ${target}`);
		}
		const destination = resolve(stagingDirectory, "native", "bin", target);
		await mkdir(destination, { recursive: true });
		await cp(executable, resolve(destination, manifest.executable));
		await cp(manifestPath, resolve(destination, "native-artifact.json"));
	}
}

export function isSafeFileName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value !== "." &&
		value !== ".." &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes(":")
	);
}

interface NativeArtifactManifest {
	schemaVersion: number;
	target: string;
	executable: string;
	executableSize: number;
	executableSha256: string;
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

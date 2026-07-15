import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

interface CargoPackage {
	id: string;
	name: string;
	version: string;
	source: string | null;
	license: string | null;
}

interface CargoMetadata {
	packages: CargoPackage[];
	resolve: {
		nodes: Array<{
			id: string;
			deps: Array<{ pkg: string; dep_kinds?: Array<{ kind: string | null }> }>;
		}>;
	};
}

interface CargoLock {
	package: Array<{
		name: string;
		version: string;
		source?: string;
		checksum?: string;
	}>;
}

const officialSourceCommit = "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c";
const officialVersion = "0.144.3";
const officialPackages = new Set([
	"codex-api",
	"codex-async-utils",
	"codex-client",
	"codex-execpolicy",
	"codex-extension-items",
	"codex-http-client",
	"codex-network-proxy",
	"codex-protocol",
	"codex-tools",
	"codex-utils-absolute-path",
	"codex-utils-cache",
	"codex-utils-home-dir",
	"codex-utils-image",
	"codex-utils-output-truncation",
	"codex-utils-path-uri",
	"codex-utils-pty",
	"codex-utils-rustls-provider",
	"codex-utils-string",
	"codex-websocket-client",
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(repositoryRoot, "native/Cargo.lock");
const outputPath = resolve(repositoryRoot, "native/upstream/openai-codex-sbom.json");

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function cargoMetadata(): Promise<CargoMetadata> {
	const processResult = Bun.spawn(
		[
			"cargo",
			"metadata",
			"--locked",
			"--format-version",
			"1",
			"--manifest-path",
			resolve(repositoryRoot, "native/Cargo.toml"),
		],
		{ cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
	);
	const [exitCode, stdout] = await Promise.all([
		processResult.exited,
		new Response(processResult.stdout).text(),
		new Response(processResult.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`cargo metadata exited with status ${exitCode}`);
	}
	return JSON.parse(stdout) as CargoMetadata;
}

function sourceIdentity(pkg: CargoPackage): string {
	if (officialPackages.has(pkg.name) && pkg.version === officialVersion) {
		return `official:${officialSourceCommit}`;
	}
	return pkg.source ?? "project";
}

const lockBytes = await readFile(lockPath);
const lock = parse(lockBytes.toString()) as unknown as CargoLock;
const metadata = await cargoMetadata();
const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const nodesById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const root = metadata.packages.find((pkg) => pkg.name === "codex-bridge" && pkg.source === null);
if (root === undefined) {
	throw new Error("Cargo metadata does not contain the native bridge package");
}

const reachable = new Set<string>();
const pending = [root.id];
while (pending.length > 0) {
	const id = pending.pop();
	if (id === undefined || reachable.has(id)) {
		continue;
	}
	reachable.add(id);
	for (const dependency of productionDependencies(nodesById.get(id)?.deps ?? [])) {
		pending.push(dependency.pkg);
	}
}

const references = new Map<string, string>();
for (const id of reachable) {
	const pkg = packagesById.get(id);
	if (pkg === undefined) {
		throw new Error("Cargo resolve graph references an unknown package");
	}
	const source = sourceIdentity(pkg);
	references.set(id, `${pkg.name}@${pkg.version}:${sha256(source).slice(0, 12)}`);
}

const packages = [...reachable]
	.map((id) => {
		const pkg = packagesById.get(id);
		if (pkg === undefined) {
			throw new Error("Cargo resolve graph references an unknown package");
		}
		const source = sourceIdentity(pkg);
		const lockEntry = lock.package.find(
			(entry) =>
				entry.name === pkg.name &&
				entry.version === pkg.version &&
				(entry.source ?? null) === pkg.source,
		);
		return {
			ref: references.get(id),
			name: pkg.name,
			version: pkg.version,
			source,
			license: pkg.license,
			checksum: lockEntry?.checksum ?? null,
			dependencies: productionDependencies(nodesById.get(id)?.deps ?? [])
				.map((dependency) => references.get(dependency.pkg))
				.filter((reference): reference is string => reference !== undefined)
				.sort(),
		};
	})
	.sort((left, right) => (left.ref ?? "").localeCompare(right.ref ?? ""));

const sbom = {
	schema_version: 1,
	official_version: officialVersion,
	official_source_commit: officialSourceCommit,
	cargo_lock_sha256: sha256(lockBytes),
	root: references.get(root.id),
	packages,
};

function productionDependencies<T extends { dep_kinds?: Array<{ kind: string | null }> }>(
	dependencies: T[],
): T[] {
	return dependencies.filter(
		(dependency) =>
			dependency.dep_kinds === undefined ||
			dependency.dep_kinds.length === 0 ||
			dependency.dep_kinds.some((kind) => kind.kind !== "dev"),
	);
}
const generated = `${JSON.stringify(sbom, null, 2)}\n`;

if (process.argv.includes("--check")) {
	const current = await readFile(outputPath, "utf8");
	if (current !== generated) {
		throw new Error("Native SBOM is stale");
	}
	console.log(`Verified native SBOM with ${packages.length} reachable packages.`);
} else {
	await writeFile(outputPath, generated);
	console.log(JSON.stringify({ packages: packages.length, sha256: sha256(generated) }, null, 2));
}

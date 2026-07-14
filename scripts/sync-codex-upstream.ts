import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

interface UpstreamManifest {
	schema_version: number;
	official: {
		version: string;
		tag: string;
		annotated_tag_object: string;
		source_commit: string;
		rust_toolchain: string;
	};
	vendor: {
		status: string;
		tree_sha256: string;
		allowlist: string[];
		patches: string[];
	};
}

const expectedBaseline = {
	annotatedTagObject: "13307a9036baccd2c51b685d1457a4b89b5b2f3b",
	rustToolchain: "1.95.0",
	sourceCommit: "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c",
	tag: "rust-v0.144.3",
	version: "0.144.3",
} as const;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(repositoryRoot, "native/vendor/openai-codex");

async function collectFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const paths: string[] = [];

	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await collectFiles(path)));
		} else if (entry.isFile() && entry.name !== ".gitkeep") {
			paths.push(path);
		}
	}

	return paths.sort();
}

async function calculateTreeHash(): Promise<{ files: string[]; sha256: string }> {
	const files = await collectFiles(vendorRoot);
	const tree = createHash("sha256");

	for (const file of files) {
		const relativePath = relative(vendorRoot, file).split(sep).join("/");
		const fileHash = createHash("sha256")
			.update(await readFile(file))
			.digest("hex");
		tree.update(`${relativePath}\0${fileHash}\n`);
	}

	return { files: files.map((file) => relative(vendorRoot, file)), sha256: tree.digest("hex") };
}

const manifest = parse(
	await readFile(resolve(repositoryRoot, "UPSTREAM_CODEX.toml"), "utf8"),
) as unknown as UpstreamManifest;

if (manifest.schema_version !== 1) {
	throw new Error(`Unsupported upstream manifest schema: ${manifest.schema_version}`);
}

const actualBaseline = {
	annotatedTagObject: manifest.official.annotated_tag_object,
	rustToolchain: manifest.official.rust_toolchain,
	sourceCommit: manifest.official.source_commit,
	tag: manifest.official.tag,
	version: manifest.official.version,
};

if (JSON.stringify(actualBaseline) !== JSON.stringify(expectedBaseline)) {
	throw new Error("UPSTREAM_CODEX.toml does not match the pinned OpenAI Codex baseline");
}

const tree = await calculateTreeHash();
if (tree.sha256 !== manifest.vendor.tree_sha256) {
	throw new Error(
		`Vendor tree hash mismatch: expected ${manifest.vendor.tree_sha256}, received ${tree.sha256}`,
	);
}

const allowlist = [...manifest.vendor.allowlist].sort();
const vendorFiles = tree.files.map((file) => file.split(sep).join("/")).sort();
if (JSON.stringify(allowlist) !== JSON.stringify(vendorFiles)) {
	throw new Error("The vendor tree does not match the manifest allowlist");
}

if (!process.argv.includes("--verify")) {
	if (manifest.vendor.status !== "pending" || allowlist.length !== 0) {
		throw new Error("Upstream synchronization is not implemented for a populated vendor allowlist");
	}
	console.log("No upstream files are selected in the 0.0.0 skeleton.");
} else {
	console.log(
		`Verified OpenAI Codex ${manifest.official.version} source pin and vendor tree ${tree.sha256}.`,
	);
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { TomlTable } from "smol-toml";
import { parse, stringify } from "smol-toml";

const officialVersion = "0.144.3";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialWorkspaceRoot = resolve(repositoryRoot, "native/official");
const vendorRoot = resolve(repositoryRoot, "native/vendor/openai-codex");

const selectedCrates = [
	["codex-api", "codex-rs/codex-api"],
	["codex-async-utils", "codex-rs/async-utils"],
	["codex-client", "codex-rs/codex-client"],
	["codex-execpolicy", "codex-rs/execpolicy"],
	["codex-extension-items", "codex-rs/ext/items"],
	["codex-http-client", "codex-rs/http-client"],
	["codex-network-proxy", "codex-rs/network-proxy"],
	["codex-protocol", "codex-rs/protocol"],
	["codex-utils-absolute-path", "codex-rs/utils/absolute-path"],
	["codex-utils-cache", "codex-rs/utils/cache"],
	["codex-utils-home-dir", "codex-rs/utils/home-dir"],
	["codex-utils-image", "codex-rs/utils/image"],
	["codex-utils-output-truncation", "codex-rs/utils/output-truncation"],
	["codex-utils-path-uri", "codex-rs/utils/path-uri"],
	["codex-utils-pty", "codex-rs/utils/pty"],
	["codex-utils-rustls-provider", "codex-rs/utils/rustls-provider"],
	["codex-utils-string", "codex-rs/utils/string"],
	["codex-websocket-client", "codex-rs/websocket-client"],
] as const;

function normalizePath(path: string): string {
	return path.split(sep).join("/");
}

function isTomlTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function generateWrapper(packageName: string, sourcePath: string): Promise<string> {
	const sourceManifestPath = resolve(vendorRoot, sourcePath, "Cargo.toml");
	const sourceManifest = parse(await readFile(sourceManifestPath, "utf8")) as TomlTable;
	const sourcePackage = sourceManifest.package;
	if (!isTomlTable(sourcePackage) || sourcePackage.name !== packageName) {
		throw new Error(`Unexpected package identity in ${sourcePath}/Cargo.toml`);
	}
	const dependencies = sourceManifest.dependencies;
	if (!isTomlTable(dependencies)) {
		throw new Error(`Missing dependency table in ${sourcePath}/Cargo.toml`);
	}

	const wrapperDirectory = resolve(officialWorkspaceRoot, "crates", packageName);
	const library: TomlTable = isTomlTable(sourceManifest.lib) ? { ...sourceManifest.lib } : {};
	library.path = normalizePath(
		relative(wrapperDirectory, resolve(vendorRoot, sourcePath, "src/lib.rs")),
	);

	const wrapper: TomlTable = {
		package: {
			name: packageName,
			version: officialVersion,
			edition: "2024",
			license: "Apache-2.0",
			publish: false,
			"rust-version": "1.95",
		},
		lib: library,
		dependencies,
	};
	if (isTomlTable(sourceManifest.target)) {
		wrapper.target = sourceManifest.target;
	}

	return `${stringify(wrapper).trimEnd()}\n`;
}

const check = process.argv.includes("--check");
for (const [packageName, sourcePath] of selectedCrates) {
	const wrapperPath = resolve(officialWorkspaceRoot, "crates", packageName, "Cargo.toml");
	const generated = await generateWrapper(packageName, sourcePath);
	if (check) {
		const current = await readFile(wrapperPath, "utf8");
		if (current !== generated) {
			throw new Error(
				`Official wrapper is stale: native/official/crates/${packageName}/Cargo.toml`,
			);
		}
	} else {
		await mkdir(dirname(wrapperPath), { recursive: true });
		await writeFile(wrapperPath, generated);
	}
}

console.log(
	`${check ? "Verified" : "Generated"} ${selectedCrates.length} official crate wrappers.`,
);

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	assertDirectoryContainsNoVendorFiles,
	assertLicenseInventory,
	assertNativeSbom,
	assertVendorClosure,
	collectFiles,
	type LicenseInventory,
	type NativeSbom,
	readAssignedStringConstant,
	type UpstreamManifest,
	verifyPinnedSourceHashes,
} from "../../scripts/sync-codex-upstream.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(resolve(tmpdir(), "pi-codex-upstream-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function manifest(): UpstreamManifest {
	return {
		schema_version: 1,
		official: {
			version: "0.144.3",
			tag: "rust-v0.144.3",
			annotated_tag_object: "a".repeat(40),
			source_commit: "b".repeat(40),
			repository: "https://example.invalid/codex",
			license: "Apache-2.0",
			rust_toolchain: "1.95.0",
		},
		vendor: {
			status: "ready",
			tree_sha256: "c".repeat(64),
			patches: [],
			excluded_crates: ["codex-app-server", "codex-core", "codex-exec-server", "codex-login"],
			selected_crates: [
				"codex-api",
				"codex-apply-patch-parser-modules",
				"codex-async-utils",
				"codex-client",
				"codex-core-p0-tool-specs",
				"codex-execpolicy",
				"codex-extension-items",
				"codex-http-client",
				"codex-image-generation-tool-contract",
				"codex-network-proxy",
				"codex-protocol",
				"codex-standalone-web-search-contract",
				"codex-tools-p0-modules",
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
			],
		},
	};
}

function licenseInventory(value: UpstreamManifest): LicenseInventory {
	const packages = [
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
		["codex-tools-p0-modules", "codex-rs/tools"],
		["codex-core-p0-tool-specs", "codex-rs/core/src/tools"],
		["codex-apply-patch-parser-modules", "codex-rs/apply-patch/src"],
		["codex-image-generation-tool-contract", "codex-rs/ext/image-generation"],
		["codex-standalone-web-search-contract", "codex-rs/ext/web-search"],
	] as const;
	return {
		schema_version: 1,
		official_version: value.official.version,
		source_commit: value.official.source_commit,
		license: value.official.license,
		license_files: ["LICENSE", "NOTICE"],
		packages: packages.map(([name, source_path]) => ({
			name,
			source_path,
			license: value.official.license,
		})),
	};
}

describe("upstream integrity", () => {
	test.skipIf(process.platform === "win32")("rejects symbolic links during traversal", async () => {
		const directory = await temporaryDirectory();
		await writeFile(resolve(directory, "target"), "content");
		await symlink("target", resolve(directory, "link"));

		await expect(collectFiles(directory)).rejects.toThrow("Symbolic links are not allowed");
	});

	test("requires an empty vendor directory before initialization", async () => {
		const directory = await temporaryDirectory();
		await writeFile(resolve(directory, ".gitkeep"), "");
		await expect(assertDirectoryContainsNoVendorFiles(directory)).resolves.toBeUndefined();
		await writeFile(resolve(directory, "unexpected"), "content");
		await expect(assertDirectoryContainsNoVendorFiles(directory)).rejects.toThrow(
			"requires an empty vendor tree",
		);
	});

	test("requires the exact selected package and license inventory", () => {
		const value = manifest();
		const inventory = licenseInventory(value);
		expect(() => assertLicenseInventory(inventory, value)).not.toThrow();
		inventory.packages.pop();
		expect(() => assertLicenseInventory(inventory, value)).toThrow(
			"selected upstream package closure",
		);
	});

	test("requires the manifest to declare the exact vendor closure", () => {
		expect(() => assertVendorClosure(manifest())).not.toThrow();

		const missing = manifest();
		missing.vendor.selected_crates.pop();
		expect(() => assertVendorClosure(missing)).toThrow("vendor.selected_crates");

		const extra = manifest();
		extra.vendor.selected_crates.push("unexpected-crate");
		expect(() => assertVendorClosure(extra)).toThrow("vendor.selected_crates");

		const duplicate = manifest();
		duplicate.vendor.selected_crates.push("codex-api");
		expect(() => assertVendorClosure(duplicate)).toThrow("vendor.selected_crates");

		const excluded = manifest();
		excluded.vendor.excluded_crates.pop();
		expect(() => assertVendorClosure(excluded)).toThrow("vendor.excluded_crates");
	});

	test("binds the SBOM to the pinned source and Cargo.lock", () => {
		const value = manifest();
		const sbom: NativeSbom = {
			schema_version: 1,
			official_version: value.official.version,
			official_source_commit: value.official.source_commit,
			cargo_lock_sha256: "d".repeat(64),
		};
		expect(() => assertNativeSbom(sbom, value, "d".repeat(64))).not.toThrow();
		expect(() => assertNativeSbom(sbom, value, "e".repeat(64))).toThrow("Cargo.lock identity");
	});

	test("reads bridge identity values from their named assignments only", () => {
		const source = `
const UNRELATED = "expected";
export const OFFICIAL_CODEX_VERSION = "0.144.3";
`;
		expect(readAssignedStringConstant(source, "OFFICIAL_CODEX_VERSION")).toBe("0.144.3");
		expect(() => readAssignedStringConstant(source, "OFFICIAL_SOURCE_COMMIT")).toThrow(
			"exactly one string assignment",
		);
	});

	test("verifies recorded hashes against a pinned source without mutation", async () => {
		const directory = await temporaryDirectory();
		await mkdir(resolve(directory, "codex-rs"));
		const source = Buffer.from("pinned source");
		await writeFile(resolve(directory, "codex-rs", "file.rs"), source);
		const record = {
			schema_version: 1 as const,
			official_version: "0.144.3",
			source_commit: "b".repeat(40),
			files: [
				{
					path: "codex-rs/file.rs",
					source_sha256: createHash("sha256").update(source).digest("hex"),
					vendor_sha256: "f".repeat(64),
				},
			],
		};
		await expect(verifyPinnedSourceHashes(directory, record)).resolves.toBeUndefined();
		const [file] = record.files;
		if (file === undefined) {
			throw new Error("source fixture is missing");
		}
		file.source_sha256 = "0".repeat(64);
		await expect(verifyPinnedSourceHashes(directory, record)).rejects.toThrow(
			"Pinned source hash mismatch",
		);
	});
});

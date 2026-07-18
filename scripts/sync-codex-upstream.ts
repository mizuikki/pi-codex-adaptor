import { createHash } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

export interface UpstreamManifest {
	schema_version: number;
	official: {
		version: string;
		tag: string;
		annotated_tag_object: string;
		source_commit: string;
		repository: string;
		license: string;
		rust_toolchain: string;
	};
	vendor: {
		status: "pending" | "ready";
		tree_sha256: string;
		allowlist_manifest?: string;
		allowlist_sha256?: string;
		license_inventory?: string;
		license_inventory_sha256?: string;
		sbom?: string;
		sbom_sha256?: string;
		patches: string[];
		excluded_crates: string[];
		selected_crates: string[];
	};
}

export interface VendorFileRecord {
	path: string;
	source_sha256: string;
	vendor_sha256: string;
}

export interface VendorFileManifest {
	schema_version: 1;
	official_version: string;
	source_commit: string;
	files: VendorFileRecord[];
}

export interface LicenseInventory {
	schema_version: 1;
	official_version: string;
	source_commit: string;
	license: string;
	license_files: string[];
	packages: Array<{ name: string; source_path: string; license: string }>;
}

export interface NativeSbom {
	schema_version: number;
	official_version: string;
	official_source_commit: string;
	cargo_lock_sha256: string;
}

const expectedBaseline = {
	annotatedTagObject: "13307a9036baccd2c51b685d1457a4b89b5b2f3b",
	rustToolchain: "1.95.0",
	sourceCommit: "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c",
	tag: "rust-v0.144.3",
	version: "0.144.3",
} as const;

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

const selectedSourcePaths = [
	"LICENSE",
	"NOTICE",
	"codex-rs/Cargo.lock",
	"codex-rs/Cargo.toml",
	"codex-rs/models-manager/models.json",
	"codex-rs/models-manager/prompt.md",
	...selectedCrates.map(([, path]) => path),
	"codex-rs/tools/Cargo.toml",
	"codex-rs/tools/src/dynamic_tool.rs",
	"codex-rs/tools/src/dynamic_tool_tests.rs",
	"codex-rs/tools/src/json_schema.rs",
	"codex-rs/tools/src/json_schema_tests.rs",
	"codex-rs/tools/src/mcp_tool.rs",
	"codex-rs/tools/src/mcp_tool_tests.rs",
	"codex-rs/tools/src/responses_api.rs",
	"codex-rs/tools/src/responses_api_tests.rs",
	"codex-rs/tools/src/response_history.rs",
	"codex-rs/tools/src/tool_definition.rs",
	"codex-rs/tools/src/tool_definition_tests.rs",
	"codex-rs/tools/src/tool_spec.rs",
	"codex-rs/tools/src/tool_spec_tests.rs",
	"codex-rs/core/src/tools/handlers/plan_spec.rs",
	"codex-rs/core/src/tools/handlers/apply_patch.lark",
	"codex-rs/core/src/tools/handlers/apply_patch_spec.rs",
	"codex-rs/core/src/tools/handlers/apply_patch_spec_tests.rs",
	"codex-rs/core/src/tools/handlers/shell_spec.rs",
	"codex-rs/core/src/tools/handlers/shell_spec_tests.rs",
	"codex-rs/core/src/tools/handlers/view_image_spec.rs",
	"codex-rs/core/src/tools/hosted_spec.rs",
	"codex-rs/core/src/tools/hosted_spec_tests.rs",
	"codex-rs/apply-patch/src/parser.rs",
	"codex-rs/apply-patch/src/seek_sequence.rs",
	"codex-rs/apply-patch/src/streaming_parser.rs",
	"codex-rs/ext/image-generation/imagegen_description.md",
	"codex-rs/ext/web-search/src/schema.rs",
	"codex-rs/ext/web-search/web_run_description.md",
] as const;

const supplementalLicensePackages = [
	["codex-model-metadata", "codex-rs/models-manager"],
	["codex-tools-p0-modules", "codex-rs/tools"],
	["codex-core-p0-tool-specs", "codex-rs/core/src/tools"],
	["codex-apply-patch-parser-modules", "codex-rs/apply-patch/src"],
	["codex-image-generation-tool-contract", "codex-rs/ext/image-generation"],
	["codex-standalone-web-search-contract", "codex-rs/ext/web-search"],
] as const;

const excludedCrates = ["codex-app-server", "codex-core", "codex-exec-server", "codex-login"];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(repositoryRoot, "native/vendor/openai-codex");
const defaultFileManifestPath = "native/upstream/openai-codex-files.json";
const defaultLicenseInventoryPath = "native/upstream/openai-codex-licenses.json";

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizePath(path: string): string {
	return path.split(sep).join("/");
}

function resolveWithin(root: string, path: string): string {
	const absolute = resolve(root, path);
	const relativePath = relative(root, absolute);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(path)
	) {
		throw new Error("Recorded upstream path escapes its allowed root");
	}
	return absolute;
}

export async function collectFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const paths: string[] = [];

	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`Symbolic links are not allowed in the upstream tree: ${path}`);
		} else if (entry.isDirectory()) {
			paths.push(...(await collectFiles(path)));
		} else if (entry.isFile() && entry.name !== ".gitkeep") {
			paths.push(path);
		} else if (!entry.isFile()) {
			throw new Error(`Unsupported file type in the upstream tree: ${path}`);
		}
	}

	return paths.sort();
}

export async function assertDirectoryContainsNoVendorFiles(directory: string): Promise<void> {
	const files = await collectFiles(directory);
	if (files.length !== 0) {
		throw new Error("Vendor initialization requires an empty vendor tree");
	}
}

async function collectSelectedSourceFiles(sourceRoot: string): Promise<string[]> {
	const files: string[] = [];
	for (const selectedPath of selectedSourcePaths) {
		const absolutePath = resolveWithin(sourceRoot, selectedPath);
		const metadata = await lstat(absolutePath);
		if (metadata.isDirectory()) {
			files.push(...(await collectFiles(absolutePath)));
		} else if (metadata.isFile()) {
			files.push(absolutePath);
		} else {
			throw new Error(`Selected upstream path is not a regular file or directory: ${selectedPath}`);
		}
	}

	return [...new Set(files.map((file) => normalizePath(relative(sourceRoot, file))))].sort();
}

async function calculateTreeHash(): Promise<{ files: string[]; sha256: string }> {
	const files = await collectFiles(vendorRoot);
	const tree = createHash("sha256");

	for (const file of files) {
		const relativePath = normalizePath(relative(vendorRoot, file));
		const fileHash = sha256(await readFile(file));
		tree.update(`${relativePath}\0${fileHash}\n`);
	}

	return {
		files: files.map((file) => normalizePath(relative(vendorRoot, file))),
		sha256: tree.digest("hex"),
	};
}

async function run(command: string[]): Promise<string> {
	const processResult = Bun.spawn(command, {
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		processResult.exited,
		new Response(processResult.stdout).text(),
		new Response(processResult.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`${command[0]} exited with status ${exitCode}`);
	}
	return stdout.trim();
}

async function fetchPinnedSource(manifest: UpstreamManifest): Promise<{
	root: string;
	dispose: () => Promise<void>;
}> {
	const checkoutRoot = await mkdtemp(resolve(tmpdir(), "pi-codex-upstream-"));
	try {
		await run(["git", "init", "--quiet", checkoutRoot]);
		await run(["git", "-C", checkoutRoot, "remote", "add", "origin", manifest.official.repository]);
		await run([
			"git",
			"-C",
			checkoutRoot,
			"fetch",
			"--quiet",
			"--depth=1",
			"origin",
			`refs/tags/${manifest.official.tag}:refs/tags/${manifest.official.tag}`,
		]);

		const tagObject = await run([
			"git",
			"-C",
			checkoutRoot,
			"rev-parse",
			`refs/tags/${manifest.official.tag}`,
		]);
		if (tagObject !== manifest.official.annotated_tag_object) {
			throw new Error("Fetched tag object does not match UPSTREAM_CODEX.toml");
		}

		const sourceCommit = await run([
			"git",
			"-C",
			checkoutRoot,
			"rev-parse",
			`refs/tags/${manifest.official.tag}^{commit}`,
		]);
		if (sourceCommit !== manifest.official.source_commit) {
			throw new Error("Fetched tag does not peel to the pinned source commit");
		}

		await run(["git", "-C", checkoutRoot, "checkout", "--quiet", "--detach", sourceCommit]);
		return {
			root: checkoutRoot,
			dispose: () => rm(checkoutRoot, { force: true, recursive: true }),
		};
	} catch (error) {
		await rm(checkoutRoot, { force: true, recursive: true });
		throw error;
	}
}

async function copySourceFiles(sourceRoot: string, paths: string[]): Promise<void> {
	await rm(vendorRoot, { force: true, recursive: true });
	await mkdir(vendorRoot, { recursive: true });

	for (const path of paths) {
		const destination = resolveWithin(vendorRoot, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolveWithin(sourceRoot, path), destination);
	}
}

async function applyVendorPatches(manifest: UpstreamManifest): Promise<void> {
	for (const patch of manifest.vendor.patches) {
		if (!patch.startsWith("native/patches/openai-codex/")) {
			throw new Error("Vendor patches must live under native/patches/openai-codex");
		}
		const patchPath = resolveWithin(repositoryRoot, patch);
		const patchMetadata = await lstat(patchPath);
		if (!patchMetadata.isFile()) {
			throw new Error("Recorded vendor patch is not a regular file");
		}
		await run([
			"git",
			"-C",
			repositoryRoot,
			"apply",
			"--check",
			"--directory=native/vendor/openai-codex",
			patchPath,
		]);
		await run([
			"git",
			"-C",
			repositoryRoot,
			"apply",
			"--directory=native/vendor/openai-codex",
			patchPath,
		]);
	}
}

async function readVendorFileManifest(
	manifest: UpstreamManifest,
): Promise<{ path: string; bytes: Uint8Array; value: VendorFileManifest }> {
	const path = manifest.vendor.allowlist_manifest;
	if (path === undefined) {
		throw new Error("UPSTREAM_CODEX.toml does not declare a vendor allowlist manifest");
	}
	const bytes = await readFile(resolveWithin(repositoryRoot, path));
	if (sha256(bytes) !== manifest.vendor.allowlist_sha256) {
		throw new Error("Vendor allowlist manifest hash does not match UPSTREAM_CODEX.toml");
	}
	const value = JSON.parse(bytes.toString()) as VendorFileManifest;
	if (
		value.schema_version !== 1 ||
		value.official_version !== manifest.official.version ||
		value.source_commit !== manifest.official.source_commit
	) {
		throw new Error("Vendor allowlist manifest has incompatible baseline metadata");
	}
	const paths = value.files.map((file) => file.path);
	if (
		new Set(paths).size !== paths.length ||
		paths.some((path) => normalizePath(path) !== path) ||
		value.files.some(
			(file) =>
				!/^[0-9a-f]{64}$/.test(file.source_sha256) || !/^[0-9a-f]{64}$/.test(file.vendor_sha256),
		)
	) {
		throw new Error("Vendor allowlist manifest contains invalid file records");
	}
	return { path, bytes, value };
}

async function verifyVendorFiles(
	manifest: UpstreamManifest,
	fileManifest: VendorFileManifest,
): Promise<void> {
	const tree = await calculateTreeHash();
	if (tree.sha256 !== manifest.vendor.tree_sha256) {
		throw new Error(
			`Vendor tree hash mismatch: expected ${manifest.vendor.tree_sha256}, received ${tree.sha256}`,
		);
	}

	const recordedPaths = fileManifest.files.map((file) => file.path).sort();
	if (JSON.stringify(recordedPaths) !== JSON.stringify(tree.files.sort())) {
		throw new Error("The vendor tree does not match the recorded file allowlist");
	}

	for (const file of fileManifest.files) {
		const actualHash = sha256(await readFile(resolveWithin(vendorRoot, file.path)));
		if (actualHash !== file.vendor_sha256) {
			throw new Error(`Vendored file hash mismatch: ${file.path}`);
		}
	}
}

function expectedLicensePackages(manifest: UpstreamManifest): LicenseInventory["packages"] {
	return [...selectedCrates, ...supplementalLicensePackages].map(([name, source_path]) => ({
		name,
		source_path,
		license: manifest.official.license,
	}));
}

function assertExactStringSet(actual: string[], expected: readonly string[], name: string): void {
	const uniqueActual = new Set(actual);
	if (
		uniqueActual.size !== actual.length ||
		JSON.stringify([...uniqueActual].sort()) !== JSON.stringify([...expected].sort())
	) {
		throw new Error(`UPSTREAM_CODEX.toml ${name} does not match the selected source closure`);
	}
}

export function assertVendorClosure(manifest: UpstreamManifest): void {
	assertExactStringSet(
		manifest.vendor.selected_crates,
		[...selectedCrates, ...supplementalLicensePackages].map(([name]) => name),
		"vendor.selected_crates",
	);
	assertExactStringSet(manifest.vendor.excluded_crates, excludedCrates, "vendor.excluded_crates");
}

export function assertLicenseInventory(
	inventory: LicenseInventory,
	manifest: UpstreamManifest,
): void {
	const expectedPackages = expectedLicensePackages(manifest);
	if (
		inventory.schema_version !== 1 ||
		inventory.official_version !== manifest.official.version ||
		inventory.source_commit !== manifest.official.source_commit ||
		inventory.license !== manifest.official.license ||
		JSON.stringify(inventory.license_files) !== JSON.stringify(["LICENSE", "NOTICE"]) ||
		JSON.stringify(inventory.packages) !== JSON.stringify(expectedPackages)
	) {
		throw new Error("License inventory does not match the selected upstream package closure");
	}
}

async function verifyLicenseInventory(manifest: UpstreamManifest): Promise<void> {
	const path = manifest.vendor.license_inventory;
	if (path === undefined) {
		throw new Error("UPSTREAM_CODEX.toml does not declare a license inventory");
	}
	const bytes = await readFile(resolveWithin(repositoryRoot, path));
	if (sha256(bytes) !== manifest.vendor.license_inventory_sha256) {
		throw new Error("License inventory hash does not match UPSTREAM_CODEX.toml");
	}
	const inventory = JSON.parse(bytes.toString()) as LicenseInventory;
	assertLicenseInventory(inventory, manifest);
	for (const licenseFile of inventory.license_files) {
		const metadata = await lstat(resolveWithin(vendorRoot, licenseFile));
		if (!metadata.isFile()) {
			throw new Error(`Recorded license is not a regular file: ${licenseFile}`);
		}
	}
}

export function assertNativeSbom(
	sbom: NativeSbom,
	manifest: UpstreamManifest,
	cargoLockSha256?: string,
): void {
	if (
		sbom.schema_version !== 1 ||
		sbom.official_version !== manifest.official.version ||
		sbom.official_source_commit !== manifest.official.source_commit ||
		(cargoLockSha256 !== undefined && sbom.cargo_lock_sha256 !== cargoLockSha256)
	) {
		throw new Error("Native SBOM does not match the pinned upstream and Cargo.lock identity");
	}
}

async function verifySbom(manifest: UpstreamManifest): Promise<void> {
	const path = manifest.vendor.sbom;
	if (path === undefined) {
		throw new Error("UPSTREAM_CODEX.toml does not declare a native SBOM");
	}
	const bytes = await readFile(resolveWithin(repositoryRoot, path));
	if (sha256(bytes) !== manifest.vendor.sbom_sha256) {
		throw new Error("Native SBOM hash does not match UPSTREAM_CODEX.toml");
	}
	let sbom: NativeSbom;
	try {
		sbom = JSON.parse(bytes.toString()) as NativeSbom;
	} catch (error) {
		throw new Error("Native SBOM is not valid JSON", { cause: error });
	}
	const cargoLock = await readFile(resolve(repositoryRoot, "native/Cargo.lock"));
	assertNativeSbom(sbom, manifest, sha256(cargoLock));
}

export function readAssignedStringConstant(source: string, name: string): string {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const assignments = [
		...source.matchAll(new RegExp(`\\b${escapedName}\\b[^=\\n]*=\\s*["']([^"']+)["']`, "g")),
	];
	const value = assignments[0]?.[1];
	if (assignments.length !== 1 || value === undefined) {
		throw new Error(`Bridge identity constant ${name} must have exactly one string assignment`);
	}
	return value;
}

async function verifyIdentitySources(manifest: UpstreamManifest): Promise<void> {
	const [rustSource, typeScriptSource] = await Promise.all([
		readFile(resolve(repositoryRoot, "native/crates/bridge-protocol/src/lib.rs"), "utf8"),
		readFile(resolve(repositoryRoot, "src/infrastructure/codex-bridge/identity.ts"), "utf8"),
	]);
	for (const [name, expected] of Object.entries({
		OFFICIAL_CODEX_TAG: manifest.official.tag,
		OFFICIAL_CODEX_VERSION: manifest.official.version,
		OFFICIAL_SOURCE_COMMIT: manifest.official.source_commit,
		VENDOR_TREE_SHA256: manifest.vendor.tree_sha256,
	})) {
		if (
			readAssignedStringConstant(rustSource, name) !== expected ||
			readAssignedStringConstant(typeScriptSource, name) !== expected
		) {
			throw new Error(`Bridge identity field ${name} is not synchronized with UPSTREAM_CODEX.toml`);
		}
	}
}

async function writeSelectedVendor(
	manifest: UpstreamManifest,
	allowReadyManifest: boolean,
): Promise<void> {
	if (manifest.vendor.status !== "pending" && !allowReadyManifest) {
		throw new Error("Vendor initialization is allowed only while the manifest status is pending");
	}
	if (!allowReadyManifest) {
		await assertDirectoryContainsNoVendorFiles(vendorRoot);
	}
	const checkout = await fetchPinnedSource(manifest);
	try {
		const selectedFiles = await collectSelectedSourceFiles(checkout.root);
		await copySourceFiles(checkout.root, selectedFiles);
		await applyVendorPatches(manifest);
		const files: VendorFileRecord[] = [];
		for (const path of selectedFiles) {
			const sourceHash = sha256(await readFile(resolveWithin(checkout.root, path)));
			const vendorHash = sha256(await readFile(resolveWithin(vendorRoot, path)));
			files.push({ path, source_sha256: sourceHash, vendor_sha256: vendorHash });
		}

		const fileManifest: VendorFileManifest = {
			schema_version: 1,
			official_version: manifest.official.version,
			source_commit: manifest.official.source_commit,
			files,
		};
		const fileManifestBytes = `${JSON.stringify(fileManifest, null, 2)}\n`;
		await mkdir(resolve(repositoryRoot, "native/upstream"), { recursive: true });
		await writeFile(resolve(repositoryRoot, defaultFileManifestPath), fileManifestBytes);

		const inventory: LicenseInventory = {
			schema_version: 1,
			official_version: manifest.official.version,
			source_commit: manifest.official.source_commit,
			license: manifest.official.license,
			license_files: ["LICENSE", "NOTICE"],
			packages: expectedLicensePackages(manifest),
		};
		const licenseInventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
		await writeFile(resolve(repositoryRoot, defaultLicenseInventoryPath), licenseInventoryBytes);

		const tree = await calculateTreeHash();
		console.log(
			JSON.stringify(
				{
					allowlist_manifest: defaultFileManifestPath,
					allowlist_sha256: sha256(fileManifestBytes),
					file_count: files.length,
					license_inventory: defaultLicenseInventoryPath,
					license_inventory_sha256: sha256(licenseInventoryBytes),
					tree_sha256: tree.sha256,
				},
				null,
				2,
			),
		);
	} finally {
		await checkout.dispose();
	}
}

export async function verifyPinnedSourceHashes(
	sourceRoot: string,
	fileManifest: VendorFileManifest,
): Promise<void> {
	for (const file of fileManifest.files) {
		const sourcePath = resolveWithin(sourceRoot, file.path);
		const metadata = await lstat(sourcePath);
		if (!metadata.isFile()) {
			throw new Error(`Pinned source path is not a regular file: ${file.path}`);
		}
		const sourceHash = sha256(await readFile(sourcePath));
		if (sourceHash !== file.source_sha256) {
			throw new Error(`Pinned source hash mismatch: ${file.path}`);
		}
	}
}

async function verifyPinnedSource(
	manifest: UpstreamManifest,
	fileManifest: VendorFileManifest,
): Promise<void> {
	const checkout = await fetchPinnedSource(manifest);
	try {
		await verifyPinnedSourceHashes(checkout.root, fileManifest);
	} finally {
		await checkout.dispose();
	}
}

async function synchronizeVendor(
	manifest: UpstreamManifest,
	fileManifest: VendorFileManifest,
): Promise<void> {
	const checkout = await fetchPinnedSource(manifest);
	try {
		await verifyPinnedSourceHashes(checkout.root, fileManifest);
		await copySourceFiles(
			checkout.root,
			fileManifest.files.map((file) => file.path),
		);
		await applyVendorPatches(manifest);
		await verifyVendorFiles(manifest, fileManifest);
	} finally {
		await checkout.dispose();
	}
}

async function main(): Promise<void> {
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
	assertVendorClosure(manifest);

	if (process.argv.includes("--initialize")) {
		await writeSelectedVendor(manifest, false);
	} else if (process.argv.includes("--refresh-allowlist")) {
		await writeSelectedVendor(manifest, true);
	} else if (manifest.vendor.status === "pending") {
		const tree = await calculateTreeHash();
		if (
			tree.sha256 !== manifest.vendor.tree_sha256 ||
			tree.files.length !== 0 ||
			manifest.vendor.tree_sha256 !== sha256("")
		) {
			throw new Error("Pending vendor state must contain only the recorded empty tree");
		}
		await verifyIdentitySources(manifest);
		console.log(`Verified pending OpenAI Codex ${manifest.official.version} vendor state.`);
	} else {
		const { value: fileManifest } = await readVendorFileManifest(manifest);
		if (process.argv.includes("--sync")) {
			await synchronizeVendor(manifest, fileManifest);
		} else if (process.argv.includes("--verify-source")) {
			await verifyPinnedSource(manifest, fileManifest);
		}
		await verifyVendorFiles(manifest, fileManifest);
		await verifyLicenseInventory(manifest);
		await verifySbom(manifest);
		await verifyIdentitySources(manifest);
		console.log(
			`Verified OpenAI Codex ${manifest.official.version} vendor tree ${manifest.vendor.tree_sha256}.`,
		);
	}
}

if (import.meta.main) {
	await main();
}

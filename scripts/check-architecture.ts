import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ArchitectureLayer = "domain" | "application";

export interface ArchitectureViolation {
	file: string;
	specifier: string;
	reason: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(repositoryRoot, "src");

const FORBIDDEN_PACKAGE_PREFIXES = ["@earendil-works/", "@openai/", "pi-tui", "typebox"] as const;

const FORBIDDEN_NODE_MODULES = new Set([
	"assert",
	"async_hooks",
	"buffer",
	"child_process",
	"cluster",
	"console",
	"constants",
	"crypto",
	"dgram",
	"diagnostics_channel",
	"dns",
	"domain",
	"events",
	"fs",
	"fs/promises",
	"http",
	"http2",
	"https",
	"inspector",
	"module",
	"net",
	"os",
	"path",
	"path/posix",
	"path/win32",
	"perf_hooks",
	"process",
	"punycode",
	"querystring",
	"readline",
	"repl",
	"stream",
	"stream/promises",
	"string_decoder",
	"sys",
	"timers",
	"tls",
	"trace_events",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"wasi",
	"worker_threads",
	"zlib",
]);

const FORBIDDEN_BUN_MODULES = new Set(["bun:ffi", "bun:sqlite", "bun:jsc"]);

const IMPORT_PATTERN =
	/(?:import|export)(?:\s+type)?(?:\s+[\s\S]*?\s+from\s*|\s*)["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

export function layerForFile(filePath: string): ArchitectureLayer | undefined {
	const normalized = filePath.split(sep).join("/");
	if (normalized.includes("/src/domain/") || normalized.endsWith("/src/domain")) {
		return "domain";
	}
	if (normalized.includes("/src/application/") || normalized.endsWith("/src/application")) {
		return "application";
	}
	return undefined;
}

export function analyzeSource(
	filePath: string,
	source: string,
	layer: ArchitectureLayer = layerForFile(filePath) ?? "domain",
): ArchitectureViolation[] {
	const violations: ArchitectureViolation[] = [];
	for (const match of source.matchAll(IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2];
		if (specifier === undefined) {
			continue;
		}
		const reason = classifyImport(filePath, layer, specifier);
		if (reason !== undefined) {
			violations.push({
				file: filePath,
				specifier,
				reason,
			});
		}
	}
	return violations;
}

export function classifyImport(
	filePath: string,
	layer: ArchitectureLayer,
	specifier: string,
): string | undefined {
	if (specifier.startsWith("node:")) {
		return `forbids Node.js module '${specifier}'`;
	}
	if (FORBIDDEN_BUN_MODULES.has(specifier) || specifier.startsWith("bun:")) {
		return `forbids Bun module '${specifier}'`;
	}
	if (FORBIDDEN_NODE_MODULES.has(specifier)) {
		return `forbids Node.js module '${specifier}'`;
	}
	for (const prefix of FORBIDDEN_PACKAGE_PREFIXES) {
		if (specifier === prefix || specifier.startsWith(prefix)) {
			return `forbids package '${specifier}'`;
		}
	}
	if (specifier.startsWith(".")) {
		return classifyRelativeImport(filePath, layer, specifier);
	}
	if (layer === "domain") {
		return `forbids external package '${specifier}'`;
	}
	if (layer === "application" && !specifier.startsWith("#")) {
		// Application may only depend on domain modules via relative imports.
		return `forbids external package '${specifier}'`;
	}
	return undefined;
}

function classifyRelativeImport(
	filePath: string,
	layer: ArchitectureLayer,
	specifier: string,
): string | undefined {
	const resolved = resolve(dirname(filePath), specifier);
	const relativeToSource = relative(SOURCE_ROOT, resolved).split(sep).join("/");
	if (relativeToSource.startsWith("..")) {
		return `forbids import outside src ('${specifier}')`;
	}
	const targetLayer = topLevelLayer(relativeToSource);
	if (layer === "domain") {
		if (targetLayer !== "domain") {
			return `domain may only import domain modules ('${specifier}')`;
		}
		return undefined;
	}
	if (targetLayer === "domain" || targetLayer === "application") {
		return undefined;
	}
	if (targetLayer === "integration" || targetLayer === "ui" || targetLayer === "infrastructure") {
		return `application may not import ${targetLayer} ('${specifier}')`;
	}
	return `application may not import '${specifier}'`;
}

function topLevelLayer(relativeToSource: string): string {
	const [head] = relativeToSource.split("/");
	return head ?? "";
}

export async function collectArchitectureViolations(
	root: string = repositoryRoot,
): Promise<ArchitectureViolation[]> {
	const files = [
		...(await listTypeScriptFiles(resolve(root, "src", "domain"))),
		...(await listTypeScriptFiles(resolve(root, "src", "application"))),
	].sort();
	const violations: ArchitectureViolation[] = [];
	for (const file of files) {
		const layer = layerForFile(file);
		if (layer === undefined) {
			continue;
		}
		const source = await readFile(file, "utf8");
		violations.push(...analyzeSource(file, source, layer));
	}
	return violations;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listTypeScriptFiles(fullPath)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(fullPath);
		}
	}
	return files;
}

async function main(): Promise<void> {
	const violations = await collectArchitectureViolations();
	if (violations.length === 0) {
		console.log("Architecture dependency boundary check passed.");
		return;
	}
	for (const violation of violations) {
		const displayPath = relative(repositoryRoot, violation.file).split(sep).join("/");
		console.error(`${displayPath}: ${violation.reason}`);
	}
	throw new Error(
		`Architecture dependency boundary check failed with ${violations.length} violation(s)`,
	);
}

if (import.meta.main) {
	await main();
}

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const sourceRoots = [resolve(repositoryRoot, "src"), resolve(repositoryRoot, "native", "crates")];
const forbiddenProductionIdentifiers = [
	"summarizeContext",
	"contexts.summarize",
	"portable_context_summary",
	"CodexPortableCompactionDetailsV3",
	"CodexLegacyCompactionDetailsV2",
	"CodexLegacyCompactionDetailsV1",
	"CodexAutoCompactionCheckpointV1",
	"pi-codex-adaptor.auto-compaction",
	"portable-primary",
	"summarySha256",
] as const;

async function collectFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(path)));
		} else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".rs"))) {
			files.push(path);
		}
	}
	return files;
}

async function main(): Promise<void> {
	const files = (await Promise.all(sourceRoots.map(collectFiles))).flat().sort();
	const violations: string[] = [];
	for (const file of files) {
		const source = await readFile(file, "utf8");
		for (const identifier of forbiddenProductionIdentifiers) {
			if (source.includes(identifier)) {
				violations.push(`${relative(repositoryRoot, file)} contains ${identifier}`);
			}
		}
	}
	if (violations.length > 0) {
		throw new Error(`Clean-slate compaction check failed:\n${violations.join("\n")}`);
	}
	console.log(`Clean-slate compaction check passed for ${files.length} production files.`);
}

if (import.meta.main) await main();

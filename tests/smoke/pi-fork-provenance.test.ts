import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = process.env.PI_FORK_PROJECT_ROOT;
const forkCommit = process.env.PI_EXTENSION_SDK_COMMIT;
const sdkVersion = process.env.PI_FORK_SDK_VERSION;
const packages = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

const forkTest =
	projectRoot === undefined || forkCommit === undefined || sdkVersion === undefined
		? test.skip
		: test;

describe("isolated Pi fork provenance", () => {
	forkTest("uses the selected private Pi SDK tarballs from the temporary consumer", async () => {
		if (projectRoot === undefined || forkCommit === undefined || sdkVersion === undefined) {
			throw new Error("Pi fork provenance environment is unavailable");
		}
		expect(repositoryRoot).toBe(resolve(projectRoot));
		expect(forkCommit).toMatch(/^[0-9a-f]{40}$/);

		for (const packageName of packages) {
			const packageDirectory = resolve(repositoryRoot, "node_modules", packageName);
			const manifest = JSON.parse(
				await readFile(resolve(packageDirectory, "package.json"), "utf8"),
			) as { name?: unknown; version?: unknown };
			expect(manifest.name).toBe(packageName);
			expect(manifest.version).toBe(sdkVersion);
		}
	});
});

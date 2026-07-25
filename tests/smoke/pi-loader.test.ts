import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const loaderProbe = resolve(repositoryRoot, "tests/smoke/helpers/verify-packed-tool-provenance.ts");

describe("Pi extension loading", () => {
	test("loads against the sibling private Pi host without network or credentials", async () => {
		const piHome = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-smoke-"));

		try {
			const child = Bun.spawn(
				[process.execPath, loaderProbe, resolve(repositoryRoot, "src/extension.ts")],
				{
					cwd: repositoryRoot,
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: piHome,
						PI_OFFLINE: "1",
					},
					stderr: "pipe",
					stdout: "pipe",
				},
			);

			const exitCode = await child.exited;
			expect(exitCode).toBe(0);
		} finally {
			await rm(piHome, { force: true, recursive: true });
		}
	}, 30_000);
});

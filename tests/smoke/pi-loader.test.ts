import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piCli = resolve(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

describe("Pi extension loading", () => {
	test("loads the extension through Pi 0.80.6 without network or credentials", async () => {
		const piHome = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-smoke-"));

		try {
			const child = Bun.spawn(
				[
					process.execPath,
					piCli,
					"--offline",
					"--no-session",
					"--no-tools",
					"--no-extensions",
					"--extension",
					resolve(repositoryRoot, "src/extension.ts"),
					"--list-models",
					"__pi_codex_adaptor_smoke__",
				],
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

			const [exitCode, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);

			expect(stderr).not.toContain("Failed to load extension");
			expect(exitCode).toBe(0);
		} finally {
			await rm(piHome, { force: true, recursive: true });
		}
	}, 30_000);
});

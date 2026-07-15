import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piCli = resolve(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

describe("exact npm tarball smoke", () => {
	test("installs the staged package into a temporary Pi home and loads the extension", async () => {
		const assemble = Bun.spawn(["bun", "scripts/assemble-package.ts"], {
			cwd: repositoryRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const [assembleCode] = await Promise.all([
			assemble.exited,
			new Response(assemble.stderr).text(),
			new Response(assemble.stdout).text(),
		]);
		expect(assembleCode).toBe(0);

		const pack = Bun.spawn(["npm", "pack", "./dist/package", "--json"], {
			cwd: repositoryRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const [packCode, packOutput] = await Promise.all([
			pack.exited,
			new Response(pack.stdout).text(),
			new Response(pack.stderr).text(),
		]);
		expect(packCode).toBe(0);
		const packResult = JSON.parse(packOutput) as
			| Array<{ filename?: string }>
			| Record<string, { filename?: string }>;
		const filename = Array.isArray(packResult)
			? packResult[0]?.filename
			: Object.values(packResult)[0]?.filename;
		expect(typeof filename).toBe("string");
		const tarball = resolve(repositoryRoot, filename as string);

		const installRoot = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pack-smoke-"));
		const piHome = await mkdtemp(resolve(tmpdir(), "pi-codex-adaptor-pack-home-"));
		try {
			const install = Bun.spawn(
				[
					"npm",
					"install",
					tarball,
					"--prefix",
					installRoot,
					"--ignore-scripts",
					"--omit=peer",
					"--no-fund",
					"--no-audit",
				],
				{ cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
			);
			const [installCode] = await Promise.all([
				install.exited,
				new Response(install.stderr).text(),
				new Response(install.stdout).text(),
			]);
			expect(installCode).toBe(0);

			const metadata = JSON.parse(
				await readFile(resolve(installRoot, "node_modules/pi-codex-adaptor/package.json"), "utf8"),
			) as { name?: string; pi?: { extensions?: string[] } };
			expect(metadata.name).toBe("pi-codex-adaptor");
			const extensionEntry = metadata.pi?.extensions?.[0];
			expect(typeof extensionEntry).toBe("string");
			const extensionPath = resolve(
				installRoot,
				"node_modules/pi-codex-adaptor",
				extensionEntry as string,
			);

			const child = Bun.spawn(
				[
					process.execPath,
					piCli,
					"--offline",
					"--no-session",
					"--no-tools",
					"--no-extensions",
					"--extension",
					extensionPath,
					"--list-models",
					"__pi_codex_adaptor_pack_smoke__",
				],
				{
					cwd: repositoryRoot,
					env: {
						...process.env,
						PI_CODING_AGENT_DIR: piHome,
						PI_OFFLINE: "1",
						CODEX_HOME: resolve(piHome, "codex-home"),
						HOME: piHome,
					},
					stderr: "pipe",
					stdin: "ignore",
					stdout: "pipe",
				},
			);
			const [exitCode, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect(stderr).not.toContain("Failed to load extension");
			expect(exitCode).toBe(0);
			expect(stderr).not.toContain("CODEX_HOME");
		} finally {
			await rm(installRoot, { force: true, recursive: true });
			await rm(piHome, { force: true, recursive: true });
			await rm(tarball, { force: true });
		}
	}, 120_000);
});

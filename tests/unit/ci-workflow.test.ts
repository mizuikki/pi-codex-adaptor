import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface ToolchainFixture {
	runtime: { rust: string };
}

interface CiWorkflow {
	jobs?: {
		check?: {
			strategy?: {
				matrix?: {
					include?: Array<{ os?: string; target?: string }>;
				};
			};
			steps?: Array<{ name?: string; run?: string | string[] }>;
		};
	};
}

function stepRun(run: string | string[] | undefined): string {
	if (run === undefined) return "";
	return Array.isArray(run) ? run.join("\n") : run;
}

describe("ci workflow portability", () => {
	test("provisions pinned Rust components, targets, and Linux musl tools", async () => {
		const fixture = JSON.parse(
			await readFile(resolve(repositoryRoot, "fixtures/toolchain.json"), "utf8"),
		) as ToolchainFixture;
		const workflow = parseYaml(
			await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
		) as CiWorkflow;

		const checkJob = workflow.jobs?.check;
		expect(checkJob).toBeDefined();
		const includes = checkJob?.strategy?.matrix?.include ?? [];
		expect(includes).toEqual([
			{ os: "ubuntu-24.04", target: "x86_64-unknown-linux-musl" },
			{ os: "macos-15", target: "aarch64-apple-darwin" },
			{ os: "windows-2025", target: "x86_64-pc-windows-msvc" },
		]);

		const rustStep = (checkJob?.steps ?? []).find((step) => {
			const script = stepRun(step.run);
			return (
				step.name === "Install Rust toolchain prerequisites" ||
				script.includes("rustup toolchain install")
			);
		});
		expect(rustStep).toBeDefined();
		const script = stepRun(rustStep?.run);
		expect(script.includes(`rustup toolchain install "${fixture.runtime.rust}"`)).toBe(true);
		expect(script.includes("clippy")).toBe(true);
		expect(script.includes("rustfmt")).toBe(true);
		expect(script.includes("rust-src")).toBe(true);
		expect(script.includes('rustup target add --toolchain "1.95.0"')).toBe(true);
		expect(script.includes("musl-tools")).toBe(true);
	});
});

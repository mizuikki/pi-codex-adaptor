import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

interface ToolchainFixture {
	runtime: {
		biome: string;
		bun: string;
		node: string;
		npm: string;
		pi: string;
		rust: string;
		typebox: string;
		typesNode: string;
		typescript: string;
	};
	githubActions: Record<string, { sha: string; version: string }>;
	schemaVersion: number;
}

interface PackageJson {
	devDependencies: Record<string, string>;
	overrides: Record<string, string>;
	packageManager: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
	await readFile(resolve(repositoryRoot, "fixtures/toolchain.json"), "utf8"),
) as ToolchainFixture;
const packageJson = JSON.parse(
	await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
) as PackageJson;

if (fixture.schemaVersion !== 1) {
	throw new Error(`Unsupported toolchain fixture schema: ${fixture.schemaVersion}`);
}

const expectedPackageVersions: Record<string, string> = {
	"@biomejs/biome": `^${fixture.runtime.biome}`,
	"@openai/codex": "0.144.3",
	"@openai/codex-sdk": "0.144.3",
	"@earendil-works/pi-agent-core": fixture.runtime.pi,
	"@earendil-works/pi-ai": fixture.runtime.pi,
	"@earendil-works/pi-coding-agent": fixture.runtime.pi,
	"@earendil-works/pi-tui": fixture.runtime.pi,
	"@types/node": `^${fixture.runtime.typesNode}`,
	typebox: fixture.runtime.typebox,
	typescript: `^${fixture.runtime.typescript}`,
};

if (packageJson.packageManager !== `bun@${fixture.runtime.bun}`) {
	throw new Error("packageManager does not match the toolchain fixture");
}

for (const [dependency, expectedVersion] of Object.entries(expectedPackageVersions)) {
	if (packageJson.devDependencies[dependency] !== expectedVersion) {
		throw new Error(`${dependency} does not match the toolchain fixture`);
	}
}

if (packageJson.overrides["@types/node"] !== fixture.runtime.typesNode) {
	throw new Error("The transitive @types/node override does not match the toolchain fixture");
}

const nodeVersion = (await readFile(resolve(repositoryRoot, ".node-version"), "utf8")).trim();
if (nodeVersion !== fixture.runtime.node) {
	throw new Error(".node-version does not match the toolchain fixture");
}

const rustToolchain = parseToml(
	await readFile(resolve(repositoryRoot, "rust-toolchain.toml"), "utf8"),
) as { toolchain?: { channel?: string } };
if (rustToolchain.toolchain?.channel !== fixture.runtime.rust) {
	throw new Error("rust-toolchain.toml does not match the toolchain fixture");
}

const workflowDirectory = resolve(repositoryRoot, ".github/workflows");
const workflowFiles = (await readdir(workflowDirectory))
	.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
	.sort();
const usedActions = new Map<string, Set<string>>();

function collectActions(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) collectActions(item);
		return;
	}
	if (value === null || typeof value !== "object") return;

	for (const [key, child] of Object.entries(value)) {
		if (key === "uses" && typeof child === "string" && !child.startsWith("./")) {
			const separator = child.lastIndexOf("@");
			if (separator < 1) throw new Error(`Action is not pinned: ${child}`);
			const actionPath = child.slice(0, separator);
			const action = Object.keys(fixture.githubActions)
				.sort((left, right) => right.length - left.length)
				.find((candidate) => actionPath === candidate || actionPath.startsWith(`${candidate}/`));
			if (action === undefined) {
				throw new Error(`GitHub Action is missing from the toolchain fixture: ${actionPath}`);
			}
			const reference = child.slice(separator + 1);
			const references = usedActions.get(action) ?? new Set<string>();
			references.add(reference);
			usedActions.set(action, references);
		} else {
			collectActions(child);
		}
	}
}

for (const workflowFile of workflowFiles) {
	collectActions(parseYaml(await readFile(resolve(workflowDirectory, workflowFile), "utf8")));
}

for (const [action, references] of usedActions) {
	const expected = fixture.githubActions[action];
	if (expected === undefined) {
		throw new Error(`GitHub Action is missing from the toolchain fixture: ${action}`);
	}
	if (references.size !== 1 || !references.has(expected.sha)) {
		throw new Error(`${action} is not pinned to ${expected.sha}`);
	}
}

for (const action of Object.keys(fixture.githubActions)) {
	if (!usedActions.has(action)) {
		throw new Error(`Toolchain fixture contains an unused GitHub Action: ${action}`);
	}
}

const ciWorkflow = parseYaml(await readFile(resolve(workflowDirectory, "ci.yml"), "utf8")) as {
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
};

const checkJob = ciWorkflow.jobs?.check;
if (checkJob === undefined) {
	throw new Error("ci.yml is missing the check job");
}

const expectedTargets: Record<string, string> = {
	"ubuntu-24.04": "x86_64-unknown-linux-musl",
	"macos-15": "aarch64-apple-darwin",
	"windows-2025": "x86_64-pc-windows-msvc",
};
const matrixIncludes = checkJob.strategy?.matrix?.include ?? [];
for (const [os, target] of Object.entries(expectedTargets)) {
	const entry = matrixIncludes.find((candidate) => candidate.os === os);
	if (entry?.target !== target) {
		throw new Error(`ci.yml check matrix must pin ${os} to ${target}`);
	}
}

const rustSetupStep = (checkJob.steps ?? []).find((step) => {
	const script = normalizeStepRun(step.run);
	return (
		step.name === "Install Rust toolchain prerequisites" ||
		script.includes("rustup toolchain install")
	);
});
if (rustSetupStep === undefined) {
	throw new Error("ci.yml check job does not provision a Rust toolchain");
}

const rustSetupScript = normalizeStepRun(rustSetupStep.run);
if (
	!rustSetupScript.includes(`rustup toolchain install "${fixture.runtime.rust}"`) &&
	!rustSetupScript.includes(`rustup toolchain install ${fixture.runtime.rust}`)
) {
	throw new Error(`ci.yml must install pinned Rust ${fixture.runtime.rust}`);
}
for (const component of ["clippy", "rustfmt", "rust-src"]) {
	if (!rustSetupScript.includes(component)) {
		throw new Error(`ci.yml Rust setup must install the ${component} component`);
	}
}
if (!rustSetupScript.includes("rustup target add")) {
	throw new Error("ci.yml Rust setup must install the matrix native target");
}
if (!rustSetupScript.includes("musl-tools")) {
	throw new Error("ci.yml Rust setup must install Linux musl prerequisites");
}

console.log(
	`Verified pinned toolchains and ${usedActions.size} GitHub Actions across ${workflowFiles.length} workflows.`,
);

function normalizeStepRun(run: string | string[] | undefined): string {
	if (run === undefined) return "";
	return Array.isArray(run) ? run.join("\n") : run;
}

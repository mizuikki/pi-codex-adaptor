import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveNativeTarget } from "../src/infrastructure/codex-bridge/binary.ts";
import { BridgeClient, spawnBridgeTransport } from "../src/infrastructure/codex-bridge/client.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const target = argument("--target") ?? resolveNativeTarget();
const executableName = process.platform === "win32" ? "codex-bridge.exe" : "codex-bridge";
const executable =
	argument("--executable") ??
	resolve(repositoryRoot, "native", "target", target, "debug", executableName);
const outputPath = resolve(
	repositoryRoot,
	"fixtures",
	"official-conformance",
	"update-plan-hosted-web.json",
);
const coreToolsPath = resolve(
	repositoryRoot,
	"fixtures",
	"official-conformance",
	"core-tools.json",
);
const generatedToolsPath = resolve(
	repositoryRoot,
	"src",
	"integration",
	"pi",
	"generated",
	"core-tools.ts",
);

const client = await BridgeClient.connect({
	buildTarget: target,
	clientVersion: "fixture-generator",
	allowDevelopmentBuild: true,
	transport: spawnBridgeTransport(executable),
});

let generated: string;
let generatedCoreTools: string;
let generatedTypeScript: string;
let generatedContracts: Record<string, unknown>;
try {
	const result = await client.request("tools.resolve", {
		model: fixtureModel(),
		webSearchMode: "indexed",
		provider: { hostedWebSearch: true, namespaceTools: false, imageGeneration: false },
		standaloneWebSearch: { featureEnabled: false, executorAvailable: false },
		shell: { allowLoginShell: false, execPermissionApprovalsEnabled: false },
	});
	if (result.status !== "completed") {
		throw new Error("Official fixture generation did not complete");
	}
	generated = `${JSON.stringify(result.result, null, 2)}\n`;
	const unified = await resolveTools("unified_exec");
	const shell = await resolveTools("shell_command");
	const standaloneWeb = await resolveTools("disabled", true);
	const contracts = collectCoreContracts(unified, shell, standaloneWeb);
	generatedContracts = contracts;
	generatedCoreTools = `${JSON.stringify(contracts, null, 2)}\n`;
	generatedTypeScript = renderGeneratedTypeScript(contracts);
} finally {
	await client.shutdown();
}

if (process.argv.includes("--check")) {
	const committedCoreToolsText = await readFile(coreToolsPath, "utf8");
	const committedCoreTools = JSON.parse(committedCoreToolsText) as Record<string, unknown>;
	if (
		(await readFile(outputPath, "utf8")) !== generated ||
		JSON.stringify(platformStableContracts(committedCoreTools)) !==
			JSON.stringify(platformStableContracts(generatedContracts)) ||
		(await readFile(generatedToolsPath, "utf8")) !== renderGeneratedTypeScript(committedCoreTools)
	) {
		throw new Error("Official fixture or generated core tool contract is stale");
	}
} else {
	await Promise.all([
		writeFile(outputPath, generated),
		writeFile(coreToolsPath, generatedCoreTools),
		writeFile(generatedToolsPath, generatedTypeScript),
	]);
}

function renderGeneratedTypeScript(contracts: Record<string, unknown>): string {
	return [
		"// Generated from the pinned official Codex tool builders. Do not edit.",
		`export const OFFICIAL_CORE_TOOL_CONTRACTS = ${JSON.stringify(contracts, null, 2)} as const;`,
		`export const PI_CORE_TOOL_PARAMETERS = ${JSON.stringify(piExecutionParameters(contracts), null, 2)} as const;`,
		"",
	].join("\n");
}

function platformStableContracts(contracts: Record<string, unknown>): Record<string, unknown> {
	const stable: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(contracts)) {
		if (
			(name === "exec_command" || name === "shell_command") &&
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			const contract = value as Record<string, unknown>;
			if (typeof contract.description !== "string" || contract.description.length === 0) {
				throw new Error(`Official ${name} description must be non-empty`);
			}
			stable[name] = {
				...contract,
				description: "<official platform-specific shell description>",
			};
			continue;
		}
		stable[name] = value;
	}
	return stable;
}

async function resolveTools(
	shellType: string,
	standaloneWebSearch = false,
): Promise<Record<string, unknown>> {
	const result = await client.request("tools.resolve", {
		model: fixtureModel(shellType),
		webSearchMode: standaloneWebSearch ? "indexed" : "disabled",
		provider: { hostedWebSearch: true, namespaceTools: true, imageGeneration: true },
		standaloneWebSearch: {
			featureEnabled: standaloneWebSearch,
			executorAvailable: standaloneWebSearch,
		},
		shell: { allowLoginShell: true, execPermissionApprovalsEnabled: false },
		optional: { viewImage: true, imageGeneration: true },
	});
	if (
		result.status !== "completed" ||
		typeof result.result !== "object" ||
		result.result === null
	) {
		throw new Error("Official core tool fixture generation did not complete");
	}
	return result.result as Record<string, unknown>;
}

function collectCoreContracts(
	unified: Record<string, unknown>,
	shell: Record<string, unknown>,
	standaloneWeb: Record<string, unknown>,
): Record<string, unknown> {
	const values = [
		...(Array.isArray(unified.modelTools) ? unified.modelTools : []),
		...(Array.isArray(unified.dispatchTools) ? unified.dispatchTools : []),
		...(Array.isArray(shell.modelTools) ? shell.modelTools : []),
		...(Array.isArray(standaloneWeb.modelTools) ? standaloneWeb.modelTools : []),
	];
	const contracts: Record<string, unknown> = {};
	for (const value of values) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const contract = value as Record<string, unknown>;
		if (typeof contract.name === "string") contracts[contract.name] ??= contract;
	}
	for (const required of [
		"update_plan",
		"apply_patch",
		"image_gen",
		"web",
		"exec_command",
		"write_stdin",
		"shell_command",
		"view_image",
	]) {
		if (contracts[required] === undefined) {
			throw new Error(`Official core tool contract ${required} is missing`);
		}
	}
	return contracts;
}

function piExecutionParameters(contracts: Record<string, unknown>): Record<string, unknown> {
	const applyPatch = contracts.apply_patch as Record<string, unknown> | undefined;
	if (applyPatch?.type !== "custom") {
		throw new Error("Official apply_patch contract is not a custom tool");
	}
	return {
		apply_patch: {
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
			additionalProperties: false,
		},
	};
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) {
		return undefined;
	}
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function fixtureModel(shellType = "disabled"): Record<string, unknown> {
	return {
		slug: "fixture-model",
		display_name: "Fixture model",
		description: null,
		default_reasoning_level: null,
		supported_reasoning_levels: [],
		shell_type: shellType,
		visibility: "list",
		supported_in_api: true,
		priority: 1,
		availability_nux: null,
		upgrade: null,
		base_instructions: "",
		supports_reasoning_summaries: false,
		support_verbosity: false,
		default_verbosity: null,
		apply_patch_tool_type: "freeform",
		truncation_policy: { mode: "bytes", limit: 10_000 },
		supports_parallel_tool_calls: false,
		experimental_supported_tools: [],
	};
}

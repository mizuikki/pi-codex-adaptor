import { resolve } from "node:path";

import { resolveNativeTarget } from "../src/infrastructure/codex-bridge/binary.ts";
import { BridgeClient, spawnBridgeTransport } from "../src/infrastructure/codex-bridge/client.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_VERSION,
} from "../src/infrastructure/codex-bridge/protocol.ts";
import { fixtureToken } from "../tests/integration/helpers/fake-pi.ts";
import {
	fixtureModelSpec,
	startFakeResponsesServer,
} from "../tests/integration/helpers/fake-responses-server.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const target = argument("--target") ?? resolveNativeTarget();
const executableName = process.platform === "win32" ? "codex-bridge.exe" : "codex-bridge";
const executable =
	argument("--executable") ?? resolve(repositoryRoot, "native", "target", "debug", executableName);
const expectedBuildSourceCommit = argument("--source-commit");

const token = fixtureToken();
const server = await startFakeResponsesServer([
	fixtureModelSpec({ slug: "fixture-model", shellType: "shell_command" }),
]);

const connection = {
	providerId: "fixture-provider",
	baseUrl: server.baseUrl,
	headers: {},
	authentication: { kind: "bearer", token },
};

try {
	const client = await BridgeClient.connect({
		buildTarget: target,
		clientVersion: "integration-test",
		allowDevelopmentBuild: expectedBuildSourceCommit === undefined,
		...(expectedBuildSourceCommit === undefined ? {} : { expectedBuildSourceCommit }),
		transport: spawnBridgeTransport(executable),
	});

	try {
		const diagnostics = await client.request("diagnostics.read", {});
		if (diagnostics.status !== "completed" || !isExpectedDiagnostics(diagnostics.result, target)) {
			throw new Error("Native bridge diagnostics did not match the product contract");
		}

		const model = await client.request("models.resolve", {
			modelId: "fixture-model",
		});
		if (model.status !== "completed") {
			throw new Error("Native model resolution against the fake Responses server failed");
		}

		const events: string[] = [];
		const response = await client.request(
			"responses.create",
			{
				request: {
					model: "fixture-model",
					instructions: "",
					input: [],
					tools: null,
					tool_choice: "auto",
					parallel_tool_calls: false,
					reasoning: null,
					store: false,
					stream: true,
					include: [],
				},
				transportMode: "sse",
				providerSupportsWebsockets: false,
				connection,
			},
			{
				onEvent: (event) => {
					if (
						typeof event === "object" &&
						event !== null &&
						"type" in event &&
						typeof (event as { type: unknown }).type === "string"
					) {
						events.push((event as { type: string }).type);
					}
				},
			},
		);
		if (
			response.status !== "completed" ||
			!events.includes("response.output_text.delta") ||
			!events.includes("response.completed")
		) {
			throw new Error("Native responses.create did not complete against the fake Responses server");
		}

		const summary = await client.request("contexts.summarize", {
			modelId: "fixture-model",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "summarize this context" }],
				},
			],
			transportMode: "sse",
			providerSupportsWebsockets: false,
			connection,
		});
		if (
			summary.status !== "completed" ||
			typeof summary.result !== "object" ||
			summary.result === null ||
			(summary.result as { summary?: unknown }).summary !== "fixture"
		) {
			throw new Error(
				"Native contexts.summarize did not complete against the fake Responses server",
			);
		}

		const tools = await client.request("tools.resolve", {
			model: {
				slug: "fixture-model",
				display_name: "Fixture model",
				description: null,
				default_reasoning_level: null,
				supported_reasoning_levels: [],
				shell_type: "shell_command",
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
			},
			webSearchMode: "indexed",
			providerContract: buildProviderContractFixture(true, true, true, true),
			standaloneWebSearch: { featureEnabled: false, executorAvailable: true },
			sessions: { enabled: true, executorAvailable: true },
			shell: { allowLoginShell: false, execPermissionApprovalsEnabled: false },
			optional: { viewImage: true, imageGeneration: true },
		});
		if (tools.status !== "completed") {
			throw new Error("Native tools.resolve did not complete");
		}

		const command = await client.request(
			"tools.execute",
			{
				tool: "shell_command",
				authorization: "require_approval",
				command: process.platform === "win32" ? "echo fixture" : "printf fixture",
				workdir: repositoryRoot,
				workspaceRoots: [repositoryRoot],
				timeoutMs: 10_000,
				login: false,
				allowLoginShell: false,
				...(process.platform === "win32" ? { shell: "cmd.exe" } : {}),
			},
			{
				onApprovalRequest: (approval) => client.decideApproval(approval.approvalId, "allow_once"),
			},
		);
		if (
			command.status !== "completed" ||
			typeof command.result !== "object" ||
			command.result === null ||
			(command.result as { exitCode?: unknown }).exitCode !== 0
		) {
			throw new Error("Native shell execution did not complete");
		}

		let bypassApproval = false;
		const bypass = await client.request(
			"tools.execute",
			{
				tool: "shell_command",
				authorization: "preauthorized",
				command: process.platform === "win32" ? "echo fixture-bypass" : "printf fixture-bypass",
				workdir: repositoryRoot,
				workspaceRoots: [repositoryRoot],
				timeoutMs: 10_000,
				login: false,
				allowLoginShell: false,
				...(process.platform === "win32" ? { shell: "cmd.exe" } : {}),
			},
			{
				onApprovalRequest: (approval) => {
					bypassApproval = true;
					return client.decideApproval(approval.approvalId, "decline");
				},
			},
		);
		if (bypass.status !== "completed" || bypassApproval) {
			throw new Error("Native preauthorized shell execution did not bypass approval");
		}
	} finally {
		await client.shutdown();
	}
} finally {
	server.stop();
}

function buildProviderContractFixture(
	hostedWebSearch: boolean,
	namespaceTools: boolean,
	imagesApi: boolean,
	searchApi: boolean,
): Record<string, unknown> {
	return {
		responsesSse: true,
		responsesWebsocket: "official-only",
		remoteCompactionV2: true,
		compactEndpoint: true,
		namespaceTools,
		imagesApi,
		searchApi,
		hostedWebSearch,
	};
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function isExpectedDiagnostics(value: unknown, target: string): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const diagnostics = value as Record<string, unknown>;
	return (
		diagnostics.bridgeProtocolVersion === BRIDGE_PROTOCOL_VERSION &&
		diagnostics.officialCodexVersion === OFFICIAL_CODEX_VERSION &&
		diagnostics.buildTarget === target &&
		Array.isArray(diagnostics.compiledOfficialTypes) &&
		Array.isArray(diagnostics.capabilities) &&
		JSON.stringify(diagnostics.capabilities) ===
			JSON.stringify([
				"responses_sse",
				"responses_websocket",
				"portable_context_summary",
				"compact_endpoint",
				"remote_compaction_v2",
				"model_metadata",
				"update_plan",
				"hosted_web_search",
				"unified_exec",
				"shell_command",
				"apply_patch",
				"view_image",
				"image_generation",
				"standalone_web_search",
			])
	);
}

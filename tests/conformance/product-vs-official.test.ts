import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Codex } from "@openai/codex-sdk";

import { resolveNativeTarget } from "../../src/infrastructure/codex-bridge/binary.ts";
import {
	BridgeClient,
	spawnBridgeTransport,
} from "../../src/infrastructure/codex-bridge/client.ts";
import {
	firstPostedResponsesRequest,
	fixtureModelSpec,
	startFakeResponsesServer,
} from "../integration/helpers/fake-responses-server.ts";
import {
	assertCredentialFree,
	assertRequestPresence,
	normalizeCoreToolContracts,
	normalizeEventTypes,
	normalizeRequestBody,
	normalizeToolSurface,
	observeResponsesWire,
	parseSseEvents,
	type ResponsesAllowlist,
	type ResponsesWireObservation,
} from "./allowlist.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const responsesRoot = resolve(repositoryRoot, "fixtures/responses");
const officialRoot = resolve(repositoryRoot, "fixtures/official-conformance");
const fixtureApiKey = "fixture-not-a-credential";

interface ExpectedNormalized {
	eventTypes: string[];
	terminalStatus: string;
	responseId: string;
	text: string;
}

describe("product vs pinned official conformance", () => {
	test("responses fixtures are credential-free and allowlist-normalized", async () => {
		const allowlist = await readJson<ResponsesAllowlist>(resolve(responsesRoot, "allowlist.json"));
		const request = await readJson<Record<string, unknown>>(
			resolve(responsesRoot, "request-basic.json"),
		);
		const expected = await readJson<ExpectedNormalized>(
			resolve(responsesRoot, "expected-normalized.json"),
		);
		const sse = await readFile(resolve(responsesRoot, "sse-basic.sse"), "utf8");
		const websocket = await readFile(resolve(responsesRoot, "websocket-basic.jsonl"), "utf8");

		for (const [label, text] of [
			["request-basic.json", JSON.stringify(request)],
			["sse-basic.sse", sse],
			["websocket-basic.jsonl", websocket],
			["allowlist.json", JSON.stringify(allowlist)],
			["expected-normalized.json", JSON.stringify(expected)],
		] as const) {
			assertCredentialFree(text, label);
		}

		expect(allowlist.officialCodexVersion).toBe("0.144.3");
		expect(allowlist.officialSourceCommit).toBe("78ad6e6bfd1d3b6a209acd3ef82172a96b25179c");
		expect(allowlist.requestBodyComparable.length).toBeGreaterThan(0);
		expect(normalizeRequestBody(request, allowlist)).toEqual(
			normalizeRequestBody(
				{
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
				allowlist,
			),
		);

		const events = parseSseEvents(sse);
		expect(normalizeEventTypes(events, allowlist)).toEqual(expected.eventTypes);
		expect(expected.terminalStatus).toBe("completed");
		expect(expected.responseId).toBe("fixture-response");

		const websocketEvents = websocket
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.direction === "server");
		expect(normalizeEventTypes(websocketEvents, allowlist)).toEqual(expected.eventTypes);

		const create = JSON.parse(websocket.trimEnd().split("\n")[0] ?? "{}") as Record<
			string,
			unknown
		>;
		expect(create.type).toBe("response.create");
		expect(normalizeRequestBody(create.request as Record<string, unknown>, allowlist)).toEqual(
			normalizeRequestBody(request, allowlist),
		);
	});

	test("product tool surfaces match the pinned official allowlist fixtures", async () => {
		const allowlist = await readJson<ResponsesAllowlist>(resolve(responsesRoot, "allowlist.json"));
		const officialSurface = await readJson<Record<string, unknown>>(
			resolve(officialRoot, "update-plan-hosted-web.json"),
		);
		const officialCoreTools = await readJson<Record<string, unknown>>(
			resolve(officialRoot, "core-tools.json"),
		);

		const target = resolveNativeTarget();
		const executableName = process.platform === "win32" ? "codex-bridge.exe" : "codex-bridge";
		const executable = resolve(repositoryRoot, "native", "target", target, "debug", executableName);
		await access(executable);

		const client = await BridgeClient.connect({
			buildTarget: target,
			clientVersion: "conformance",
			allowDevelopmentBuild: true,
			transport: spawnBridgeTransport(executable),
		});

		try {
			const hosted = await client.request("tools.resolve", {
				model: fixtureModel("disabled"),
				webSearchMode: "indexed",
				provider: { hostedWebSearch: true, namespaceTools: false, imageGeneration: false },
				standaloneWebSearch: { featureEnabled: false, executorAvailable: false },
				shell: { allowLoginShell: false, execPermissionApprovalsEnabled: false },
			});
			expect(hosted.status).toBe("completed");
			expect(normalizeToolSurface(hosted.result as Record<string, unknown>, allowlist)).toEqual(
				normalizeToolSurface(officialSurface, allowlist),
			);

			const unified = await resolveTools(client, "unified_exec");
			const shell = await resolveTools(client, "shell_command");
			const standaloneWeb = await resolveTools(client, "disabled", true);
			const productContracts = collectCoreContracts(unified, shell, standaloneWeb, allowlist);

			expect(normalizeCoreToolContracts(productContracts, allowlist)).toEqual(
				normalizeCoreToolContracts(officialCoreTools, allowlist),
			);
		} finally {
			await client.shutdown();
		}
	}, 60_000);

	test("independent Responses differential: product bridge vs pinned official SDK", async () => {
		const allowlist = await readJson<ResponsesAllowlist>(resolve(responsesRoot, "allowlist.json"));
		const expected = await readJson<ExpectedNormalized>(
			resolve(responsesRoot, "expected-normalized.json"),
		);
		const sse = await readFile(resolve(responsesRoot, "sse-basic.sse"), "utf8");
		const fixtureEvents = parseSseEvents(sse);

		const officialServer = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "disabled" }),
		]);
		const productServer = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "disabled" }),
		]);
		const codexHome = await mkdtemp(resolve(tmpdir(), "pi-codex-conformance-empty-"));

		let officialObservation: ResponsesWireObservation | undefined;
		let productObservation: ResponsesWireObservation | undefined;

		try {
			// Official SDK against an isolated fake Responses endpoint with empty CODEX_HOME.
			const officialClient = new Codex({
				baseUrl: officialServer.baseUrl,
				apiKey: fixtureApiKey,
				env: {
					PATH: process.env.PATH ?? "",
					CODEX_HOME: codexHome,
					HOME: codexHome,
					NO_COLOR: "1",
				},
			});
			const thread = officialClient.startThread({
				model: "fixture-model",
				approvalPolicy: "never",
				skipGitRepoCheck: true,
			});
			const officialResult = await thread.run("fixture");
			const officialWire = firstPostedResponsesRequest(officialServer.requests);
			const officialBody = JSON.parse(officialWire.body) as Record<string, unknown>;
			// Agent-only instructions/input/tools stay outside PRODUCT_CONTRACT equality.
			assertRequestPresence(officialBody, allowlist, "official SDK request");
			officialObservation = observeResponsesWire({
				allowlist,
				requestBody: officialBody,
				requestHeaders: officialWire.headers,
				// Official SDK does not re-emit raw Responses events; the independent event oracle
				// is the shared SSE fixture both clients consumed.
				events: fixtureEvents,
				terminal: {
					status: "completed",
					responseId: expected.responseId,
					text: officialResult.finalResponse,
				},
			});

			// Product native bridge against a separate isolated fake Responses endpoint.
			const target = resolveNativeTarget();
			const executableName = process.platform === "win32" ? "codex-bridge.exe" : "codex-bridge";
			const executable = resolve(
				repositoryRoot,
				"native",
				"target",
				target,
				"debug",
				executableName,
			);
			await access(executable);
			const productClient = await BridgeClient.connect({
				buildTarget: target,
				clientVersion: "conformance",
				allowDevelopmentBuild: true,
				transport: spawnBridgeTransport(executable),
			});
			try {
				const productEvents: unknown[] = [];
				const productResult = await productClient.request(
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
						connection: {
							providerId: "fixture-provider",
							baseUrl: productServer.baseUrl,
							headers: {},
							authentication: { kind: "bearer", token: fixtureApiKey },
						},
					},
					{
						onEvent: (event) => {
							productEvents.push(event);
						},
					},
				);
				expect(productResult.status).toBe("completed");
				const productWire = firstPostedResponsesRequest(productServer.requests);
				const productBody = JSON.parse(productWire.body) as Record<string, unknown>;
				// Product adapter omits empty agent-only fields; only assert input presence.
				expect(Array.isArray(productBody.input)).toBe(true);
				productObservation = observeResponsesWire({
					allowlist,
					requestBody: productBody,
					requestHeaders: productWire.headers,
					events: productEvents,
					terminal: {
						status: productResult.status,
						responseId:
							typeof productResult.result === "object" &&
							productResult.result !== null &&
							"responseId" in productResult.result
								? String((productResult.result as { responseId: unknown }).responseId)
								: null,
						text: extractOutputText(productEvents),
					},
				});
			} finally {
				await productClient.shutdown();
			}

			expect(officialObservation).toBeDefined();
			expect(productObservation).toBeDefined();
			if (officialObservation === undefined || productObservation === undefined) {
				throw new Error("Responses differential observations were not captured");
			}

			// Comparable product-contract request fields must match across both real clients.
			expect(productObservation.comparableRequestBody).toEqual(
				officialObservation.comparableRequestBody,
			);
			expect(productObservation.comparableRequestBody).toEqual({
				model: "fixture-model",
				tool_choice: "auto",
				parallel_tool_calls: false,
				store: false,
				stream: true,
				include: [],
			});

			// Auth is redacted; both clients send bearer credentials and JSON bodies.
			expect(productObservation.requestHeaders).toEqual(officialObservation.requestHeaders);
			expect(productObservation.requestHeaders).toEqual({
				"content-type": "application/json",
				authorization: "bearer redacted",
			});

			// Product bridge must surface the official SSE event order; official side uses the same fixture.
			expect(productObservation.eventTypes).toEqual(expected.eventTypes);
			expect(productObservation.eventTypes).toEqual(officialObservation.eventTypes);
			expect(productObservation.terminal).toEqual({
				status: expected.terminalStatus,
				responseId: expected.responseId,
				text: expected.text,
			});
			expect(productObservation.terminal.status).toBe(officialObservation.terminal.status);
			expect(productObservation.terminal.text).toBe(officialObservation.terminal.text);

			// Isolation: empty CODEX_HOME, no user credential env leakage into product captures.
			// Official agent request bodies may mention $CODEX_HOME in skill docs; do not scan them.
			assertCredentialFree(JSON.stringify(productObservation), "product observation");
			assertCredentialFree(JSON.stringify(officialObservation), "official observation");
			expect(JSON.stringify(productServer.requests)).not.toContain("CODEX_HOME");
			expect(JSON.stringify(productServer.requests)).not.toContain(tmpdir());
			expect(JSON.stringify(productObservation)).not.toContain(codexHome);
			expect(JSON.stringify(officialObservation)).not.toContain(codexHome);
			expect(productServer.requests.some((entry) => entry.path.endsWith("/responses"))).toBe(true);
			expect(officialServer.requests.some((entry) => entry.path.endsWith("/responses"))).toBe(true);
			// Official SDK ran with an empty private CODEX_HOME, not the user's home/config tree.
			expect(codexHome.startsWith(tmpdir())).toBe(true);
		} finally {
			officialServer.stop();
			productServer.stop();
			await rm(codexHome, { recursive: true, force: true });
		}
	}, 90_000);
});

function extractOutputText(events: readonly unknown[]): string {
	let text = "";
	for (const event of events) {
		if (typeof event !== "object" || event === null || Array.isArray(event)) {
			continue;
		}
		const record = event as { type?: unknown; delta?: unknown };
		if (record.type === "response.output_text.delta" && typeof record.delta === "string") {
			text += record.delta;
		}
	}
	return text;
}

async function resolveTools(
	client: BridgeClient,
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
		throw new Error("Product tool resolution did not complete");
	}
	return result.result as Record<string, unknown>;
}

function collectCoreContracts(
	unified: Record<string, unknown>,
	shell: Record<string, unknown>,
	standaloneWeb: Record<string, unknown>,
	allowlist: ResponsesAllowlist,
): Record<string, unknown> {
	const values = [
		...(Array.isArray(unified.modelTools) ? unified.modelTools : []),
		...(Array.isArray(unified.dispatchTools) ? unified.dispatchTools : []),
		...(Array.isArray(shell.modelTools) ? shell.modelTools : []),
		...(Array.isArray(standaloneWeb.modelTools) ? standaloneWeb.modelTools : []),
	];
	const contracts: Record<string, unknown> = {};
	for (const value of values) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			continue;
		}
		const contract = value as Record<string, unknown>;
		if (typeof contract.name === "string") {
			contracts[contract.name] ??= contract;
		} else if (contract.type === "web_search") {
			contracts.web ??= contract;
		}
	}
	for (const required of allowlist.coreTools) {
		if (contracts[required] === undefined) {
			throw new Error(`Product core tool contract ${required} is missing`);
		}
	}
	return contracts;
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

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

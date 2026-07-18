import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeRemoteError } from "../../src/infrastructure/codex-bridge/client.ts";
import { fixtureToken } from "./helpers/fake-pi.ts";
import { fixtureModelSpec, startFakeResponsesServer } from "./helpers/fake-responses-server.ts";
import { connectIntegrationBridge, createIntegrationRuntime } from "./helpers/native-bridge.ts";

const cleanups: Array<() => Promise<void> | void> = [];

function removeCleanup(cleanup: () => Promise<void> | void): void {
	const index = cleanups.lastIndexOf(cleanup);
	if (index >= 0) cleanups.splice(index, 1);
}

function providerConnection(
	baseUrl: string,
	token = fixtureToken(),
	accountId?: string,
): Record<string, unknown> {
	return {
		providerId: "fixture-provider",
		baseUrl,
		headers: {},
		authentication: { kind: "bearer", token },
		...(accountId === undefined ? {} : { accountId }),
	};
}

afterEach(async () => {
	let failure: unknown;
	while (cleanups.length > 0) {
		try {
			await cleanups.pop()?.();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
});

describe("native child integration", () => {
	test("streams responses through a local fake server without user CODEX_HOME", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "shell_command" }),
		]);
		cleanups.push(() => server.stop());

		const token = fixtureToken();
		const { client, repositoryRoot } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());

		const model = await client.request("models.resolve", {
			modelId: "fixture-model",
		});
		expect(model.status).toBe("completed");
		expect(model.result).toMatchObject({
			shellSurface: "shell-command",
			provider: {
				name: "OpenAI",
				supportsWebsockets: true,
				hostedWebSearch: true,
			},
		});

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
				connection: providerConnection(server.baseUrl, token),
			},
			{
				onEvent: (event) => {
					const type =
						typeof event === "object" &&
						event !== null &&
						"type" in event &&
						typeof (event as { type: unknown }).type === "string"
							? (event as { type: string }).type
							: "unknown";
					events.push(type);
				},
			},
		);
		expect(response.status).toBe("completed");
		expect(response.result).toMatchObject({ responseId: "fixture-response" });
		expect(events).toContain("response.output_text.delta");
		expect(events).toContain("response.completed");
		expect(server.requests.some((entry) => entry.path.endsWith("/models"))).toBe(false);
		expect(server.requests.some((entry) => entry.path.endsWith("/responses"))).toBe(true);
		expect(JSON.stringify(server.requests)).not.toContain(tmpdir());
		expect(JSON.stringify(server.requests)).not.toContain("CODEX_HOME");

		const shell = await client.request(
			"tools.execute",
			{
				tool: "shell_command",
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
		expect(shell.status).toBe("completed");
		expect(
			(shell.result as { exitCode?: unknown }).exitCode ??
				(shell.result as { exit_code?: unknown }).exit_code,
		).toBe(0);
	}, 60_000);

	test("retains a background unified-exec session until shutdown cleanup", async () => {
		const { client, repositoryRoot } = await connectIntegrationBridge();
		const shutdownClient = async () => client.shutdown();
		cleanups.push(shutdownClient);

		const workspace = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-bg-"));
		cleanups.push(async () => rm(workspace, { recursive: true, force: true }));

		const result = await client.request(
			"tools.execute",
			{
				tool: "exec_command",
				cmd: "sleep 30",
				workdir: repositoryRoot,
				workspaceRoots: [repositoryRoot],
				yield_time_ms: 250,
				allow_background_sessions: true,
			},
			{
				onApprovalRequest: (approval) => client.decideApproval(approval.approvalId, "allow_once"),
			},
		);
		expect(result.status).toBe("completed");
		const details = result.result as { session_id?: number; sessionId?: number | string };
		const sessionId = details.session_id ?? details.sessionId;
		expect(sessionId !== undefined && sessionId !== null).toBe(true);

		await client.terminateSession(String(sessionId));
		await client.shutdown();
		removeCleanup(shutdownClient);
	}, 60_000);

	test("forwards OAuth bearer credentials on stdin-only auth to OpenAI requests", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "shell_command" }),
		]);
		cleanups.push(() => server.stop());

		const token = fixtureToken("oauth-account");
		const { client } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());

		const model = await client.request("models.resolve", {
			modelId: "fixture-model",
		});
		expect(model.status).toBe("completed");

		const response = await client.request("responses.create", {
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
			connection: providerConnection(server.baseUrl, token, "oauth-account"),
		});
		expect(response.status).toBe("completed");

		const responsesRequest = server.requests.find((entry) => entry.path.endsWith("/responses"));
		expect(responsesRequest?.authorization).toBe(`Bearer ${token}`);
		expect(responsesRequest?.chatgptAccountId).toBe("oauth-account");
		expect(JSON.stringify(server.requests)).not.toContain("CODEX_HOME");
	}, 60_000);

	test("forwards API key credentials on stdin-only auth without account headers", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "shell_command" }),
		]);
		cleanups.push(() => server.stop());

		const apiKey = "opaque-fixture-api-key";
		const { client } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());

		const model = await client.request("models.resolve", {
			modelId: "fixture-model",
		});
		expect(model.status).toBe("completed");

		const response = await client.request("responses.create", {
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
			connection: providerConnection(server.baseUrl, apiKey),
		});
		expect(response.status).toBe("completed");

		const responsesRequest = server.requests.find((entry) => entry.path.endsWith("/responses"));
		expect(responsesRequest?.authorization).toBe(`Bearer ${apiKey}`);
		expect(responsesRequest?.chatgptAccountId).toBeNull();
	}, 60_000);

	test("isolates concurrent provider URLs, credentials, and headers", async () => {
		const leftServer = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "shell_command" }),
		]);
		const rightServer = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "fixture-model", shellType: "shell_command" }),
		]);
		cleanups.push(() => leftServer.stop());
		cleanups.push(() => rightServer.stop());

		const { client } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());
		const request = (baseUrl: string, token: string, route: string) =>
			client.request("responses.create", {
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
					...providerConnection(baseUrl, token),
					headers: { "X-Provider-Route": route },
				},
			});

		const [left, right] = await Promise.all([
			request(leftServer.baseUrl, "opaque-provider-left", "left"),
			request(rightServer.baseUrl, "opaque-provider-right", "right"),
		]);
		expect(left.status).toBe("completed");
		expect(right.status).toBe("completed");
		const leftRequest = leftServer.requests.find((entry) => entry.path.endsWith("/responses"));
		const rightRequest = rightServer.requests.find((entry) => entry.path.endsWith("/responses"));
		expect(leftRequest?.authorization).toBe("Bearer opaque-provider-left");
		expect(leftRequest?.headers["x-provider-route"]).toBe("left");
		expect(rightRequest?.authorization).toBe("Bearer opaque-provider-right");
		expect(rightRequest?.headers["x-provider-route"]).toBe("right");
	}, 60_000);

	test("protocol request cancel terminates a running shell process tree", async () => {
		const { client, repositoryRoot } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());

		const controller = new AbortController();
		const started = Date.now();
		const pending = client.request(
			"tools.execute",
			{
				tool: "shell_command",
				command: "sleep 30",
				workdir: repositoryRoot,
				workspaceRoots: [repositoryRoot],
				timeoutMs: 60_000,
				login: false,
			},
			{
				signal: controller.signal,
				onApprovalRequest: (approval) => client.decideApproval(approval.approvalId, "allow_once"),
			},
		);
		await Bun.sleep(250);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 60_000);

	test("abort during approval leaves the bridge ready for the next request", async () => {
		const token = fixtureToken();
		const { client } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());
		const workspace = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-approval-cancel-"));
		cleanups.push(async () => rm(workspace, { recursive: true, force: true }));

		const controller = new AbortController();
		let sawApproval = false;
		const pending = client.request(
			"tools.execute",
			{
				tool: "apply_patch",
				input: "*** Begin Patch\n*** Add File: cancelled.txt\n+cancelled\n*** End Patch",
				workdir: workspace,
				workspaceRoots: [workspace],
			},
			{
				signal: controller.signal,
				onApprovalRequest: () => {
					sawApproval = true;
					controller.abort();
					// Intentionally do not send a decision for the expired approval id.
				},
			},
		);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(sawApproval).toBe(true);
		expect(client.isReady).toBe(true);
		await expect(access(join(workspace, "cancelled.txt"))).rejects.toBeDefined();

		// Late decision for the expired approval must not tear down the connection.
		await client.decideApproval("approval-expired-after-cancel", "allow_once");
		const next = await client.request("diagnostics.read", {});
		expect(next.status).toBe("completed");
		expect(JSON.stringify(next)).not.toContain(token);
	}, 60_000);

	test("BundledCodexRuntime abort during approval does not authorize work and continues", async () => {
		const token = fixtureToken();
		const { runtime, repositoryRoot } = await createIntegrationRuntime();
		cleanups.push(async () => runtime.shutdown());

		const controller = new AbortController();
		let sawApproval = false;

		const pending = runtime.executeTool({
			tool: "shell_command",
			argumentsValue: {
				command: "echo should-not-run",
				login: false,
				allowLoginShell: false,
				timeoutMs: 10_000,
				...(process.platform === "win32" ? { shell: "cmd.exe" } : {}),
			},
			workdir: repositoryRoot,
			workspaceRoots: [repositoryRoot],
			signal: controller.signal,
			onApproval: async () => {
				sawApproval = true;
				controller.abort();
				return "allow_once" as const;
			},
		});
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(sawApproval).toBe(true);

		const next = await runtime.executeTool({
			tool: "shell_command",
			argumentsValue: {
				command: "echo next",
				login: false,
				allowLoginShell: false,
				timeoutMs: 10_000,
				...(process.platform === "win32" ? { shell: "cmd.exe" } : {}),
			},
			workdir: repositoryRoot,
			workspaceRoots: [repositoryRoot],
			onApproval: () => "allow_once" as const,
		});
		expect(next.status).toBe("completed");
		const details = next.result as { exitCode?: unknown; exit_code?: unknown };
		expect(details.exitCode ?? details.exit_code).toBe(0);
		expect(JSON.stringify(next)).not.toContain(token);
		expect(JSON.stringify(next)).not.toContain("should-not-run");
	}, 60_000);

	test("rejects network requests that omit a provider connection", async () => {
		const { client } = await connectIntegrationBridge();
		cleanups.push(async () => client.shutdown());

		try {
			await client.request("responses.create", {
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
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BridgeRemoteError);
			expect(error).toMatchObject({ category: "ProtocolError", code: "invalid_params" });
			expect(JSON.stringify(error)).not.toContain("sk-");
		}
	}, 60_000);
});

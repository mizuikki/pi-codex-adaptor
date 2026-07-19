import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCompactionStore } from "../../src/application/compaction.ts";
import { ConfigurationService } from "../../src/application/configuration.ts";
import { ProviderActivationPolicy } from "../../src/application/provider-activation.ts";
import { FileConfigurationRepository } from "../../src/infrastructure/configuration/file-config-repository.ts";
import { createCodexStreamSimple } from "../../src/integration/pi/codex-provider.ts";
import {
	type CodexToolProfileCoordinator,
	PI_CORE_AGENT_TOOL_NAMES,
} from "../../src/integration/pi/codex-tool-profile.ts";
import { registerCodexTools } from "../../src/integration/pi/codex-tools.ts";

import { createFakePi, emit, fixtureModel, fixtureToken } from "./helpers/fake-pi.ts";
import { fixtureModelSpec, startFakeResponsesServer } from "./helpers/fake-responses-server.ts";
import { createIntegrationRuntime } from "./helpers/native-bridge.ts";

const cleanups: Array<() => Promise<void> | void> = [];

function removeCleanup(cleanup: () => Promise<void> | void): void {
	const index = cleanups.lastIndexOf(cleanup);
	if (index >= 0) cleanups.splice(index, 1);
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

async function configurationService(): Promise<ConfigurationService> {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-cfg-"));
	cleanups.push(async () => rm(directory, { recursive: true, force: true }));
	const configFile = join(directory, "pi-codex-adaptor.json");
	const repository = new FileConfigurationRepository(configFile);
	return new ConfigurationService(repository);
}

function healthyProfile(): CodexToolProfileCoordinator {
	return {
		readiness: { kind: "healthy", capabilityKey: "fixture-key" },
		skillLoader: "shell_command",
		enterPending: () => {},
		installHealthy: () => true,
		installUnavailable: () => {},
		revalidateHealthyOwnership: () => true,
		isHealthy: () => true,
		restorePi: () => {},
		dispose: () => {},
	};
}

describe("fake Pi + real native lifecycle", () => {
	test("executes and polls a supplemental session on the bundled shell-command model", async () => {
		if (process.platform === "win32") return;
		const { runtime } = await createIntegrationRuntime();
		const shutdownRuntime = async () => runtime.shutdown();
		cleanups.push(shutdownRuntime);
		const service = await configurationService();
		const pi = createFakePi({ token: fixtureToken() });
		registerCodexTools(pi.api, runtime, service, new ProviderActivationPolicy(service));
		const ctx = pi.context(fixtureModel("gpt-5.6-sol"));
		await emit(pi, "session_start", ctx);

		expect(pi.activeTools).toContain("shell_command");
		expect(pi.activeTools).toContain("exec_command");
		expect(pi.activeTools).toContain("write_stdin");
		const started = await pi.tools
			.get("exec_command")
			?.execute(
				"exec-session",
				{ cmd: "read line; printf 'received:%s' \"$line\"", yield_time_ms: 20 },
				undefined,
				undefined,
				ctx,
			);
		const sessionId = (started?.details as { session_id?: unknown } | undefined)?.session_id;
		expect(typeof sessionId).toBe("number");
		expect(started?.content).toEqual([
			{ type: "text", text: expect.stringContaining(`"session_id":${String(sessionId)}`) },
		]);

		const completed = await pi.tools
			.get("write_stdin")
			?.execute(
				"write-session",
				{ session_id: sessionId, chars: "fixture-input\n", yield_time_ms: 2_000 },
				undefined,
				undefined,
				ctx,
			);
		expect(completed?.content).toEqual([
			{ type: "text", text: expect.stringContaining("received:fixture-input") },
		]);
		expect(completed?.content).toEqual([
			{ type: "text", text: expect.stringContaining('"exit_code":0') },
		]);
		expect((completed?.details as { exit_code?: unknown } | undefined)?.exit_code).toBe(0);

		await runtime.shutdown();
		removeCleanup(shutdownRuntime);
	}, 60_000);

	test("switches models, recomputes resolvers, updates plan, and shuts down cleanly", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({
				slug: "gpt-5.5",
				shellType: "shell_command",
				useResponsesLite: false,
			}),
			fixtureModelSpec({
				slug: "gpt-5.6-sol",
				shellType: "shell_command",
				useResponsesLite: true,
			}),
		]);
		cleanups.push(() => server.stop());

		const token = fixtureToken();
		const { runtime } = await createIntegrationRuntime();
		const shutdownRuntime = async () => runtime.shutdown();
		cleanups.push(shutdownRuntime);

		const service = await configurationService();
		const pi = createFakePi({ token });
		registerCodexTools(pi.api, runtime, service, new ProviderActivationPolicy(service));

		const hosted = pi.context(fixtureModel("gpt-5.5", "openai-codex", server.baseUrl));
		await emit(pi, "session_start", hosted);
		expect(pi.activeTools).toEqual([
			"third_party",
			"update_plan",
			"shell_command",
			"exec_command",
			"write_stdin",
			"apply_patch",
			"view_image",
			"image_gen.imagegen",
		]);
		expect(pi.status.get("codex-adaptor")).toContain("shell-command");
		expect(pi.status.get("codex-adaptor")).toContain("hosted");

		const shell = pi.context(fixtureModel("gpt-5.6-sol", "openai-codex", server.baseUrl));
		await emit(pi, "model_select", shell);
		expect(pi.activeTools).toEqual([
			"third_party",
			"update_plan",
			"shell_command",
			"exec_command",
			"write_stdin",
			"apply_patch",
			"view_image",
			"image_gen.imagegen",
			"web.run",
		]);
		expect(pi.status.get("codex-adaptor")).toContain("shell-command");
		expect(pi.status.get("codex-adaptor")).toContain("standalone");

		const plan = await pi.tools.get("update_plan")?.execute(
			"plan-call",
			{
				explanation: "fixture plan",
				plan: [
					{ step: "First", status: "in_progress" },
					{ step: "Second", status: "pending" },
				],
			} as never,
			undefined,
			undefined,
			shell,
		);
		expect(plan?.content).toEqual([{ type: "text", text: "Plan updated" }]);
		expect(pi.widgets.get("codex-plan")).toEqual(["Plan", "[>] First", "[ ] Second"]);

		// Reload recomputes the same surface without deleting third-party tools.
		await emit(pi, "session_start", shell);
		expect(pi.activeTools).toContain("third_party");
		expect(pi.activeTools).toContain("web.run");
		expect(pi.activeTools).toContain("shell_command");

		const other = pi.context(fixtureModel("gpt-5.6-sol", "other-provider", server.baseUrl));
		await emit(pi, "model_select", other);
		expect(pi.activeTools).toEqual([...PI_CORE_AGENT_TOOL_NAMES, "third_party"]);

		await runtime.shutdown();
		removeCleanup(shutdownRuntime);
	}, 60_000);

	test("streams assistant text through fake Pi provider + real native + fake Responses", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "gpt-5.5", shellType: "shell_command" }),
		]);
		cleanups.push(() => server.stop());

		const token = fixtureToken();
		const { runtime } = await createIntegrationRuntime();
		cleanups.push(async () => runtime.shutdown());
		const service = await configurationService();
		const streamSimple = createCodexStreamSimple(
			runtime,
			service,
			new ProviderActivationPolicy(service),
			new CodexCompactionStore(),
			undefined,
			healthyProfile(),
		);
		const stream = streamSimple(
			fixtureModel("gpt-5.5", "openai-codex", server.baseUrl),
			{
				systemPrompt: "",
				messages: [{ role: "user", content: "fixture input", timestamp: 1 }],
			},
			{ apiKey: token },
		);

		const events: string[] = [];
		let finalText = "";
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "done" && event.message) {
				const content = event.message.content.find((item) => item.type === "text");
				finalText =
					content !== undefined && content.type === "text" && typeof content.text === "string"
						? content.text
						: "";
			}
			if (event.type === "done" || event.type === "error") break;
		}
		expect(events).toContain("text_delta");
		expect(events).toContain("done");
		expect(finalText).toBe("fixture");
		expect(server.requests.some((entry) => entry.path.endsWith("/responses"))).toBe(true);
	}, 60_000);

	test("runs a selected openai-responses provider with an opaque API key", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({ slug: "gpt-5.5", shellType: "shell_command" }),
		]);
		cleanups.push(() => server.stop());

		const { runtime } = await createIntegrationRuntime();
		cleanups.push(async () => runtime.shutdown());
		const service = await configurationService();
		const config = await service.load();
		await service.applyDraft({
			...config,
			activation: { providers: ["custom-codex"] },
		});
		const activation = new ProviderActivationPolicy(service);
		await activation.refresh();
		const streamSimple = createCodexStreamSimple(
			runtime,
			service,
			activation,
			new CodexCompactionStore(),
			undefined,
			healthyProfile(),
		);
		const stream = streamSimple(
			{
				...fixtureModel("gpt-5.5", "custom-codex", server.baseUrl),
				api: "openai-responses",
			},
			{
				systemPrompt: "",
				messages: [{ role: "user", content: "fixture input", timestamp: 1 }],
			},
			{ apiKey: "opaque-fixture-api-key" },
		);

		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toContain("done");
		const responseRequest = server.requests.find((entry) => entry.path.endsWith("/responses"));
		expect(responseRequest?.authorization).toBe("Bearer opaque-fixture-api-key");
		expect(responseRequest?.chatgptAccountId).toBeNull();
	}, 60_000);

	test("config reload recomputes optional tool activation without native credentials", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({
				slug: "gpt-5.5",
				shellType: "shell_command",
			}),
		]);
		cleanups.push(() => server.stop());
		const token = fixtureToken();
		const { runtime } = await createIntegrationRuntime();
		cleanups.push(async () => runtime.shutdown());

		const directory = await mkdtemp(join(tmpdir(), "pi-codex-adaptor-reload-"));
		cleanups.push(async () => rm(directory, { recursive: true, force: true }));
		const configFile = join(directory, "pi-codex-adaptor.json");
		const repository = new FileConfigurationRepository(configFile);
		const service = new ConfigurationService(repository);
		const defaults = await service.load();

		const pi = createFakePi({ token });
		registerCodexTools(pi.api, runtime, service, new ProviderActivationPolicy(service));
		const ctx = pi.context(fixtureModel("gpt-5.5", "openai-codex", server.baseUrl));
		await emit(pi, "session_start", ctx);
		expect(pi.activeTools).toContain("view_image");
		expect(pi.activeTools).toContain("image_gen.imagegen");
		expect(pi.status.get("codex-adaptor")).toContain("hosted");

		await writeFile(
			configFile,
			JSON.stringify({
				...defaults,
				tools: {
					...defaults.tools,
					optional: { viewImage: "off", imageGeneration: "off" },
				},
				codex: {
					...defaults.codex,
					webSearch: { mode: "disabled" },
				},
			}),
			"utf8",
		);

		await emit(pi, "session_start", ctx);
		expect(pi.activeTools).toEqual([
			"third_party",
			"update_plan",
			"shell_command",
			"exec_command",
			"write_stdin",
			"apply_patch",
		]);
		expect(pi.activeTools).not.toContain("view_image");
		expect(pi.activeTools).not.toContain("image_gen.imagegen");
		expect(pi.activeTools).not.toContain("web.run");
		expect(pi.status.get("codex-adaptor")).toContain("disabled");
	}, 60_000);

	test("settings save refreshes optional tools without session_start", async () => {
		const server = await startFakeResponsesServer([
			fixtureModelSpec({
				slug: "gpt-5.5",
				shellType: "shell_command",
			}),
		]);
		cleanups.push(() => server.stop());
		const token = fixtureToken();
		const { runtime } = await createIntegrationRuntime();
		cleanups.push(async () => runtime.shutdown());

		const service = await configurationService();
		const pi = createFakePi({ token });
		registerCodexTools(pi.api, runtime, service, new ProviderActivationPolicy(service));
		const ctx = pi.context(fixtureModel("gpt-5.5", "openai-codex", server.baseUrl));
		await emit(pi, "session_start", ctx);
		expect(pi.activeTools).toContain("view_image");
		expect(pi.activeTools).toContain("image_gen.imagegen");

		const defaults = await service.load();
		await service.applyDraft({
			...defaults,
			tools: {
				...defaults.tools,
				optional: { viewImage: "off", imageGeneration: "off" },
			},
			codex: {
				...defaults.codex,
				webSearch: { mode: "disabled" },
			},
			ui: { status: false },
		});
		// ConfigurationService notifies listeners without awaiting them; wait for the surface.
		await waitFor(
			() =>
				!pi.activeTools.includes("view_image") &&
				!pi.activeTools.includes("image_gen.imagegen") &&
				pi.activeTools.includes("apply_patch"),
			2_000,
		);

		expect(pi.activeTools).toEqual([
			"third_party",
			"update_plan",
			"shell_command",
			"exec_command",
			"write_stdin",
			"apply_patch",
		]);
		expect(pi.status.get("codex-adaptor")).toBeUndefined();

		await service.applyDraft({
			...defaults,
			security: { approvalPolicy: "bypass" },
		});
		await waitFor(
			() => pi.status.get("codex-adaptor")?.includes("approvals:bypass") === true,
			2_000,
		);
		expect(pi.status.get("codex-adaptor")).toContain("approvals:bypass");
		await emit(pi, "session_start", ctx);
		const bypassWarnings = pi.notifications.filter((message) =>
			message.includes("approval bypass is enabled"),
		);
		expect(bypassWarnings).toHaveLength(1);
		await emit(pi, "session_start", ctx);
		expect(
			pi.notifications.filter((message) => message.includes("approval bypass is enabled")),
		).toHaveLength(1);

		await emit(pi, "session_shutdown", ctx);
		const toolsAfterShutdown = [...pi.activeTools];
		expect(toolsAfterShutdown).toEqual([...PI_CORE_AGENT_TOOL_NAMES, "third_party"]);
		await service.resetToDefaults();
		// Give a late activate attempt time to misbehave if the subscription leaked.
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(pi.activeTools).toEqual(toolsAfterShutdown);
	}, 60_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("Timed out waiting for managed tool refresh");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

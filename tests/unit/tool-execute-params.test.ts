import { describe, expect, test } from "bun:test";

import { buildToolsExecuteParams } from "../../src/infrastructure/codex-bridge/tool-execute-params.ts";

describe("tools.execute param allowlist", () => {
	test("drops model-injected provider connection fields", () => {
		const params = buildToolsExecuteParams({
			tool: "image_gen.imagegen",
			argumentsValue: {
				prompt: "fixture image",
				connection: { baseUrl: "http://127.0.0.1:9/v1", token: "fixture-token" },
				providerId: "model-injected",
			},
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
		});

		expect(params).toEqual({
			tool: "image_gen.imagegen",
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
			prompt: "fixture image",
		});
		expect(params).not.toHaveProperty("connection");
		expect(params).not.toHaveProperty("providerId");
		expect(JSON.stringify(params)).not.toContain("127.0.0.1:9");
		expect(JSON.stringify(params)).not.toContain("fixture-token");
	});

	test("does not attach provider connections to allowlisted model arguments", () => {
		const params = buildToolsExecuteParams({
			tool: "web.run",
			argumentsValue: {
				commands: { search_query: [{ q: "fixture" }] },
				model: "fixture-model",
				connection: { baseUrl: "http://127.0.0.1:9/v1" },
			},
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
		});

		expect(params.commands).toEqual({ search_query: [{ q: "fixture" }] });
		expect(params.model).toBe("fixture-model");
		expect(JSON.stringify(params)).not.toContain("127.0.0.1:9");
	});

	test("copies only allowlisted execution fields", () => {
		const params = buildToolsExecuteParams({
			tool: "exec_command",
			argumentsValue: {
				cmd: "printf fixture",
				shell: "/bin/bash",
				login: false,
				yield_time_ms: 250,
				allow_background_sessions: true,
				env: { SECRET: "nope" },
				cwd: "/escape",
			},
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
		});

		expect(params).toEqual({
			tool: "exec_command",
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
			cmd: "printf fixture",
			shell: "/bin/bash",
			login: false,
			yield_time_ms: 250,
			allow_background_sessions: true,
		});
		expect(params).not.toHaveProperty("env");
		expect(params).not.toHaveProperty("cwd");
	});
});

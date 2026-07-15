import { describe, expect, test } from "bun:test";

import { buildToolsExecuteParams } from "../../src/infrastructure/codex-bridge/tool-execute-params.ts";

describe("tools.execute param allowlist", () => {
	test("drops model-injected testBaseUrl so Authorization cannot be redirected", () => {
		const params = buildToolsExecuteParams({
			tool: "image_gen.imagegen",
			argumentsValue: {
				prompt: "fixture image",
				testBaseUrl: "http://127.0.0.1:9/v1",
				test_base_url: "http://127.0.0.1:9/v1",
				authorization: "Bearer model-injected",
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
		expect(params).not.toHaveProperty("testBaseUrl");
		expect(params).not.toHaveProperty("test_base_url");
		expect(params).not.toHaveProperty("authorization");
		expect(JSON.stringify(params)).not.toContain("127.0.0.1:9");
		expect(JSON.stringify(params)).not.toContain("Bearer model-injected");
	});

	test("only host runtime options may attach testBaseUrl", () => {
		const params = buildToolsExecuteParams({
			tool: "web.run",
			argumentsValue: {
				commands: { search_query: [{ q: "fixture" }] },
				model: "fixture-model",
				testBaseUrl: "http://127.0.0.1:9/v1",
			},
			workdir: "/workspace",
			workspaceRoots: ["/workspace"],
			testBaseUrl: "http://127.0.0.1:55/v1",
		});

		expect(params.testBaseUrl).toBe("http://127.0.0.1:55/v1");
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

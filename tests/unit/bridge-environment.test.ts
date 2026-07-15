import { describe, expect, test } from "bun:test";

import {
	createBridgeChildEnvironment,
	isCredentialEnvironmentVariable,
} from "../../src/infrastructure/codex-bridge/environment.ts";

describe("bridge child environment", () => {
	test("preserves required runtime variables", () => {
		const environment = createBridgeChildEnvironment(
			{
				PATH: "/usr/bin",
				HOME: "/home/fixture",
				SHELL: "/bin/bash",
				TMPDIR: "/tmp",
				LANG: "C.UTF-8",
				TERM: "xterm-256color",
				NO_COLOR: "1",
				HTTPS_PROXY: "http://proxy.fixture:8080",
				SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
			},
			"linux",
		);

		expect(environment).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/fixture",
			SHELL: "/bin/bash",
			TMPDIR: "/tmp",
			LANG: "C.UTF-8",
			TERM: "xterm-256color",
			NO_COLOR: "1",
			HTTPS_PROXY: "http://proxy.fixture:8080",
			SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
		});
	});

	test("strips credentials so they cannot arrive through the child environment", () => {
		const environment = createBridgeChildEnvironment(
			{
				PATH: "/usr/bin",
				OPENAI_API_KEY: "fixture-openai-key",
				OPENAI_API_TOKEN: "fixture-openai-token",
				CHATGPT_ACCESS_TOKEN: "fixture-chatgpt-token",
				AUTHORIZATION: "Bearer fixture-auth",
				CODEX_AUTH_TOKEN: "fixture-codex-token",
				RANDOM_SECRET: "fixture-secret",
				EDITOR: "vim",
			},
			"linux",
		);

		expect(environment).toEqual({ PATH: "/usr/bin" });
		expect(Object.keys(environment).sort()).toEqual(["PATH"]);
		expect(JSON.stringify(environment)).not.toInclude("fixture-");
		expect(isCredentialEnvironmentVariable("OPENAI_API_KEY")).toBe(true);
		expect(isCredentialEnvironmentVariable("PATH")).toBe(false);
		expect(isCredentialEnvironmentVariable("SSL_CERT_FILE")).toBe(false);
	});

	test("rejects credentials embedded in proxy URLs without exposing their values", () => {
		const credential = "proxy-user:proxy-password";
		for (const [name, value] of [
			["HTTP_PROXY", `http://${credential}@proxy.fixture:8080`],
			["https_proxy", "https://proxy-user@proxy.fixture"],
			["ALL_PROXY", "proxy-user:proxy-password@proxy.fixture:8080"],
			["All_Proxy", "not-a-url@proxy.fixture"],
		] as const) {
			try {
				createBridgeChildEnvironment({ [name]: value }, "linux");
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Credential-bearing proxy URLs are not allowed");
				expect((error as Error).message).not.toContain(value);
				expect((error as Error).message).not.toContain(credential);
			}
		}
	});

	test("preserves Windows startup variables while stripping credentials", () => {
		const environment = createBridgeChildEnvironment(
			{
				Path: "C:\\Windows\\System32",
				SystemRoot: "C:\\Windows",
				USERPROFILE: "C:\\Users\\fixture",
				OPENAI_API_KEY: "fixture-openai-key",
			},
			"win32",
		);

		expect(environment).toEqual({
			Path: "C:\\Windows\\System32",
			SystemRoot: "C:\\Windows",
			USERPROFILE: "C:\\Users\\fixture",
		});
		expect(JSON.stringify(environment)).not.toInclude("fixture-openai-key");
	});
});

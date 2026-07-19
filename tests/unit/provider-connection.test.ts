import { describe, expect, test } from "bun:test";

import { createProviderConnection } from "../../src/integration/pi/provider-connection.ts";

function model(baseUrl = "https://gateway.example/v1") {
	return { provider: "custom-codex", baseUrl };
}

function fixtureJwt(accountId = "account-fixture"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("provider connections", () => {
	test("uses an opaque API key without deriving an account id", () => {
		const connection = createProviderConnection(model(), { apiKey: "opaque-fixture-key" });

		expect(connection.authentication).toEqual({ kind: "bearer", token: "opaque-fixture-key" });
		expect(connection.accountId).toBeUndefined();
		expect(connection.headers).toEqual({});
	});

	test("prefers an explicit bearer header and extracts an optional account id", () => {
		const connection = createProviderConnection(model(), {
			apiKey: "ignored-fixture-key",
			headers: {
				Authorization: `Bearer ${fixtureJwt()}`,
				"ChatGPT-Account-ID": "explicit-account",
				"X-Route": "fixture",
			},
		});

		expect(connection.authentication).toEqual({ kind: "bearer", token: fixtureJwt() });
		expect(connection.accountId).toBe("explicit-account");
		expect(connection.headers).toEqual({ "X-Route": "fixture" });
	});

	test("preserves non-Bearer authorization and supports explicit suppression", () => {
		const headerOnly = createProviderConnection(model(), {
			apiKey: "ignored-fixture-key",
			headers: { AUTHORIZATION: "Basic fixture", "X-Route": "fixture" },
		});
		const suppressed = createProviderConnection(model(), {
			apiKey: "ignored-fixture-key",
			headers: { authorization: null },
		});

		expect(headerOnly.authentication).toEqual({ kind: "none" });
		expect(headerOnly.headers).toEqual({ AUTHORIZATION: "Basic fixture", "X-Route": "fixture" });
		expect(suppressed.authentication).toEqual({ kind: "none" });
	});

	test("honors account-id suppression before JWT fallback", () => {
		const suppressed = createProviderConnection(model(), {
			apiKey: fixtureJwt(),
			headers: { "ChatGPT-Account-ID": null },
		});
		const empty = createProviderConnection(model(), {
			apiKey: fixtureJwt(),
			headers: { "ChatGPT-Account-ID": "" },
		});

		expect(suppressed.accountId).toBeUndefined();
		expect(empty.accountId).toBeUndefined();
	});

	test("normalizes the built-in ChatGPT root but rejects full endpoint URLs", () => {
		expect(
			createProviderConnection(
				{ provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
				{ apiKey: "fixture-key" },
			).baseUrl,
		).toBe("https://chatgpt.com/backend-api/codex");
		expect(() =>
			createProviderConnection(model("https://gateway.example/v1/responses"), {}),
		).toThrow("API root");
	});

	test("freezes the captured connection and ordinary headers", () => {
		const headers = { "X-Route": "before" };
		const connection = createProviderConnection(model(), {
			apiKey: "opaque-fixture-key",
			headers,
		});
		headers["X-Route"] = "after";

		expect(connection.headers).toEqual({ "X-Route": "before" });
		expect(Object.isFrozen(connection)).toBe(true);
		expect(Object.isFrozen(connection.headers)).toBe(true);
		expect(Object.isFrozen(connection.authentication)).toBe(true);
	});

	test("forwards Pi's disabled HTTP idle timeout sentinel without clamping it", () => {
		const connection = createProviderConnection(model(), {
			apiKey: "opaque-fixture-key",
			timeoutMs: 2_147_483_647,
		});

		expect(connection.timeoutMs).toBe(2_147_483_647);
	});

	test("accepts finite timeout boundaries and rejects values outside them", () => {
		expect(
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				timeoutMs: 1,
			}).timeoutMs,
		).toBe(1);
		expect(
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				timeoutMs: 86_400_000,
			}).timeoutMs,
		).toBe(86_400_000);
		expect(() =>
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				timeoutMs: 0,
			}),
		).toThrow("Provider request settings are invalid");
		expect(() =>
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				timeoutMs: 86_400_001,
			}),
		).toThrow("Provider request settings are invalid");
		expect(() =>
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				timeoutMs: 2_147_483_646,
			}),
		).toThrow("Provider request settings are invalid");
		expect(() =>
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				timeoutMs: 2_147_483_648,
			}),
		).toThrow("Provider request settings are invalid");
	});

	test("keeps websocket connect timeouts finite-only", () => {
		expect(
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				websocketConnectTimeoutMs: 86_400_000,
			}).websocketConnectTimeoutMs,
		).toBe(86_400_000);
		expect(() =>
			createProviderConnection(model(), {
				apiKey: "opaque-fixture-key",
				websocketConnectTimeoutMs: 2_147_483_647,
			}),
		).toThrow("Provider request settings are invalid");
	});
});

import { describe, expect, test } from "bun:test";

import {
	type CodexAuthentication,
	extractAccountId,
	resolveCodexAuthentication,
	sameCodexAuthentication,
} from "../../src/application/codex-runtime.ts";
import { toBridgeAuthentication } from "../../src/infrastructure/codex-bridge/runtime.ts";

function fixtureOauthToken(accountId = "account-fixture"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("Codex authentication derivation", () => {
	test("derives OAuth only for JWTs with the official account claim", () => {
		const token = fixtureOauthToken("acct-1");
		expect(extractAccountId(token)).toBe("acct-1");
		expect(resolveCodexAuthentication(token)).toEqual({
			kind: "oauth_bearer",
			token,
			accountId: "acct-1",
		} satisfies CodexAuthentication);
	});

	test("treats non-empty non-OAuth credentials as API keys", () => {
		const cases = ["sk-fixture-api-key", "header.e30.signature", "not-a-jwt", "a.b"];
		for (const credential of cases) {
			expect(extractAccountId(credential)).toBeUndefined();
			expect(resolveCodexAuthentication(credential)).toEqual({
				kind: "openai_api_key",
				apiKey: credential,
			} satisfies CodexAuthentication);
		}
	});

	test("fails closed for empty credentials without reflecting values", () => {
		try {
			resolveCodexAuthentication("");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("OpenAI Codex authentication is required");
			expect((error as Error).message).not.toContain("sk-");
			expect((error as Error).message).not.toContain("token");
		}
	});

	test("maps both variants to bridge protocol authentication", () => {
		const oauth = resolveCodexAuthentication(fixtureOauthToken());
		const apiKey = resolveCodexAuthentication("sk-fixture-api-key");
		expect(toBridgeAuthentication(oauth)).toEqual({
			kind: "oauth_bearer",
			token: fixtureOauthToken(),
			accountId: "account-fixture",
		});
		expect(toBridgeAuthentication(apiKey)).toEqual({
			kind: "openai_api_key",
			apiKey: "sk-fixture-api-key",
		});
	});

	test("compares authentication values by kind and secret fields", () => {
		const oauth = resolveCodexAuthentication(fixtureOauthToken());
		const oauthOtherAccount = resolveCodexAuthentication(fixtureOauthToken("other"));
		const apiKey = resolveCodexAuthentication("sk-fixture-api-key");
		const apiKeyOther = resolveCodexAuthentication("sk-other");

		expect(sameCodexAuthentication(undefined, oauth)).toBe(false);
		expect(sameCodexAuthentication(oauth, oauth)).toBe(true);
		expect(sameCodexAuthentication(oauth, oauthOtherAccount)).toBe(false);
		expect(sameCodexAuthentication(apiKey, apiKey)).toBe(true);
		expect(sameCodexAuthentication(apiKey, apiKeyOther)).toBe(false);
		expect(sameCodexAuthentication(oauth, apiKey)).toBe(false);
	});
});

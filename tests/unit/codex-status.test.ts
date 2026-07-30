import { describe, expect, test } from "bun:test";

import { formatCodexStatus } from "../../src/integration/pi/codex-status.ts";

describe("Codex status formatter", () => {
	test.each([
		[
			"unified exec",
			"unified-exec",
			"official",
			"standalone",
			"available",
			"on-request",
			"workspace",
			"Codex exec bg web",
		],
		[
			"shell command",
			"shell-command",
			"supplemental",
			"hosted",
			"available",
			"never",
			"unrestricted",
			"Codex sh bg+ web !never !fs !full",
		],
		[
			"no active optional surfaces",
			"shell-command",
			"disabled",
			"disabled",
			"disabled",
			"on-request",
			"workspace",
			"Codex sh",
		],
		[
			"disabled shell",
			"disabled",
			"unavailable",
			"unsupported",
			"unavailable",
			"on-request",
			"workspace",
			"Codex",
		],
	] as const)("renders %s surfaces compactly", (_name, primary, sessionSurface, webSurface, webSearchStatus, approvalPolicy, filesystemAccessPolicy, expected) => {
		expect(
			formatCodexStatus(
				{
					shell: { primary, sessionSurface },
					webSurface,
					webSearch: { status: webSearchStatus },
				},
				approvalPolicy,
				filesystemAccessPolicy,
			),
		).toBe(expected);
	});

	test.each([
		["disabled surface", "disabled", "available"],
		["unsupported surface", "unsupported", "available"],
		["unavailable search", "hosted", "unavailable"],
	] as const)("omits web for %s", (_name, webSurface, webSearchStatus) => {
		const status = formatCodexStatus(
			{
				shell: { primary: "unified-exec", sessionSurface: "official" },
				webSurface,
				webSearch: { status: webSearchStatus },
			},
			"on-request",
			"workspace",
		);
		expect(status).toBe("Codex exec bg");
		expect(status).not.toContain("web");
	});

	test.each([
		"disabled",
		"unavailable",
	] as const)("omits background sessions when %s", (sessionSurface) => {
		const status = formatCodexStatus(
			{
				shell: { primary: "shell-command", sessionSurface },
				webSurface: "disabled",
				webSearch: { status: "disabled" },
			},
			"on-request",
			"workspace",
		);
		expect(status).toBe("Codex sh");
		expect(status).not.toContain("bg");
	});

	test("keeps the longest normal status within 35 ASCII columns", () => {
		const status = formatCodexStatus(
			{
				shell: { primary: "shell-command", sessionSurface: "supplemental" },
				webSurface: "hosted",
				webSearch: { status: "available" },
			},
			"never",
			"unrestricted",
		);
		expect(status).toBe("Codex sh bg+ web !never !fs !full");
		expect(status.length).toBeLessThanOrEqual(35);
	});
});

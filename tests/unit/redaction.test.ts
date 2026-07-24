import { describe, expect, test } from "bun:test";

import {
	REDACTED,
	REDACTED_COMPACTION,
	REDACTED_PATH,
	redactString,
	redactValue,
} from "../../src/domain/redaction.ts";

describe("redaction policy", () => {
	test("redacts API tokens without retaining raw values", () => {
		const token = "sk-testfixture0001";
		const redacted = redactString(`using ${token} for auth`);
		expect(redacted).toBe(`using ${REDACTED} for auth`);
		expect(redacted.includes(token)).toBe(false);
		expect(JSON.stringify(redactValue({ token }))).not.toInclude(token);
	});

	test("redacts authorization headers without retaining raw values", () => {
		const header = "Authorization: Bearer fixture-header-token-001";
		const redacted = redactString(header);
		expect(redacted.toLowerCase()).toInclude("authorization");
		expect(redacted).toInclude(REDACTED);
		expect(redacted.includes("fixture-header-token-001")).toBe(false);
		expect(
			JSON.stringify(
				redactValue({
					authorization: "Bearer fixture-header-token-002",
				}),
			),
		).not.toInclude("fixture-header-token-002");
	});

	test("redacts user content fields without retaining raw values", () => {
		const prompt = "user-private-prompt-fixture";
		const redacted = redactValue({
			model: "gpt-fixture",
			prompt,
			message: "user-private-message-fixture",
			content: "user-private-content-fixture",
		});
		const serialized = JSON.stringify(redacted);
		expect(redacted).toEqual({
			model: "gpt-fixture",
			prompt: REDACTED,
			message: REDACTED,
			content: REDACTED,
		});
		expect(serialized.includes(prompt)).toBe(false);
		expect(serialized.includes("user-private-message-fixture")).toBe(false);
		expect(serialized.includes("user-private-content-fixture")).toBe(false);
	});

	test("redacts absolute user paths without retaining raw values", () => {
		const unixPath = "/home/fixture-user/project/secret.ts";
		const windowsPath = "C:\\Users\\fixture-user\\project\\secret.ts";
		const redacted = redactValue({
			summary: `failed at ${unixPath}`,
			workdir: unixPath,
			windows: windowsPath,
		});
		const serialized = JSON.stringify(redacted);
		expect(redacted).toEqual({
			summary: `failed at ${REDACTED_PATH}`,
			workdir: REDACTED_PATH,
			windows: REDACTED_PATH,
		});
		expect(serialized.includes("fixture-user")).toBe(false);
		expect(serialized.includes(unixPath)).toBe(false);
		expect(serialized.includes(windowsPath)).toBe(false);
	});

	test("redacts opaque compaction data without retaining raw values", () => {
		const opaque = {
			type: "compaction_item",
			body: "opaque-compaction-fixture-body",
			summary: "portable-summary-fixture",
		};
		const redacted = redactValue({
			status: "completed",
			compaction: opaque,
			compaction_output: opaque,
			compacted_items: [opaque],
		});
		const serialized = JSON.stringify(redacted);
		expect(redacted).toEqual({
			status: "completed",
			compaction: REDACTED_COMPACTION,
			compaction_output: REDACTED_COMPACTION,
			compacted_items: REDACTED_COMPACTION,
		});
		expect(serialized.includes("opaque-compaction-fixture-body")).toBe(false);
		expect(serialized.includes("compaction_item")).toBe(false);
		expect(serialized.includes("portable-summary-fixture")).toBe(false);
	});

	test("does not treat ordinary tool result output keys as opaque compaction", () => {
		const redacted = redactValue({
			tool: "shell",
			output: "command stdout fixture",
			exitCode: 0,
			nested: {
				output: ["line-one", "line-two"],
			},
		});
		expect(redacted).toEqual({
			tool: "shell",
			output: "command stdout fixture",
			exitCode: 0,
			nested: {
				output: ["line-one", "line-two"],
			},
		});
	});

	test("redacts session input preview fields without retaining raw values", () => {
		const preview = "secret-session-stdin-fixture";
		const redacted = redactValue({
			sessionId: "12",
			inputPreview: preview,
			chars: preview,
			summary: "safe summary",
		});
		const serialized = JSON.stringify(redacted);
		expect(redacted).toEqual({
			sessionId: "12",
			inputPreview: REDACTED,
			chars: REDACTED,
			summary: "safe summary",
		});
		expect(serialized.includes(preview)).toBe(false);
	});
});

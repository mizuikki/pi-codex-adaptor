import { describe, expect, test } from "bun:test";

import { ApprovalModel } from "../../src/ui/terminal/approval-model.ts";

describe("approval view model", () => {
	test("defaults focus to decline and keeps allow last", () => {
		const view = new ApprovalModel(
			{
				operation: "command",
				summary: "rg --files",
				details: { workdir: "/workspace" },
			},
			{ cwd: "/workspace" },
		);

		expect(view.defaultDecision).toBe("decline");
		expect(view.focusedOption.id).toBe("decline");
		expect(view.options().map((option) => option.id)).toEqual(["decline", "cancel", "allow_once"]);
		expect(view.selectFocused()).toBe("decline");
	});

	test("escape dismisses as cancel rather than allow", () => {
		const view = new ApprovalModel({
			operation: "patch",
			summary: "apply workspace patch",
			details: { paths: ["src/a.ts", "src/b.ts"] },
		});
		expect(view.dismiss()).toBe("cancel");
		expect(view.decision).toBe("cancel");
	});

	test("renders monochrome approval choices with safe default marker", () => {
		const view = new ApprovalModel({
			operation: "network",
			summary: "search documentation",
			details: { path: "https://example.test" },
		});
		const text = view.lines(72).join("\n");
		expect(text).toContain("Approve network access");
		expect(text).toContain("> Decline");
		expect(text).toContain("Cancel tool call");
		expect(text).toContain("Allow once: search documentation");
		expect(text).not.toContain("\u001b");
		expect(text.split("\n").every((line) => line.length <= 72)).toBe(true);
	});

	test("renders session write approvals with session id and input preview", () => {
		const view = new ApprovalModel({
			operation: "command",
			summary: "printf hello\\n",
			details: {
				sessionId: "42",
				inputPreview: "printf hello\\n",
			},
		});
		expect(view.title).toBe("Approve session write");
		expect(view.sessionId).toBe("42");
		expect(view.target).toBe("session 42");
		expect(view.inputPreview).toBe("printf hello\\n");
		const rendered = view.lines(72).join("\n");
		expect(rendered).toContain("Approve session write");
		expect(rendered).toContain("Target: session 42");
		expect(rendered).toContain("printf hello\\n");
		expect(rendered).toContain("> Decline");
		expect(rendered.split("\n").every((line) => line.length <= 72)).toBe(true);
	});
});

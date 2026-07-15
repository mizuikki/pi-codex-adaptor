import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { requestCodexApproval } from "../../src/ui/terminal/approval-prompt.ts";

type OverlayComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose(): void;
};

type OverlayFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (value: unknown) => void,
) => OverlayComponent;

describe("approval prompt binding", () => {
	test("declines immediately without UI", async () => {
		const decision = await requestCodexApproval(
			{ hasUI: false, cwd: "/workspace", mode: "print", ui: {} } as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "command",
				summary: "fixture command",
				details: { workdir: "/workspace" },
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
		);
		expect(decision).toBe("decline");
	});

	test("uses Decline-first ApprovalModel defaults in TUI custom overlays", async () => {
		let rendered = "";
		const decision = await requestCodexApproval(
			{
				hasUI: true,
				mode: "tui",
				cwd: "/workspace",
				ui: {
					custom: async (factory: OverlayFactory) => {
						return await new Promise((resolve) => {
							const component = factory({}, {}, {}, resolve);
							rendered = component.render(72).join("\n");
							// Enter selects the focused default, which is Decline.
							component.handleInput("\r");
						});
					},
					notify: () => {},
				},
			} as unknown as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "command",
				summary: "rg --files",
				details: { workdir: "/workspace" },
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
		);
		expect(decision).toBe("decline");
		expect(rendered).toContain("> Decline");
		expect(rendered).toContain("Allow once: rg --files");
	});

	test("falls back to select with Decline first outside TUI", async () => {
		const choicesSeen: string[][] = [];
		const decision = await requestCodexApproval(
			{
				hasUI: true,
				mode: "rpc",
				cwd: "/workspace",
				ui: {
					select: async (_title: string, choices: string[]) => {
						choicesSeen.push(choices);
						return choices[0];
					},
					notify: () => {},
				},
			} as unknown as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "network",
				summary: "search documentation",
				details: { path: "https://example.test" },
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
		);
		expect(choicesSeen[0]).toEqual([
			"Decline",
			"Cancel tool call",
			"Allow once: search documentation",
		]);
		expect(decision).toBe("decline");
	});

	test("dispose resolves fail-closed exactly once", async () => {
		let doneCount = 0;
		const decision = await requestCodexApproval(
			{
				hasUI: true,
				mode: "tui",
				cwd: "/workspace",
				ui: {
					custom: async (factory: OverlayFactory) => {
						return await new Promise((resolve) => {
							const component = factory({}, {}, {}, (value) => {
								doneCount += 1;
								resolve(value);
							});
							component.dispose();
							component.dispose();
							component.handleInput("\r");
						});
					},
					notify: () => {},
				},
			} as unknown as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "command",
				summary: "rm -rf /",
				details: { sessionId: "7", inputPreview: "rm -rf /" },
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
		);
		expect(decision).toBe("cancel");
		expect(doneCount).toBe(1);
	});

	test("input decision wins a race against later dispose and stays single-shot", async () => {
		let doneCount = 0;
		const decision = await requestCodexApproval(
			{
				hasUI: true,
				mode: "tui",
				cwd: "/workspace",
				ui: {
					custom: async (factory: OverlayFactory) => {
						return await new Promise((resolve) => {
							const component = factory({}, {}, {}, (value) => {
								doneCount += 1;
								resolve(value);
							});
							// Focus starts on Decline; Enter selects it.
							component.handleInput("\r");
							component.dispose();
							component.handleInput("\r");
						});
					},
					notify: () => {},
				},
			} as unknown as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "command",
				summary: "echo fixture",
				details: { sessionId: "9", inputPreview: "echo fixture" },
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
		);
		expect(decision).toBe("decline");
		expect(doneCount).toBe(1);
	});

	test("abort signal disposes the overlay fail-closed and never resolves allow", async () => {
		let disposed = false;
		let doneCount = 0;
		const controller = new AbortController();
		const decisionPromise = requestCodexApproval(
			{
				hasUI: true,
				mode: "tui",
				cwd: "/workspace",
				ui: {
					custom: async (factory: OverlayFactory) => {
						return await new Promise((resolve) => {
							const component = factory({}, {}, {}, (value) => {
								doneCount += 1;
								resolve(value);
							});
							const originalDispose = component.dispose.bind(component);
							component.dispose = () => {
								disposed = true;
								originalDispose();
							};
							controller.abort();
						});
					},
					notify: () => {},
				},
			} as unknown as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "command",
				summary: "sleep 30",
				details: { workdir: "/workspace" },
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
			controller.signal,
		);
		const decision = await decisionPromise;
		expect(decision).toBe("cancel");
		expect(disposed).toBe(true);
		expect(doneCount).toBe(1);
	});

	test("shows session id and bounded input preview for session write approvals", async () => {
		let rendered = "";
		const decision = await requestCodexApproval(
			{
				hasUI: true,
				mode: "tui",
				cwd: "/workspace",
				ui: {
					custom: async (factory: OverlayFactory) => {
						return await new Promise((resolve) => {
							const component = factory({}, {}, {}, resolve);
							rendered = component.render(72).join("\n");
							component.handleInput("\u001b");
						});
					},
					notify: () => {},
				},
			} as unknown as ExtensionContext,
			{
				approvalId: "approval-fixture",
				operation: "command",
				summary: "fixture\\n",
				details: {
					sessionId: "12",
					inputPreview: "fixture\\n",
				},
				availableDecisions: ["allow_once", "decline", "cancel"],
			},
		);
		expect(decision).toBe("cancel");
		expect(rendered).toContain("Approve session write");
		expect(rendered).toContain("Target: session 12");
		expect(rendered).toContain("fixture\\n");
	});
});

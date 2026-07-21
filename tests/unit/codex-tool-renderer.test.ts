import { describe, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";

import {
	CODEX_TOOL_GUTTER_CONTINUE,
	CODEX_TOOL_GUTTER_LAST,
	CODEX_TOOL_MARKER,
	type CodexToolPresentationKind,
	createCodexToolRenderer,
} from "../../src/ui/terminal/codex-tool-renderer.ts";

const theme = {
	fg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => `*${text}*`,
};

const THEME_TAG = /\[(?:warning|success|error|dim|muted|toolTitle|toolOutput)\]/g;

function lines(component: Component, width = 120): string[] {
	return component.render(width).map((line) => line.trimEnd());
}

function stacked(
	kind: CodexToolPresentationKind,
	args: unknown,
	result:
		| {
				content: readonly { type: string; text?: string }[];
				details?: unknown;
		  }
		| undefined,
	options: { expanded: boolean; isPartial: boolean; isError?: boolean; executionStarted?: boolean },
	width = 120,
): string[] {
	const renderer = createCodexToolRenderer(kind);
	const executionStarted = options.executionStarted ?? result !== undefined;
	const context = {
		args,
		toolCallId: "call-fixture",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/workspace",
		executionStarted,
		argsComplete: true,
		isPartial: options.isPartial,
		expanded: options.expanded,
		showImages: false,
		isError: options.isError === true,
	};
	const call = renderer.renderCall?.(args as never, theme as never, context as never);
	const resultLines =
		result === undefined
			? []
			: lines(
					renderer.renderResult?.(
						result as never,
						{ expanded: options.expanded, isPartial: options.isPartial },
						theme as never,
						context as never,
					) as Component,
					width,
				);
	const callLines = call === undefined ? [] : lines(call, width);
	return [...callLines, ...resultLines];
}

function plainStacked(
	kind: CodexToolPresentationKind,
	args: unknown,
	result:
		| {
				content: readonly { type: string; text?: string }[];
				details?: unknown;
		  }
		| undefined,
	options: { expanded: boolean; isPartial: boolean; isError?: boolean; executionStarted?: boolean },
	width = 120,
): string[] {
	return stacked(kind, args, result, options, width).map((line) => line.replace(THEME_TAG, ""));
}

function headerLines(rows: string[]): string[] {
	return rows.filter((line) => line.startsWith(`${CODEX_TOOL_MARKER} `));
}

describe("codex tool renderer contract", () => {
	test("owns literal structural glyphs and ASCII omission text", () => {
		const output = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
		const text = plainStacked(
			"command",
			{ cmd: "rg --files" },
			{
				content: [{ type: "text", text: `${output}\n{"status":"completed"}` }],
				details: { status: "completed", output, wall_time_seconds: 0.2, exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
		).join("\n");
		expect(text).toContain(CODEX_TOOL_MARKER);
		expect(text).toContain(CODEX_TOOL_GUTTER_CONTINUE);
		expect(text).toContain(CODEX_TOOL_GUTTER_LAST);
		expect(text).toContain("... 3 lines omitted");
		expect(text).not.toContain("\u2026");
	});

	test("composes a single running header for partial output and a single terminal header", () => {
		const partial = plainStacked(
			"command",
			{ cmd: "bun test" },
			{
				content: [
					{ type: "text", text: "pass renderer call summary\npass renderer privacy cases" },
				],
				details: { status: "running" },
			},
			{ expanded: false, isPartial: true, executionStarted: true },
		);
		expect(headerLines(partial)).toEqual([`${CODEX_TOOL_MARKER} *Running bun test*`]);
		expect(partial).toEqual([
			`${CODEX_TOOL_MARKER} *Running bun test*`,
			`  ${CODEX_TOOL_GUTTER_CONTINUE} pass renderer call summary`,
			`  ${CODEX_TOOL_GUTTER_LAST} pass renderer privacy cases`,
		]);

		const terminal = plainStacked(
			"command",
			{ cmd: "bun test" },
			{
				content: [
					{
						type: "text",
						text: 'pass renderer call summary\n{"status":"completed","exit_code":0}',
					},
				],
				details: {
					status: "completed",
					output: "pass renderer call summary\npass renderer privacy cases",
					wall_time_seconds: 1.4,
					exit_code: 0,
				},
			},
			{ expanded: false, isPartial: false, executionStarted: true },
		);
		expect(headerLines(terminal)).toEqual([`${CODEX_TOOL_MARKER} *Ran bun test (1.4s)*`]);
	});

	test("HTML-export-like call context does not emit a Running header beside the terminal result", () => {
		const renderer = createCodexToolRenderer("command");
		const args = { cmd: "bun test" };
		// Pi HTML export always invokes renderCall with isPartial:true and executionStarted:true.
		const exportCallContext = {
			args,
			toolCallId: "call-fixture",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: "/workspace",
			executionStarted: true,
			argsComplete: true,
			isPartial: true,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const call = renderer.renderCall?.(args as never, theme as never, exportCallContext as never);
		expect(call?.render(100) ?? []).toEqual([]);

		const result = renderer.renderResult?.(
			{
				content: [{ type: "text", text: "ok" }],
				details: { status: "completed", output: "ok", exit_code: 0 },
			} as never,
			{ expanded: false, isPartial: false },
			theme as never,
			{ ...exportCallContext, isPartial: false } as never,
		);
		const plain = (result?.render(100) ?? []).map((line) => line.replace(THEME_TAG, "").trimEnd());
		expect(headerLines(plain)).toEqual([`${CODEX_TOOL_MARKER} *Ran bun test*`]);
		expect(plain.join("\n")).not.toContain("Running");
	});

	test("treats context.isError as failure even without details.status", () => {
		const kinds: CodexToolPresentationKind[] = [
			"command",
			"session-input",
			"patch",
			"view-image",
			"image-generation",
			"web",
			"plan",
		];
		for (const kind of kinds) {
			const args =
				kind === "command"
					? { cmd: "false" }
					: kind === "session-input"
						? { session_id: 3, chars: "" }
						: kind === "view-image"
							? { path: "a.png" }
							: kind === "web"
								? { search_query: [{ q: "q" }] }
								: kind === "plan"
									? { plan: [] }
									: kind === "image-generation"
										? { prompt: "hidden" }
										: { input: "hidden-patch" };
			const rows = plainStacked(
				kind,
				args,
				{ content: [{ type: "text", text: "boom" }], details: {} },
				{ expanded: false, isPartial: false, isError: true },
			);
			const header = rows[0] ?? "";
			expect(header.startsWith(`${CODEX_TOOL_MARKER} `)).toBe(true);
			expect(header.toLowerCase()).toContain("fail");
			expect(header).not.toContain("Ran ");
			expect(header).not.toContain("Updated files");
			expect(header).not.toContain("Generated image");
			expect(header).not.toContain("Updated plan");
			expect(
				stacked(
					kind,
					args,
					{ content: [], details: {} },
					{
						expanded: false,
						isPartial: false,
						isError: true,
					},
				).join("\n"),
			).toContain("[error]");
		}
	});

	test("unknown status is neutral and never success-colored", () => {
		const styled = stacked(
			"command",
			{ cmd: "legacy" },
			{ content: [{ type: "text", text: "ok" }], details: null },
			{ expanded: false, isPartial: false },
		).join("\n");
		expect(styled).toContain("[dim]");
		expect(styled).not.toContain("[success]");
		const plain = plainStacked(
			"command",
			{ cmd: "legacy" },
			{ content: [{ type: "text", text: "ok" }], details: null },
			{ expanded: false, isPartial: false },
		);
		expect(plain[0]).toContain("Command finished");
	});

	test("uses details.output and hides model-visible metadata suffixes", () => {
		const text = plainStacked(
			"command",
			{ command: "true" },
			{
				content: [
					{
						type: "text",
						text: 'shell output\n{"status":"completed","exit_code":0,"wall_time_seconds":0.1}',
					},
				],
				details: {
					status: "completed",
					output: "shell output",
					exit_code: 0,
					wall_time_seconds: 0.1,
				},
			},
			{ expanded: false, isPartial: false },
		).join("\n");
		expect(text).toContain("shell output");
		expect(text).not.toContain('"status"');
		expect(text).not.toContain("wall_time_seconds");
	});

	test("maps exit_code and exitCode to equivalent failure state", () => {
		const snake = plainStacked(
			"command",
			{ cmd: "bun test" },
			{
				content: [{ type: "text", text: "assertion failed" }],
				details: { status: "completed", output: "assertion failed", exit_code: 1 },
			},
			{ expanded: false, isPartial: false },
		);
		const camel = plainStacked(
			"command",
			{ cmd: "bun test" },
			{
				content: [{ type: "text", text: "assertion failed" }],
				details: { status: "completed", output: "assertion failed", exitCode: 1 },
			},
			{ expanded: false, isPartial: false },
		);
		expect(snake[0]).toBe(`${CODEX_TOOL_MARKER} *Command failed bun test (exit 1)*`);
		expect(camel[0]).toBe(snake[0]);
	});

	test("renders timed-out and aborted command states textually", () => {
		expect(
			plainStacked(
				"command",
				{ cmd: "bun test" },
				{ content: [], details: { status: "timed_out" } },
				{ expanded: false, isPartial: false },
			)[0],
		).toBe(`${CODEX_TOOL_MARKER} *Command timed out bun test*`);
		expect(
			plainStacked(
				"command",
				{ cmd: "bun test" },
				{ content: [], details: { status: "aborted" } },
				{ expanded: false, isPartial: false },
			)[0],
		).toBe(`${CODEX_TOOL_MARKER} *Command aborted bun test*`);
	});

	test("shows (no output) for completed empty command results", () => {
		const text = plainStacked(
			"command",
			{ cmd: "true" },
			{
				content: [{ type: "text", text: '{"status":"completed","exit_code":0}' }],
				details: { status: "completed", output: "", exit_code: 0, wall_time_seconds: 0.1 },
			},
			{ expanded: false, isPartial: false },
		);
		expect(text).toEqual([
			`${CODEX_TOOL_MARKER} *Ran true (0.1s)*`,
			`  ${CODEX_TOOL_GUTTER_LAST} (no output)`,
		]);
	});

	test("expands complete native-bounded command output without an omission row", () => {
		const output = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
		const collapsed = plainStacked(
			"command",
			{ cmd: "bun test" },
			{ content: [{ type: "text", text: output }], details: { status: "completed", output } },
			{ expanded: false, isPartial: false },
		);
		expect(collapsed.some((line) => line.includes("... 2 lines omitted"))).toBe(true);
		const expanded = plainStacked(
			"command",
			{ cmd: "bun test" },
			{ content: [{ type: "text", text: output }], details: { status: "completed", output } },
			{ expanded: true, isPartial: false },
		);
		expect(expanded.some((line) => line.includes("lines omitted"))).toBe(false);
		expect(
			expanded.filter(
				(line) =>
					line.includes(CODEX_TOOL_GUTTER_CONTINUE) || line.includes(CODEX_TOOL_GUTTER_LAST),
			).length,
		).toBe(7);
	});

	test("distinguishes session polling from non-empty write_stdin and exposes failure text", () => {
		const waiting = plainStacked("session-input", { session_id: 7, chars: "" }, undefined, {
			expanded: false,
			isPartial: true,
			executionStarted: false,
		});
		expect(waiting).toEqual([`${CODEX_TOOL_MARKER} *Waiting for background session 7*`]);

		const sentCollapsed = plainStacked(
			"session-input",
			{ session_id: 7, chars: "yes\n" },
			{
				content: [{ type: "text", text: "accepted" }],
				details: { status: "completed", output: "accepted", session_id: 7 },
			},
			{ expanded: false, isPartial: false },
		);
		expect(sentCollapsed).toEqual([
			`${CODEX_TOOL_MARKER} *Sent input to background session 7*`,
			`  ${CODEX_TOOL_GUTTER_LAST} accepted`,
		]);
		expect(sentCollapsed.join("\n")).not.toContain("Input:");

		const sentExpanded = plainStacked(
			"session-input",
			{ session_id: 7, chars: "yes\n" },
			{
				content: [{ type: "text", text: "accepted" }],
				details: { status: "completed", output: "accepted", session_id: 7 },
			},
			{ expanded: true, isPartial: false },
		);
		expect(sentExpanded).toEqual([
			`${CODEX_TOOL_MARKER} *Sent input to background session 7*`,
			`  ${CODEX_TOOL_GUTTER_CONTINUE} Input: yes\\n`,
			`  ${CODEX_TOOL_GUTTER_LAST} accepted`,
		]);

		expect(
			plainStacked(
				"session-input",
				{ session_id: 7, chars: "" },
				{ content: [], details: { status: "failed" } },
				{ expanded: false, isPartial: false },
			)[0],
		).toBe(`${CODEX_TOOL_MARKER} *Waiting for background session 7 failed*`);
		expect(
			plainStacked(
				"session-input",
				{ session_id: 7, chars: "x" },
				{ content: [], details: { status: "timed_out" } },
				{ expanded: false, isPartial: false },
			)[0],
		).toBe(`${CODEX_TOOL_MARKER} *Sending input to background session 7 timed out*`);
		expect(
			plainStacked(
				"session-input",
				{ session_id: 7, chars: "x" },
				{ content: [], details: { status: "aborted" } },
				{ expanded: false, isPartial: false },
			)[0],
		).toBe(`${CODEX_TOOL_MARKER} *Sending input to background session 7 aborted*`);
	});

	test("preserves gutter structure at narrow widths", () => {
		const longCommand = `bun test ${"x".repeat(80)}`;
		const longOutput = `output-line-${"y".repeat(80)}`;
		const rows = plainStacked(
			"command",
			{ cmd: longCommand },
			{
				content: [{ type: "text", text: longOutput }],
				details: { status: "completed", output: longOutput, exit_code: 0 },
			},
			{ expanded: false, isPartial: false },
			40,
		);
		expect(rows[0]?.startsWith(`${CODEX_TOOL_MARKER} `)).toBe(true);
		expect(rows[0]).toContain("Ran");
		expect(rows[0]?.includes("\n")).toBe(false);
		// Header stays one logical presentation line at width 40 after truncation.
		expect(rows.filter((line) => line.startsWith(`${CODEX_TOOL_MARKER} `))).toHaveLength(1);
		const detail = rows.find((line) => line.includes(CODEX_TOOL_GUTTER_LAST));
		expect(detail?.startsWith(`  ${CODEX_TOOL_GUTTER_LAST} `)).toBe(true);
		// Wrapped continuations indent under content, never invent a second marker/gutter.
		for (const line of rows) {
			if (line.startsWith("    ")) {
				expect(line.includes(CODEX_TOOL_MARKER)).toBe(false);
				expect(line.includes(CODEX_TOOL_GUTTER_CONTINUE)).toBe(false);
				expect(line.includes(CODEX_TOOL_GUTTER_LAST)).toBe(false);
			}
		}
	});

	test("renders structured patch paths and never shows patch input", () => {
		const text = plainStacked(
			"patch",
			{ input: "*** Begin Patch\nsecret patch body\n*** End Patch" },
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					status: "completed",
					added: ["src/new-file.ts"],
					modified: ["src/existing-file.ts"],
					deleted: ["src/old-file.ts"],
				},
			},
			{ expanded: true, isPartial: false },
		).join("\n");
		expect(text).toContain("Added src/new-file.ts");
		expect(text).toContain("Modified src/existing-file.ts");
		expect(text).toContain("Deleted src/old-file.ts");
		expect(text).not.toContain("Begin Patch");
		expect(text).not.toContain("secret");
	});

	test("never renders image prompts, revised prompts, or raw web output", () => {
		const image = plainStacked(
			"image-generation",
			{ prompt: "secret image prompt", revised_prompt: "secret revised" },
			{
				content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" } as never],
				details: { status: "completed", revised_prompt: "secret revised" },
			},
			{ expanded: true, isPartial: false },
		).join("\n");
		expect(image).toBe(`${CODEX_TOOL_MARKER} *Generated image*`);
		expect(image).not.toContain("secret");

		const view = plainStacked(
			"view-image",
			{ path: "fixtures/example.png", detail: "high" },
			{
				content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" } as never],
				details: { status: "completed", detail: "high" },
			},
			{ expanded: true, isPartial: false },
		);
		expect(view).toEqual([`${CODEX_TOOL_MARKER} *Viewed fixtures/example.png (high)*`]);

		const web = plainStacked(
			"web",
			{ search_query: [{ q: "renderer contracts" }] },
			{
				content: [{ type: "text", text: "raw web response with turn0search0" }],
				details: { status: "completed", output: "raw web response with turn0search0" },
			},
			{ expanded: true, isPartial: false },
		).join("\n");
		expect(web).toBe(`${CODEX_TOOL_MARKER} *Searched web for renderer contracts*`);
		expect(web).not.toContain("raw web");
		expect(web).not.toContain("turn0search0");
	});

	test("renders plan checklist rows from allowlisted plan items", () => {
		const text = plainStacked(
			"plan",
			{
				plan: [
					{ step: "Inspect renderer contract", status: "completed" },
					{ step: "Implement compact rows", status: "in_progress" },
					{ step: "Run verification", status: "pending" },
				],
			},
			{
				content: [{ type: "text", text: "Plan updated" }],
				details: {
					plan: [
						{ step: "Inspect renderer contract", status: "completed" },
						{ step: "Implement compact rows", status: "in_progress" },
						{ step: "Run verification", status: "pending" },
					],
				},
			},
			{ expanded: false, isPartial: false },
		);
		expect(text).toEqual([
			`${CODEX_TOOL_MARKER} *Updated plan*`,
			`  ${CODEX_TOOL_GUTTER_CONTINUE} [x] Inspect renderer contract`,
			`  ${CODEX_TOOL_GUTTER_CONTINUE} [>] Implement compact rows`,
			`  ${CODEX_TOOL_GUTTER_LAST} [ ] Run verification`,
		]);
	});

	test("falls back safely for malformed details and injected objects", () => {
		const malformed = plainStacked(
			"command",
			{ cmd: "rg" },
			{
				content: [{ type: "text", text: "ok" }],
				details: null,
			},
			{ expanded: false, isPartial: false },
		);
		expect(malformed[0]?.startsWith(`${CODEX_TOOL_MARKER} `)).toBe(true);
		expect(malformed.join("\n")).not.toContain("[object Object]");

		const injected = plainStacked(
			"command",
			{
				cmd: "echo",
				connection: { authorization: "secret-token", headers: { Authorization: "Bearer x" } },
				environment: { HOME: "/home/user" },
			},
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					status: "completed",
					output: "ok",
					connection: { apiKey: "secret" },
					headers: { Authorization: "Bearer x" },
				},
			},
			{ expanded: true, isPartial: false },
		).join("\n");
		expect(injected).toContain("ok");
		expect(injected).not.toContain("secret");
		expect(injected).not.toContain("Bearer");
		expect(injected).not.toContain("Authorization");
		expect(injected).not.toContain("/home/user");
	});

	test("styles running markers with warning and terminal success/error roles", () => {
		const running = stacked("command", { cmd: "rg" }, undefined, {
			expanded: false,
			isPartial: true,
			executionStarted: false,
		}).join("\n");
		expect(running).toContain("[warning]");
		expect(running).toContain("[toolTitle]");

		const ok = stacked(
			"command",
			{ cmd: "rg" },
			{ content: [], details: { status: "completed", output: "a", exit_code: 0 } },
			{ expanded: false, isPartial: false },
		).join("\n");
		expect(ok).toContain("[success]");
		expect(ok).toContain("[dim]");
		expect(ok).toContain("[toolOutput]");

		const failed = stacked(
			"command",
			{ cmd: "rg" },
			{ content: [], details: { status: "failed", output: "nope", exit_code: 2 } },
			{ expanded: false, isPartial: false },
		).join("\n");
		expect(failed).toContain("[error]");
	});

	test("covers every presentation kind with deterministic running labels", () => {
		const cases: Array<[CodexToolPresentationKind, unknown, string]> = [
			["command", { cmd: "ls" }, "Running ls"],
			["session-input", { session_id: 3, chars: "" }, "Waiting for background session 3"],
			["session-input", { session_id: 3, chars: "x" }, "Sending input to background session 3"],
			["patch", { input: "patch" }, "Applying patch"],
			["view-image", { path: "a.png" }, "Viewing a.png"],
			["image-generation", { prompt: "hidden" }, "Generating image"],
			["web", { search_query: [{ q: "docs" }] }, "Searching web for docs"],
			["plan", { plan: [] }, "Updating plan"],
		];
		for (const [kind, args, expected] of cases) {
			const text = plainStacked(kind, args, undefined, {
				expanded: false,
				isPartial: true,
				executionStarted: false,
			}).join("\n");
			expect(text).toContain(expected);
			expect(text).not.toContain("hidden");
			expect(text).not.toContain("prompt");
		}
	});
});

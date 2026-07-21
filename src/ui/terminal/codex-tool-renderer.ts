import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Managed-tool presentation kinds. One kind per registered Codex tool family. */
export type CodexToolPresentationKind =
	| "command"
	| "session-input"
	| "patch"
	| "view-image"
	| "image-generation"
	| "web"
	| "plan";

/** Renderer-owned single-column structural glyphs. Themes supply color only. */
export const CODEX_TOOL_MARKER = "\u2022";
export const CODEX_TOOL_GUTTER_CONTINUE = "\u2502";
export const CODEX_TOOL_GUTTER_LAST = "\u2514";

const COLLAPSED_OUTPUT_LINES = 5;
const DEFAULT_SUMMARY_LIMIT = 64;
const INPUT_PREVIEW_LIMIT = 48;
const WEB_QUERY_LIMIT = 48;
/** Marker + space before the action title. */
const HEADER_PREFIX_COLS = 2;
/** Two spaces + gutter + space before detail content. */
const DETAIL_PREFIX_COLS = 4;

type ThemeLike = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type ResultLike = {
	content: readonly { type: string; text?: string }[];
	details?: unknown;
};

type ResultOptions = {
	expanded: boolean;
	isPartial: boolean;
};

type RenderContextLike = {
	args?: unknown;
	isPartial?: boolean;
	executionStarted?: boolean;
	isError?: boolean;
};

type NativeToolPresentationDetails = {
	status?: string;
	output?: string;
	exit_code?: number;
	exitCode?: number;
	wall_time_seconds?: number;
	session_id?: number;
	original_token_count?: number;
	added?: string[];
	modified?: string[];
	deleted?: string[];
	detail?: string;
};

type TerminalState = "completed" | "failed" | "timed_out" | "aborted" | "running" | "unknown";

type DetailRow = {
	text: string;
	kind: "output" | "muted";
};

type HeaderModel = {
	state: TerminalState;
	/** Flat title used when structured fields are absent. */
	title: string;
	/** Optional structured command title: clip only the summary body. */
	action?: string;
	summary?: string;
	suffix?: string;
};

type PresentationModel = {
	header?: HeaderModel;
	details: DetailRow[];
	theme: ThemeLike;
};

/**
 * Build call-local `renderCall`/`renderResult` for one managed Codex tool kind.
 * Side-effect free: no timers, globals, bridge access, or mutation of tool data.
 *
 * Header ownership:
 * - Args-only (not yet started): `renderCall` owns the running header.
 * - Partial/terminal results: `renderResult` owns the single header so stacked live
 *   rows and HTML export (which always invokes `renderCall` with `isPartial: true`
 *   even for completed tools) never show both Running and Ran.
 */
export function createCodexToolRenderer(
	kind: CodexToolPresentationKind,
): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall: (args, theme, context) => {
			try {
				if (callSlotShouldBeEmpty(context)) {
					return emptyComponent();
				}
				return present(
					{
						header: runningHeader(kind, args),
						details: [],
						theme,
					},
					theme,
				);
			} catch {
				return present(
					{
						header: {
							state: "running",
							title: safeFallbackTitle(kind, true),
						},
						details: [],
						theme,
					},
					theme,
				);
			}
		},
		renderResult: (result, options, theme, context) => {
			try {
				const args = context?.args;
				if (options.isPartial) {
					return present(
						{
							header: runningHeader(kind, args),
							details: partialDetailRows(kind, result, options, args),
							theme,
						},
						theme,
					);
				}
				const details = presentDetails(result.details);
				const state = resolveTerminalState(details, result, context?.isError === true);
				return present(
					{
						header: terminalHeader(kind, args, details, state),
						details: terminalDetailRows(kind, result, options, args, details),
						theme,
					},
					theme,
				);
			} catch {
				const failed = context?.isError === true;
				return present(
					{
						header: {
							state: failed ? "failed" : "unknown",
							title: safeFallbackTitle(kind, false, failed),
						},
						details: [],
						theme,
					},
					theme,
				);
			}
		},
	};
}

function callSlotShouldBeEmpty(context: RenderContextLike | undefined): boolean {
	// Terminal live rows: result owns the complete header.
	if (context?.isPartial === false) return true;
	// Once execution has started, the result slot owns the running/terminal header.
	// HTML export always sets executionStarted=true on renderCall, so completed tools
	// do not emit a second Running header beside the terminal result.
	if (context?.executionStarted === true) return true;
	return false;
}

function present(model: PresentationModel, theme: ThemeLike): Component {
	return new CodexToolPresentationComponent({ ...model, theme });
}

function emptyComponent(): Component {
	return new CodexToolPresentationComponent({ details: [], theme: identityTheme });
}

const identityTheme: ThemeLike = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

/** Width-aware presentation: clips headers and wraps detail content under gutters. */
class CodexToolPresentationComponent implements Component {
	private readonly model: PresentationModel;

	constructor(model: PresentationModel) {
		this.model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const safeWidth = Math.max(1, Math.floor(width));
		const header = this.model.header;
		if (header !== undefined) {
			const titleBudget = Math.max(1, safeWidth - HEADER_PREFIX_COLS);
			const title = formatHeaderTitle(header, titleBudget);
			const markerColor = markerThemeColor(header.state);
			const marker = this.model.theme.fg(markerColor, CODEX_TOOL_MARKER);
			const styledTitle = this.model.theme.fg("toolTitle", this.model.theme.bold(title));
			lines.push(`${marker} ${styledTitle}`);
		}
		const details = this.model.details;
		for (let index = 0; index < details.length; index += 1) {
			const row = details[index];
			if (row === undefined) continue;
			const isLast = index === details.length - 1;
			const gutter = isLast ? CODEX_TOOL_GUTTER_LAST : CODEX_TOOL_GUTTER_CONTINUE;
			const styledGutter = this.model.theme.fg("dim", gutter);
			const styledText =
				row.kind === "muted"
					? this.model.theme.fg("muted", row.text)
					: this.model.theme.fg("toolOutput", row.text);
			const contentBudget = Math.max(1, safeWidth - DETAIL_PREFIX_COLS);
			const wrapped = wrapTextWithAnsi(styledText, contentBudget);
			if (wrapped.length === 0) {
				lines.push(`  ${styledGutter} `);
				continue;
			}
			for (let wrapIndex = 0; wrapIndex < wrapped.length; wrapIndex += 1) {
				const segment = wrapped[wrapIndex] ?? "";
				if (wrapIndex === 0) {
					lines.push(`  ${styledGutter} ${segment}`);
				} else {
					// Align continuations under detail content, not under a second gutter.
					lines.push(`    ${segment}`);
				}
			}
		}
		return lines;
	}
}

function markerThemeColor(state: TerminalState): string {
	switch (state) {
		case "running":
			return "warning";
		case "completed":
			return "success";
		case "failed":
		case "timed_out":
		case "aborted":
			return "error";
		case "unknown":
			return "dim";
	}
}

function runningHeader(kind: CodexToolPresentationKind, args: unknown): HeaderModel {
	if (kind === "command") {
		return commandHeader("running", args, {});
	}
	return { state: "running", title: runningTitle(kind, args) };
}

function terminalHeader(
	kind: CodexToolPresentationKind,
	args: unknown,
	details: NativeToolPresentationDetails,
	state: TerminalState,
): HeaderModel {
	if (kind === "command") {
		return commandHeader(state, args, details);
	}
	return { state, title: terminalTitle(kind, args, details, state) };
}

function runningTitle(kind: CodexToolPresentationKind, args: unknown): string {
	switch (kind) {
		case "command":
			return commandHeader("running", args, {}).title;
		case "session-input":
			return sessionRunningTitle(args);
		case "patch":
			return "Applying patch";
		case "view-image":
			return withSummary("Viewing", pathSummary(args));
		case "image-generation":
			return "Generating image";
		case "web":
			return withOptionalSummary("Searching web", webSummary(args));
		case "plan":
			return "Updating plan";
	}
}

function terminalTitle(
	kind: CodexToolPresentationKind,
	args: unknown,
	details: NativeToolPresentationDetails,
	state: TerminalState,
): string {
	switch (kind) {
		case "command":
			return commandHeader(state, args, details).title;
		case "session-input":
			return sessionTerminalTitle(args, details, state);
		case "patch":
			return state === "completed"
				? "Updated files"
				: state === "unknown"
					? "Patch finished"
					: genericFailureTitle("Patch", state);
		case "view-image":
			return viewImageTerminalTitle(args, details, state);
		case "image-generation":
			return state === "completed"
				? "Generated image"
				: state === "unknown"
					? "Image generation finished"
					: genericFailureTitle("Image generation", state);
		case "web":
			return webTerminalTitle(args, state);
		case "plan":
			return state === "completed"
				? "Updated plan"
				: state === "unknown"
					? "Plan finished"
					: genericFailureTitle("Plan", state);
		default: {
			const _exhaustive: never = kind;
			return String(_exhaustive);
		}
	}
}

/**
 * Build a command header that keeps action words and exit/duration suffixes intact while
 * clipping only the command body. Presentation-only: never executes shell text.
 */
function commandHeader(
	state: TerminalState,
	args: unknown,
	details: Pick<NativeToolPresentationDetails, "wall_time_seconds" | "exit_code" | "exitCode">,
): HeaderModel {
	const exit = exitCodeOf(details);
	const duration = formatDuration(details.wall_time_seconds);
	let action: string;
	let suffix = "";
	if (state === "running") {
		action = "Running";
	} else if (state === "timed_out") {
		action = "Command timed out";
	} else if (state === "aborted") {
		action = "Command aborted";
	} else if (state === "failed") {
		action = "Command failed";
		if (exit !== undefined) suffix = ` (exit ${exit})`;
	} else if (state === "unknown") {
		action = "Command finished";
	} else {
		action = "Ran";
		if (duration !== undefined) suffix = ` (${duration})`;
	}
	const reserved = action.length + (suffix.length > 0 ? suffix.length + 1 : 1);
	const bodyBudget = Math.max(12, DEFAULT_SUMMARY_LIMIT + 24 - Math.min(reserved, 48));
	const summary = commandSummary(args, bodyBudget);
	return {
		state: state === "running" ? "running" : state,
		title: `${action} ${summary}${suffix}`,
		action,
		summary,
		suffix,
	};
}

/** Clip header text; for structured command headers, preserve action + suffix. */
function formatHeaderTitle(header: HeaderModel, titleBudget: number): string {
	const action = header.action;
	const summary = header.summary;
	if (action === undefined || summary === undefined) {
		return truncatePlain(header.title, titleBudget);
	}
	const suffix = header.suffix ?? "";
	const prefix = `${action} `;
	const fixed = visibleWidth(prefix) + visibleWidth(suffix);
	if (fixed >= titleBudget) {
		// Extreme narrow width: keep the action/state words first.
		return truncatePlain(`${action}${suffix}`, titleBudget);
	}
	const bodyBudget = Math.max(1, titleBudget - fixed);
	const body = truncatePlain(summary, bodyBudget);
	return `${prefix}${body}${suffix}`;
}

/**
 * Plain-text column truncation for titles we fully re-style afterward.
 * Avoids pi-tui truncateToWidth ANSI resets that would break outer theme colors.
 */
function truncatePlain(text: string, maxCols: number): string {
	if (maxCols <= 0) return "";
	if (visibleWidth(text) <= maxCols) return text;
	const ellipsis = "...";
	if (maxCols <= ellipsis.length) return ellipsis.slice(0, maxCols);
	// Commands are overwhelmingly printable ASCII; slice by code units is enough.
	if (/^[\x20-\x7e]*$/.test(text)) {
		return `${text.slice(0, maxCols - ellipsis.length)}${ellipsis}`;
	}
	// Non-ASCII: use width-aware truncation, then drop any helper ANSI sequences.
	return stripAnsi(truncateToWidth(text, maxCols, ellipsis));
}

function stripAnsi(value: string): string {
	// ESC is built at runtime so the source regex stays free of control characters.
	const csi = new RegExp(`${String.fromCharCode(27)}[[0-9;]*m`, "g");
	return value.replace(csi, "");
}

function sessionRunningTitle(args: unknown): string {
	const label = sessionLabel(sessionIdOf(args));
	if (hasNonEmptyChars(args)) return `Sending input to ${label}`;
	return `Waiting for ${label}`;
}

function sessionTerminalTitle(
	args: unknown,
	details: NativeToolPresentationDetails,
	state: TerminalState,
): string {
	const label = sessionLabel(sessionIdOf(args) ?? details.session_id);
	if (state === "timed_out") {
		return hasNonEmptyChars(args)
			? `Sending input to ${label} timed out`
			: `Waiting for ${label} timed out`;
	}
	if (state === "aborted") {
		return hasNonEmptyChars(args)
			? `Sending input to ${label} aborted`
			: `Waiting for ${label} aborted`;
	}
	if (state === "failed") {
		return hasNonEmptyChars(args)
			? `Sending input to ${label} failed`
			: `Waiting for ${label} failed`;
	}
	if (state === "unknown") {
		return hasNonEmptyChars(args)
			? `Background session input finished for ${label}`
			: `Background session wait finished for ${label}`;
	}
	if (hasNonEmptyChars(args)) return `Sent input to ${label}`;
	return `Waited for ${label}`;
}

function sessionLabel(session: number | undefined): string {
	return session === undefined ? "background session" : `background session ${session}`;
}

function viewImageTerminalTitle(
	args: unknown,
	details: NativeToolPresentationDetails,
	state: TerminalState,
): string {
	const path = pathSummary(args);
	if (state === "failed" || state === "aborted" || state === "timed_out") {
		return genericFailureTitle(withSummary("View image", path), state);
	}
	if (state === "unknown") return withSummary("View image finished", path);
	const detail =
		typeof details.detail === "string" && details.detail.length > 0 ? details.detail : undefined;
	const base = withSummary("Viewed", path);
	return detail === undefined ? base : `${base} (${detail})`;
}

function webTerminalTitle(args: unknown, state: TerminalState): string {
	const summary = webSummary(args);
	if (state === "failed" || state === "aborted" || state === "timed_out") {
		return genericFailureTitle(withOptionalSummary("Search web", summary), state);
	}
	if (state === "unknown") return withOptionalSummary("Web search finished", summary);
	return withOptionalSummary("Searched web", summary);
}

function genericFailureTitle(base: string, state: TerminalState): string {
	if (state === "timed_out") return `${base} timed out`;
	if (state === "aborted") return `${base} aborted`;
	return `${base} failed`;
}

function safeFallbackTitle(
	kind: CodexToolPresentationKind,
	running: boolean,
	failed = false,
): string {
	const labels: Record<CodexToolPresentationKind, [string, string, string]> = {
		command: ["Running command", "Command finished", "Command failed"],
		"session-input": [
			"Waiting for background session",
			"Background session finished",
			"Background session failed",
		],
		patch: ["Applying patch", "Patch finished", "Patch failed"],
		"view-image": ["Viewing image", "View image finished", "View image failed"],
		"image-generation": [
			"Generating image",
			"Image generation finished",
			"Image generation failed",
		],
		web: ["Searching web", "Web search finished", "Web search failed"],
		plan: ["Updating plan", "Plan finished", "Plan failed"],
	};
	const [run, done, fail] = labels[kind];
	if (running) return run;
	return failed ? fail : done;
}

function partialDetailRows(
	kind: CodexToolPresentationKind,
	result: ResultLike,
	options: ResultOptions,
	args: unknown,
): DetailRow[] {
	if (kind === "command" || kind === "session-input") {
		return formatOutputRows(textContent(result) ?? "", options.expanded);
	}
	if (kind === "plan") {
		return planRows(args, result);
	}
	return [];
}

function terminalDetailRows(
	kind: CodexToolPresentationKind,
	result: ResultLike,
	options: ResultOptions,
	args: unknown,
	details: NativeToolPresentationDetails,
): DetailRow[] {
	switch (kind) {
		case "command":
			return commandDetailRows(result, options, details);
		case "session-input":
			return sessionDetailRows(result, options, args, details);
		case "patch":
			return patchRows(details);
		case "view-image":
		case "image-generation":
			return [];
		case "web":
			return [];
		case "plan":
			return planRows(args, result);
		default: {
			const _exhaustive: never = kind;
			return [{ text: String(_exhaustive), kind: "muted" }];
		}
	}
}

function commandDetailRows(
	result: ResultLike,
	options: ResultOptions,
	details: NativeToolPresentationDetails,
): DetailRow[] {
	if (typeof details.output === "string") {
		if (details.output.length === 0) return [{ text: "(no output)", kind: "muted" }];
		return formatOutputRows(details.output, options.expanded);
	}
	const fallback = textContent(result);
	if (fallback === undefined || fallback.length === 0) {
		return [{ text: "(no output)", kind: "muted" }];
	}
	if (looksLikeMetadataOnly(fallback)) {
		return [{ text: "(no output)", kind: "muted" }];
	}
	return formatOutputRows(stripTrailingMetadata(fallback), options.expanded);
}

function sessionDetailRows(
	result: ResultLike,
	options: ResultOptions,
	args: unknown,
	details: NativeToolPresentationDetails,
): DetailRow[] {
	const displayOutput =
		typeof details.output === "string"
			? details.output
			: stripTrailingMetadata(textContent(result) ?? "");
	const rows: DetailRow[] = [];
	if (options.expanded && hasNonEmptyChars(args)) {
		rows.push({
			text: `Input: ${escapeForDisplay(charsOf(args) ?? "", INPUT_PREVIEW_LIMIT)}`,
			kind: "output",
		});
	}
	if (displayOutput.length > 0) {
		const logical = splitLogicalLines(displayOutput);
		const limited = options.expanded
			? { lines: logical, omitted: 0 }
			: collapseLines(logical, COLLAPSED_OUTPUT_LINES);
		for (const line of limited.lines) {
			rows.push({ text: line, kind: "output" });
		}
		if (limited.omitted > 0) {
			rows.push({ text: `... ${limited.omitted} lines omitted`, kind: "muted" });
		}
	}
	return rows;
}

function patchRows(details: NativeToolPresentationDetails): DetailRow[] {
	const rows: DetailRow[] = [];
	for (const path of stringArray(details.added)) {
		rows.push({ text: `Added ${clipSummary(path, DEFAULT_SUMMARY_LIMIT)}`, kind: "output" });
	}
	for (const path of stringArray(details.modified)) {
		rows.push({ text: `Modified ${clipSummary(path, DEFAULT_SUMMARY_LIMIT)}`, kind: "output" });
	}
	for (const path of stringArray(details.deleted)) {
		rows.push({ text: `Deleted ${clipSummary(path, DEFAULT_SUMMARY_LIMIT)}`, kind: "output" });
	}
	return rows;
}

function planRows(args: unknown, result: ResultLike): DetailRow[] {
	const source = planItems(args) ?? planItems(result.details);
	if (source === undefined || source.length === 0) return [];
	return source.map((item) => {
		const marker =
			item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
		return {
			text: `${marker} ${clipSummary(item.step, DEFAULT_SUMMARY_LIMIT)}`,
			kind: "output" as const,
		};
	});
}

function formatOutputRows(output: string, expanded: boolean): DetailRow[] {
	const logical = splitLogicalLines(output);
	if (logical.length === 0) return [{ text: "(no output)", kind: "muted" }];
	if (expanded) {
		return logical.map((line) => ({ text: line, kind: "output" as const }));
	}
	const collapsed = collapseLines(logical, COLLAPSED_OUTPUT_LINES);
	const rows: DetailRow[] = collapsed.lines.map((line) => ({ text: line, kind: "output" }));
	if (collapsed.omitted > 0) {
		rows.push({ text: `... ${collapsed.omitted} lines omitted`, kind: "muted" });
	}
	return rows;
}

function resolveTerminalState(
	details: NativeToolPresentationDetails,
	result: ResultLike,
	isError: boolean,
): TerminalState {
	if (isError) {
		const status = typeof details.status === "string" ? details.status : undefined;
		if (status === "timed_out" || status === "timeout") return "timed_out";
		if (status === "aborted" || status === "cancelled" || status === "canceled") return "aborted";
		return "failed";
	}
	const status = typeof details.status === "string" ? details.status : undefined;
	if (status === "running") return "running";
	if (status === "timed_out" || status === "timeout") return "timed_out";
	if (status === "aborted" || status === "cancelled" || status === "canceled") return "aborted";
	if (status === "failed" || status === "incomplete") return "failed";
	if (status === "completed") {
		const exit = exitCodeOf(details);
		if (exit !== undefined && exit !== 0) return "failed";
		return "completed";
	}
	const exit = exitCodeOf(details);
	if (exit !== undefined && exit !== 0) return "failed";
	if (exit === 0) return "completed";
	if (result.content.some((item) => item.type === "image")) return "completed";
	// Plan tool details are the plan payload itself and do not carry a native status field.
	if (planItems(result.details) !== undefined) return "completed";
	// Missing/legacy status without an error flag is neutral, never success-colored.
	return "unknown";
}

function presentDetails(value: unknown): NativeToolPresentationDetails {
	const root = record(value);
	if (root === undefined) return {};
	const details: NativeToolPresentationDetails = {};
	if (typeof root.status === "string") details.status = root.status;
	if (typeof root.output === "string") details.output = root.output;
	if (typeof root.exit_code === "number" && Number.isFinite(root.exit_code)) {
		details.exit_code = root.exit_code;
	}
	if (typeof root.exitCode === "number" && Number.isFinite(root.exitCode)) {
		details.exitCode = root.exitCode;
	}
	if (typeof root.wall_time_seconds === "number" && Number.isFinite(root.wall_time_seconds)) {
		details.wall_time_seconds = root.wall_time_seconds;
	}
	if (typeof root.session_id === "number" && Number.isFinite(root.session_id)) {
		details.session_id = root.session_id;
	}
	if (typeof root.original_token_count === "number" && Number.isFinite(root.original_token_count)) {
		details.original_token_count = root.original_token_count;
	}
	if (typeof root.detail === "string") details.detail = root.detail;
	const added = stringArray(root.added);
	if (added.length > 0) details.added = added;
	const modified = stringArray(root.modified);
	if (modified.length > 0) details.modified = modified;
	const deleted = stringArray(root.deleted);
	if (deleted.length > 0) details.deleted = deleted;
	return details;
}

function exitCodeOf(details: NativeToolPresentationDetails): number | undefined {
	if (typeof details.exit_code === "number" && Number.isFinite(details.exit_code)) {
		return details.exit_code;
	}
	if (typeof details.exitCode === "number" && Number.isFinite(details.exitCode)) {
		return details.exitCode;
	}
	return undefined;
}

function commandSummary(args: unknown, limit = DEFAULT_SUMMARY_LIMIT): string {
	const raw = rawCommandFromArgs(args);
	if (raw === undefined) return "command";
	return clipSummary(presentCommandText(raw), limit);
}

function rawCommandFromArgs(args: unknown): string | undefined {
	const value = record(args);
	if (typeof value?.cmd === "string" && value.cmd.length > 0) return value.cmd;
	if (typeof value?.command === "string" && value.command.length > 0) return value.command;
	return undefined;
}

/**
 * Presentation-only command cleanup for titles.
 * Collapses whitespace and unwraps limited `sh`/`bash -c` wrappers at most twice.
 * Does not execute commands or parse full shell grammar.
 */
function presentCommandText(command: string): string {
	let current = collapseWs(command);
	for (let depth = 0; depth < 2; depth += 1) {
		const unwrapped = unwrapShellDashC(current);
		if (unwrapped === undefined) break;
		const next = collapseWs(unwrapped);
		if (next === current) break;
		current = next;
	}
	return current;
}

/**
 * Unwrap a leading `sh -c` / `bash -lc` style wrapper when the form is simple.
 * Returns undefined when the text is not a recognized single wrapper.
 */
function unwrapShellDashC(command: string): string | undefined {
	const tokens = tokenizeShellPresentation(command);
	if (tokens.length < 3) return undefined;
	const shell = tokens[0];
	if (shell === undefined || !isShOrBashToken(shell)) return undefined;

	let cIndex = -1;
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) return undefined;
		if (token === "-c" || isShortFlagTokenWithC(token)) {
			cIndex = index;
			break;
		}
		// Only short ASCII flags may appear before -c.
		if (!/^-[a-zA-Z]+$/.test(token)) return undefined;
	}
	if (cIndex < 0 || cIndex + 1 >= tokens.length) return undefined;
	const payload = tokens
		.slice(cIndex + 1)
		.join(" ")
		.trim();
	return payload.length > 0 ? payload : undefined;
}

function isShOrBashToken(token: string): boolean {
	// Accept sh/bash with an optional absolute or relative path prefix.
	// Avoid "/*" inside the regex literal (it would start a block comment).
	return /^(?:(?:\/+|\.\/)?(?:(?:usr\/)?bin\/)?)?(?:ba)?sh$/.test(token);
}

function isShortFlagTokenWithC(token: string): boolean {
	// bash -lc / bash -cl combine login and -c into one token.
	return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token) && token.includes("c");
}

/**
 * Lightweight presentation tokenizer: splits on whitespace and treats simple
 * single/double quotes as one token (content only). Not a shell parser.
 */
function tokenizeShellPresentation(input: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	const text = input.trim();
	while (index < text.length) {
		while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
		if (index >= text.length) break;
		const ch = text[index];
		if (ch === "'" || ch === '"') {
			const quote = ch;
			index += 1;
			let body = "";
			while (index < text.length && text[index] !== quote) {
				if (quote === '"' && text[index] === "\\" && index + 1 < text.length) {
					body += text[index + 1] ?? "";
					index += 2;
					continue;
				}
				body += text[index] ?? "";
				index += 1;
			}
			if (index < text.length && text[index] === quote) index += 1;
			tokens.push(body);
			continue;
		}
		let body = "";
		while (index < text.length && !/\s/.test(text[index] ?? "")) {
			body += text[index] ?? "";
			index += 1;
		}
		tokens.push(body);
	}
	return tokens;
}

function collapseWs(value: string): string {
	return value.replaceAll(/\s+/g, " ").trim();
}

function pathSummary(args: unknown): string {
	const value = record(args);
	if (typeof value?.path === "string" && value.path.length > 0) {
		return clipSummary(value.path, DEFAULT_SUMMARY_LIMIT);
	}
	return "image";
}

function webSummary(args: unknown): string | undefined {
	const value = record(args);
	if (value === undefined) return undefined;
	const search = firstQuery(value.search_query);
	if (search !== undefined) return clipSummary(search, WEB_QUERY_LIMIT);
	const image = firstQuery(value.image_query);
	if (image !== undefined) return clipSummary(image, WEB_QUERY_LIMIT);
	const weather = firstNamed(value.weather, "location");
	if (weather !== undefined) return clipSummary(weather, WEB_QUERY_LIMIT);
	const finance = firstNamed(value.finance, "ticker");
	if (finance !== undefined) return clipSummary(finance, WEB_QUERY_LIMIT);
	const find = firstNamed(value.find, "pattern");
	if (find !== undefined) return clipSummary(find, WEB_QUERY_LIMIT);
	const open = firstNamed(value.open, "ref_id");
	if (open !== undefined) return clipSummary(open, WEB_QUERY_LIMIT);
	return undefined;
}

function firstQuery(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const entry of value) {
		const item = record(entry);
		if (typeof item?.q === "string" && item.q.trim().length > 0) return item.q.trim();
	}
	return undefined;
}

function firstNamed(value: unknown, key: string): string | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const entry of value) {
		const item = record(entry);
		const field = item?.[key];
		if (typeof field === "string" && field.trim().length > 0) return field.trim();
	}
	return undefined;
}

function sessionIdOf(args: unknown): number | undefined {
	const value = record(args);
	const id = value?.session_id;
	return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

function charsOf(args: unknown): string | undefined {
	const value = record(args);
	return typeof value?.chars === "string" ? value.chars : undefined;
}

function hasNonEmptyChars(args: unknown): boolean {
	const chars = charsOf(args);
	return chars !== undefined && chars.length > 0;
}

function planItems(value: unknown): Array<{ step: string; status: string }> | undefined {
	const root = record(value);
	const plan = root?.plan;
	if (!Array.isArray(plan)) return undefined;
	const items: Array<{ step: string; status: string }> = [];
	for (const entry of plan) {
		const item = record(entry);
		if (typeof item?.step !== "string") continue;
		const status = typeof item.status === "string" ? item.status : "pending";
		items.push({ step: item.step, status });
	}
	return items.length > 0 ? items : undefined;
}

function withSummary(action: string, summary: string): string {
	return `${action} ${summary}`;
}

function withOptionalSummary(action: string, summary: string | undefined): string {
	return summary === undefined || summary.length === 0 ? action : `${action} for ${summary}`;
}

function formatDuration(seconds: number | undefined): string | undefined {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
	if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = Math.round(seconds % 60);
	return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

function clipSummary(value: string, limit: number): string {
	const normalized = value.replaceAll(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function splitLogicalLines(value: string): string[] {
	if (value.length === 0) return [];
	const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function collapseLines(lines: string[], max: number): { lines: string[]; omitted: number } {
	if (lines.length <= max) return { lines, omitted: 0 };
	return { lines: lines.slice(0, max), omitted: lines.length - max };
}

function escapeForDisplay(value: string, limit: number): string {
	let escaped = "";
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (char === "\\") escaped += "\\\\";
		else if (char === "\n") escaped += "\\n";
		else if (char === "\r") escaped += "\\r";
		else if (char === "\t") escaped += "\\t";
		else if (code < 0x20 || code === 0x7f) {
			escaped += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			escaped += char;
		}
		if (escaped.length >= limit) {
			return `${escaped.slice(0, Math.max(0, limit - 3))}...`;
		}
	}
	return escaped;
}

function textContent(result: ResultLike): string | undefined {
	const content = result.content.find((item) => item.type === "text");
	return typeof content?.text === "string" ? content.text : undefined;
}

function looksLikeMetadataOnly(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const root = record(parsed);
		return root !== undefined && typeof root.status === "string";
	} catch {
		return false;
	}
}

function stripTrailingMetadata(text: string): string {
	const lines = splitLogicalLines(text);
	if (lines.length === 0) return text;
	const last = lines[lines.length - 1];
	if (last !== undefined && looksLikeMetadataOnly(last)) {
		return lines.slice(0, -1).join("\n");
	}
	return text;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.length > 0) items.push(entry);
	}
	return items;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

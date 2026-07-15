/** Terminal rendering helpers for monochrome-safe settings layouts. */

export interface TerminalRenderEnvironment {
	readonly NO_COLOR?: string | undefined;
	readonly TERM?: string | undefined;
	readonly FORCE_COLOR?: string | undefined;
}

const ESC = "\u001b";
const BEL = "\u0007";
const ANSI_PATTERN = new RegExp(
	`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
	"g",
);

/** Detect terminals that must stay plain text without ANSI styling. */
export function isMonochromeEnvironment(
	env: TerminalRenderEnvironment | NodeJS.ProcessEnv = process.env,
): boolean {
	const forceColor = env.FORCE_COLOR;
	if (forceColor !== undefined && forceColor !== "" && forceColor !== "0") {
		return false;
	}
	const noColor = env.NO_COLOR;
	if (noColor !== undefined && noColor !== "") return true;
	const term = (env.TERM ?? "").toLowerCase();
	return term === "dumb" || term === "" || term === "unknown";
}

/** Visible width for ASCII-first settings text. */
export function visibleWidth(value: string): number {
	return stripAnsi(value).length;
}

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export function fitLine(value: string, width: number): string {
	if (width <= 0) return "";
	const plain = stripAnsi(value);
	if (plain.length <= width) return plain;
	if (width <= 3) return plain.slice(0, width);
	return `${plain.slice(0, width - 3)}...`;
}

export function wrapText(value: string, width: number): string[] {
	if (width <= 0) return [];
	const plain = stripAnsi(value).trim();
	if (plain.length === 0) return [];
	const words = plain.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (word.length > width) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			for (let index = 0; index < word.length; index += width) {
				lines.push(word.slice(index, index + width));
			}
			continue;
		}
		const next = current.length === 0 ? word : `${current} ${word}`;
		if (next.length > width) {
			lines.push(current);
			current = word;
		} else {
			current = next;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

export function padEndVisible(value: string, width: number): string {
	const plain = fitLine(value, width);
	return plain.length >= width ? plain : `${plain}${" ".repeat(width - plain.length)}`;
}

export function statusLabel(kind: "ok" | "warn" | "error" | "dirty" | "info" | "disabled"): string {
	switch (kind) {
		case "ok":
			return "[ok]";
		case "warn":
			return "[warn]";
		case "error":
			return "[error]";
		case "dirty":
			return "[modified]";
		case "disabled":
			return "[disabled]";
		case "info":
			return "[info]";
	}
}

export function joinFooter(actions: readonly string[], width: number): string {
	if (actions.length === 0) return "";
	const separator = "  ";
	let line = actions[0] ?? "";
	for (let index = 1; index < actions.length; index += 1) {
		const next = `${line}${separator}${actions[index]}`;
		if (next.length > width) break;
		line = next;
	}
	return fitLine(line, width);
}

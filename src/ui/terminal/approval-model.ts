/**
 * Safe default approval view model for UI-owned confirmation surfaces.
 * Decline/cancel remain the focused defaults; allow is never preselected.
 */

import { fitLine, wrapText } from "./render.ts";

export type ApprovalDecision = "allow_once" | "decline" | "cancel";
export type ApprovalOperation = "command" | "patch" | "filesystem" | "network" | string;

export interface ApprovalRequestView {
	readonly operation: ApprovalOperation;
	readonly summary: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface ApprovalOption {
	readonly id: ApprovalDecision;
	readonly label: string;
}

export interface ApprovalModelOptions {
	readonly cwd?: string;
}

export class ApprovalModel {
	readonly #request: ApprovalRequestView;
	readonly #cwd: string;
	#focus = 0;
	#resolved: ApprovalDecision | undefined;

	constructor(request: ApprovalRequestView, options: ApprovalModelOptions = {}) {
		this.#request = request;
		this.#cwd = options.cwd ?? ".";
	}

	get title(): string {
		switch (this.#request.operation) {
			case "command":
				return this.sessionId === undefined ? "Approve native command" : "Approve session write";
			case "patch":
				return "Approve workspace patch";
			case "network":
				return "Approve network access";
			case "filesystem":
				return "Approve file access";
			default:
				return "Approve operation";
		}
	}

	/** Session identifier for write_stdin approvals, when present. */
	get sessionId(): string | undefined {
		const details = this.#request.details ?? {};
		return typeof details.sessionId === "string" && details.sessionId.length > 0
			? details.sessionId
			: undefined;
	}

	/** Bounded inspectable stdin preview for session write approvals. */
	get inputPreview(): string | undefined {
		const details = this.#request.details ?? {};
		return typeof details.inputPreview === "string" && details.inputPreview.length > 0
			? details.inputPreview
			: undefined;
	}

	get summary(): string {
		return this.#request.summary;
	}

	get target(): string {
		const details = this.#request.details ?? {};
		if (this.sessionId !== undefined) return `session ${this.sessionId}`;
		if (typeof details.workdir === "string" && details.workdir.length > 0) return details.workdir;
		if (typeof details.path === "string" && details.path.length > 0) return details.path;
		if (Array.isArray(details.paths)) {
			const paths = details.paths.filter((path): path is string => typeof path === "string");
			if (paths.length > 0) return paths.join(", ");
		}
		return this.#cwd;
	}

	/** Safe order: decline, cancel, then allow. Focus starts on decline. */
	options(): readonly ApprovalOption[] {
		return [
			{ id: "decline", label: "Decline" },
			{ id: "cancel", label: "Cancel tool call" },
			{ id: "allow_once", label: `Allow once: ${this.#request.summary}` },
		];
	}

	get focus(): number {
		return this.#focus;
	}

	get focusedOption(): ApprovalOption {
		const options = this.options();
		return options[this.#focus] ?? options[0] ?? { id: "decline", label: "Decline" };
	}

	get decision(): ApprovalDecision | undefined {
		return this.#resolved;
	}

	get defaultDecision(): ApprovalDecision {
		return "decline";
	}

	moveFocus(delta: -1 | 1): void {
		if (this.#resolved !== undefined) return;
		const count = this.options().length;
		this.#focus = Math.max(0, Math.min(count - 1, this.#focus + delta));
	}

	selectFocused(): ApprovalDecision {
		const decision = this.focusedOption.id;
		this.#resolved = decision;
		return decision;
	}

	cancel(): ApprovalDecision {
		this.#resolved = "cancel";
		return "cancel";
	}

	/** Escape and unanswered prompts resolve to cancel, never allow. */
	dismiss(): ApprovalDecision {
		return this.cancel();
	}

	lines(width: number): string[] {
		const lines = [
			fitLine(this.title, width),
			fitLine(`Target: ${this.target}`, width),
			"",
			...wrapText(this.summary, width),
		];
		const preview = this.inputPreview;
		if (preview !== undefined && preview !== this.summary) {
			lines.push("", fitLine("Input preview:", width), ...wrapText(preview, width));
		}
		lines.push("");
		for (const [index, option] of this.options().entries()) {
			const prefix = index === this.#focus ? ">" : " ";
			lines.push(fitLine(`${prefix} ${option.label}`, width));
		}
		lines.push("", fitLine("Up/Down move  Enter select  Esc cancel", width));
		return lines;
	}
}

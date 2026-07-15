/**
 * Pi approval binding that prefers the Decline-first ApprovalModel overlay in TUI mode.
 * Headless contexts decline immediately. Non-TUI dialog UIs fall back to select().
 * Request AbortSignal disposes the overlay fail-closed and never leaves the caller hanging.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import type {
	CodexApprovalDecision,
	CodexApprovalRequest,
} from "../../application/codex-runtime.ts";
import { type ApprovalDecision, ApprovalModel } from "./approval-model.ts";

export async function requestCodexApproval(
	ctx: ExtensionContext,
	approval: CodexApprovalRequest,
	signal?: AbortSignal,
): Promise<Exclude<CodexApprovalDecision, "allow_session">> {
	if (isSignalAborted(signal)) return "cancel";
	if (!ctx.hasUI) return "decline";

	const details = record(approval.details);
	const model = new ApprovalModel(
		{
			operation: approval.operation,
			summary: approval.summary,
			...(details === undefined ? {} : { details }),
		},
		{ cwd: ctx.cwd },
	);

	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		let overlay: ApprovalOverlay | undefined;
		const decisionPromise = ctx.ui.custom<ApprovalDecision>(
			(_tui, _theme, _keybindings, done) => {
				overlay = new ApprovalOverlay(model, done);
				return overlay;
			},
			{ overlay: true },
		);
		const decision = await raceApprovalDecision(decisionPromise, signal, () => {
			overlay?.dispose();
		});
		return finalizeDecision(ctx, model, decision ?? "cancel");
	}

	// Pi has no session-scoped approval policy surface, so only once/decline/cancel are offered.
	const selectedPromise = ctx.ui.select(
		model.title,
		model.options().map((option) => option.label),
	);
	const selected = await raceApprovalDecision(selectedPromise, signal);
	if (selected === undefined) return finalizeDecision(ctx, model, "cancel");
	if (isSignalAborted(signal)) return finalizeDecision(ctx, model, "cancel");
	const matched = model.options().find((option) => option.label === selected);
	return finalizeDecision(ctx, model, matched?.id ?? "cancel");
}

async function raceApprovalDecision<T>(
	decisionPromise: Promise<T>,
	signal: AbortSignal | undefined,
	onAbort?: () => void,
): Promise<T | undefined> {
	if (signal === undefined) {
		return decisionPromise;
	}
	if (signal.aborted) {
		onAbort?.();
		return undefined;
	}
	return await new Promise<T | undefined>((resolve, reject) => {
		const abort = () => {
			onAbort?.();
			resolve(undefined);
		};
		signal.addEventListener("abort", abort, { once: true });
		decisionPromise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
	return Boolean(signal?.aborted);
}

function finalizeDecision(
	ctx: ExtensionContext,
	model: ApprovalModel,
	decision: ApprovalDecision,
): ApprovalDecision {
	if (decision === "allow_once") {
		ctx.ui.notify(`Approved: ${model.target}`, "info");
	}
	return decision;
}

class ApprovalOverlay {
	focused = true;
	readonly #model: ApprovalModel;
	readonly #done: (result: ApprovalDecision) => void;
	#disposed = false;

	constructor(model: ApprovalModel, done: (result: ApprovalDecision) => void) {
		this.#model = model;
		this.#done = done;
	}

	render(width: number): string[] {
		return this.#model.lines(width);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (matchesKey(data, "escape")) {
			this.#finish(this.#model.dismiss());
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.#model.moveFocus(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#model.moveFocus(1);
			return;
		}
		if (matchesKey(data, "return")) {
			this.#finish(this.#model.selectFocused());
		}
	}

	invalidate(): void {}

	/**
	 * Fail closed exactly once on teardown. Races with handleInput resolve to a
	 * single cancel/decline decision and never leave the caller hanging.
	 */
	dispose(): void {
		if (this.#disposed) return;
		this.#finish(this.#model.dismiss());
	}

	#finish(decision: ApprovalDecision): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#done(decision);
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

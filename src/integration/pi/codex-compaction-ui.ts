import type {
	CustomEntry,
	EntryRenderer,
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionContext,
	SessionEntryNavigation,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

import { CODEX_REMOTE_COMPACTION_KIND } from "../../application/compaction.ts";

/** One stable status slot for all Codex remote-compaction UI. */
export const CODEX_REMOTE_COMPACTION_STATUS_KEY = "codex-adaptor.remote-compaction";

/** The fixed label used by the adaptor-owned checkpoint projection. */
export const CODEX_REMOTE_COMPACTION_LABEL = "Codex checkpoint";

export type CodexInlineCompactionPhase = "threshold" | "recompact";

/** Keep the phase wording in one place so threshold and re-compaction cannot drift. */
export const CODEX_INLINE_COMPACTION_PHASE_LABELS: Readonly<
	Record<CodexInlineCompactionPhase, string>
> = {
	threshold: "Codex compaction",
	recompact: "Codex re-compaction",
};

export type CodexInlineCompactionOutcome = "error" | "cancel" | "indeterminate";
export type CodexCompactionCompletionTrigger =
	| "provider_inline"
	| "manual"
	| "threshold"
	| "overflow";

type StatusUI = {
	readonly setStatus?: (key: string, text: string | undefined) => void;
	readonly notify?: (message: string, type?: "info" | "warning" | "error") => void;
};

type ThemeLike = Pick<Theme, "fg">;

type EntryRendererRegistration = {
	readonly registerEntryRenderer?: (customType: string, renderer: EntryRenderer<unknown>) => void;
};

const MAX_FORMATTED_TOKEN_COUNT_LENGTH = 24;

/**
 * Start the adaptor-owned inline status.
 *
 * This function intentionally only updates optional UI methods. The caller must invoke it after
 * deciding that a new remote request is eligible; checkpoint replay should not call it.
 */
export function beginInline(ctx: ExtensionContext, phase: CodexInlineCompactionPhase): void {
	setStatus(ctx, `${CODEX_INLINE_COMPACTION_PHASE_LABELS[phase]}: creating checkpoint`);
}

/** Clear an in-progress inline status without producing completion feedback. */
export function clearInline(ctx: ExtensionContext): void {
	clearStatus(ctx);
}

/**
 * Finish a checkpoint transaction.
 *
 * The Pi-native manual and overflow paths own their completion UI, so only an inline provider
 * transaction emits the adaptor notification. The transaction event, rather than the remote
 * response, is the completion boundary for this operation.
 */
export function completeInline(
	ctx: ExtensionContext,
	tokensBefore: number,
	trigger: CodexCompactionCompletionTrigger = "provider_inline",
): void {
	clearStatus(ctx);
	if (trigger !== "provider_inline") return;

	const tokenCount = formatTokenCount(tokensBefore);
	notify(
		ctx,
		tokenCount === undefined
			? `${CODEX_REMOTE_COMPACTION_LABEL} saved`
			: `${CODEX_REMOTE_COMPACTION_LABEL} saved (${tokenCount} tokens before compaction)`,
		"info",
	);
}

/**
 * Finish an inline transaction that did not produce a verified success.
 *
 * Failure text is deliberately outcome-only. Remote errors, checkpoint data, and provider payloads
 * do not cross into the UI boundary.
 */
export function failInline(ctx: ExtensionContext, outcome: CodexInlineCompactionOutcome): void {
	failInlineForTrigger(ctx, outcome);
}

/**
 * Finish a checkpoint transaction for a particular compaction trigger.
 *
 * Native manual, threshold, and overflow paths keep ownership of their feedback in Pi. The
 * trigger is accepted here so transaction events can always clear a stale adaptor status without
 * producing a duplicate notification for those native paths.
 */
export function failInlineForTrigger(
	ctx: ExtensionContext,
	outcome: CodexInlineCompactionOutcome,
	trigger: CodexCompactionCompletionTrigger = "provider_inline",
): void {
	clearStatus(ctx);
	if (trigger !== "provider_inline") return;

	switch (outcome) {
		case "cancel":
			notify(ctx, "Codex compaction cancelled", "warning");
			return;
		case "error":
			notify(ctx, "Codex checkpoint failed", "error");
			return;
		case "indeterminate":
			notify(ctx, "Codex checkpoint outcome could not be verified", "warning");
			return;
	}
}

/**
 * Register the safe projection for the existing opaque checkpoint entry.
 *
 * Older/headless hosts may not expose entry-renderer registration. Registration is an optional
 * presentation affordance and is therefore never allowed to affect checkpoint persistence.
 */
export function registerEntryRenderer(pi: ExtensionAPI): void {
	const host = pi as ExtensionAPI & EntryRendererRegistration;
	if (typeof host.registerEntryRenderer !== "function") return;
	try {
		host.registerEntryRenderer(CODEX_REMOTE_COMPACTION_KIND, renderRemoteCompactionEntry);
	} catch {
		// Renderer support is optional; provider and checkpoint paths remain authoritative.
	}
}

/**
 * Render only host-owned navigation metadata for a Codex checkpoint.
 *
 * `entry.data` is intentionally never read. The data contains opaque provider output and remains
 * context-invisible even when the entry is reconstructed or selected in the session tree.
 */
export const renderRemoteCompactionEntry: EntryRenderer<unknown> = (
	entry: CustomEntry<unknown>,
	_options: EntryRenderOptions,
	theme: ThemeLike,
): Component | undefined => {
	if (entry.customType !== CODEX_REMOTE_COMPACTION_KIND) return undefined;
	const navigation = providerCheckpointNavigation(entry.navigation);
	if (navigation === undefined) return undefined;

	const tokenCount = formatTokenCount(navigation.tokensBefore);
	if (tokenCount === undefined) return undefined;

	return new Text(
		theme.fg(
			"borderAccent",
			`${CODEX_REMOTE_COMPACTION_LABEL} (${tokenCount} tokens before compaction)`,
		),
		0,
		0,
	);
};

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		(ctx.ui as unknown as StatusUI).setStatus?.(CODEX_REMOTE_COMPACTION_STATUS_KEY, text);
	} catch {
		// Status is presentation-only and must not affect provider dispatch.
	}
}

function clearStatus(ctx: ExtensionContext): void {
	setStatus(ctx, undefined);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	try {
		(ctx.ui as unknown as StatusUI).notify?.(message, type);
	} catch {
		// Notification is presentation-only and must not affect checkpoint persistence.
	}
}

function providerCheckpointNavigation(
	value: SessionEntryNavigation | undefined,
): SessionEntryNavigation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (value.role !== "provider_checkpoint") return undefined;
	if (
		typeof value.tokensBefore !== "number" ||
		!Number.isFinite(value.tokensBefore) ||
		value.tokensBefore < 0
	) {
		return undefined;
	}
	return value;
}

function formatTokenCount(value: number): string | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	const rounded = Math.round(value);
	const formatted = rounded.toLocaleString("en-US", {
		maximumFractionDigits: 0,
		useGrouping: true,
	});
	return formatted.length <= MAX_FORMATTED_TOKEN_COUNT_LENGTH
		? formatted
		: rounded.toExponential(3);
}

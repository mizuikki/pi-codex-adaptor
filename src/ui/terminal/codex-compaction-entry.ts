import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CODEX_AUTO_COMPACTION_KIND } from "../../application/compaction.ts";

/** Visible automatic-compaction information message (marker is rendered separately). */
export const CODEX_COMPACTION_TRANSCRIPT_TEXT = "Context compacted";

/** Leading single-column marker for the automatic-compaction information row. */
export const CODEX_COMPACTION_MARKER = "\u2022";

/** Render persisted automatic checkpoints as a Codex-style single-line information event. */
export function registerCodexCompactionEntryRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(CODEX_AUTO_COMPACTION_KIND, (_entry, _options, theme) => {
		const marker = theme.fg("dim", CODEX_COMPACTION_MARKER);
		// Message uses normal transcript styling (unthemed) so only the marker is dimmed.
		return new Text(`${marker} ${CODEX_COMPACTION_TRANSCRIPT_TEXT}`, 0, 0);
	});
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CODEX_AUTO_COMPACTION_KIND } from "../../application/compaction.ts";

export const CODEX_COMPACTION_TRANSCRIPT_TEXT = "context compacted";

/** Render persisted automatic checkpoints with the same transcript wording as Codex. */
export function registerCodexCompactionEntryRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(CODEX_AUTO_COMPACTION_KIND, (_entry, _options, theme) => {
		return new Text(theme.fg("dim", CODEX_COMPACTION_TRANSCRIPT_TEXT), 0, 0);
	});
}

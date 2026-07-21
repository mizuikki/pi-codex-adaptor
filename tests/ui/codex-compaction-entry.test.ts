import { expect, test } from "bun:test";
import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	CODEX_AUTO_COMPACTION_KIND,
	createCodexAutoCompactionCheckpoint,
} from "../../src/application/compaction.ts";
import {
	CODEX_COMPACTION_MARKER,
	CODEX_COMPACTION_TRANSCRIPT_TEXT,
	registerCodexCompactionEntryRenderer,
} from "../../src/ui/terminal/codex-compaction-entry.ts";

test("automatic compaction entries render as a single Codex-style information row", () => {
	let customType: string | undefined;
	let renderer: EntryRenderer | undefined;
	registerCodexCompactionEntryRenderer({
		registerEntryRenderer: (type: string, value: EntryRenderer) => {
			customType = type;
			renderer = value;
		},
	} as ExtensionAPI);

	expect(customType).toBe(CODEX_AUTO_COMPACTION_KIND);
	if (renderer === undefined) throw new Error("compaction entry renderer was not registered");
	const checkpoint = createCodexAutoCompactionCheckpoint(
		{
			sessionFingerprint: "sha256:synthetic-session",
			providerId: "fixture-provider",
			api: "openai-responses",
			baseUrl: "https://invalid.example",
			modelId: "fixture-model",
			authenticationBinding: {
				kind: "credential",
				fingerprint: "sha256:synthetic-credential",
			},
		},
		"synthetic-checkpoint",
		"covered-entry",
		[{ type: "compaction", encrypted_content: "synthetic-opaque" }],
	);
	const theme = {
		fg: (color: string, text: string) => `[${color}]${text}`,
	};
	const component = renderer(
		{
			type: "custom",
			id: "entry-id",
			parentId: "covered-entry",
			timestamp: new Date(0).toISOString(),
			customType: CODEX_AUTO_COMPACTION_KIND,
			data: checkpoint,
		},
		{ expanded: false },
		theme as never,
	);

	const styled = component?.render(80).map((line) => line.trimEnd()) ?? [];
	expect(styled).toEqual([`[dim]${CODEX_COMPACTION_MARKER} ${CODEX_COMPACTION_TRANSCRIPT_TEXT}`]);

	const plain = styled.map((line) => line.replace(/\[[a-zA-Z]+\]/g, ""));
	expect(plain).toEqual([`${CODEX_COMPACTION_MARKER} ${CODEX_COMPACTION_TRANSCRIPT_TEXT}`]);
	expect(CODEX_COMPACTION_TRANSCRIPT_TEXT).toBe("Context compacted");

	// Checkpoint data, gutters, expansion, and token counts stay out of the projection.
	const joined = plain.join("\n");
	expect(joined).not.toContain("synthetic-checkpoint");
	expect(joined).not.toContain("synthetic-opaque");
	expect(joined).not.toContain("encrypted");
	expect(joined).not.toContain("\u2502");
	expect(joined).not.toContain("\u2514");
	expect(joined).not.toContain("token");

	// Stable single line at representative widths.
	expect(component?.render(40).map((line) => line.replace(/\[[a-zA-Z]+\]/g, "").trimEnd())).toEqual(
		[`${CODEX_COMPACTION_MARKER} ${CODEX_COMPACTION_TRANSCRIPT_TEXT}`],
	);
	expect(
		component?.render(120).map((line) => line.replace(/\[[a-zA-Z]+\]/g, "").trimEnd()),
	).toEqual([`${CODEX_COMPACTION_MARKER} ${CODEX_COMPACTION_TRANSCRIPT_TEXT}`]);
});

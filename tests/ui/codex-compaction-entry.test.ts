import { expect, test } from "bun:test";
import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	CODEX_AUTO_COMPACTION_KIND,
	createCodexAutoCompactionCheckpoint,
} from "../../src/application/compaction.ts";
import {
	CODEX_COMPACTION_TRANSCRIPT_TEXT,
	registerCodexCompactionEntryRenderer,
} from "../../src/ui/terminal/codex-compaction-entry.ts";

test("automatic compaction entries render as a durable Codex-style transcript line", () => {
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

	expect(component?.render(80).map((line) => line.trimEnd())).toEqual([
		`[dim]${CODEX_COMPACTION_TRANSCRIPT_TEXT}`,
	]);
});

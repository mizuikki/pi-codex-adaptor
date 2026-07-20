import { describe, expect, test } from "bun:test";

import {
	createCodexCompactionDetails,
	parseCodexCompactionDetails,
	validateCompactionOutput,
} from "../../src/application/compaction.ts";

const OPAQUE = "synthetic-opaque-content";

const identity = {
	sessionFingerprint: "sha256:synthetic-session",
	providerId: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://invalid.example",
	modelId: "synthetic-model",
	authenticationBinding: {
		kind: "credential" as const,
		fingerprint: "sha256:synthetic-credential",
	},
};

describe("protocol-3 compaction application contract", () => {
	test("accepts the canonical typed projection and preserves the opaque string", () => {
		const details = createCodexCompactionDetails(identity, [
			{ type: "message", role: "assistant", content: [] },
			{
				type: "compaction",
				encrypted_content: OPAQUE,
				internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
			},
		]);

		expect(parseCodexCompactionDetails(details)).toEqual(details);
		expect(details.output[1]).toMatchObject({ encrypted_content: OPAQUE });
	});

	test("rejects persisted aliases and unsupported raw SSE fields", () => {
		expect(() =>
			validateCompactionOutput([{ type: "compaction_summary", encrypted_content: OPAQUE }]),
		).toThrow();
		expect(() =>
			validateCompactionOutput([
				{
					type: "compaction",
					encrypted_content: OPAQUE,
					unknown_sse_field: { marker: "synthetic" },
				},
			]),
		).toThrow();
	});
});

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { CODEX_REMOTE_COMPACTION_KIND } from "../src/application/compaction.ts";
import {
	projectCanonicalEntries,
	scanRemoteCompactionCheckpoints,
} from "../src/integration/pi/codex-compaction-replay.ts";

const ENTRY_COUNT = 10_000;
const TARGET_JSONL_BYTES = 50 * 1024 * 1024;
const ITERATIONS = 7;
const identity = {
	sessionFingerprint: "benchmark-session",
	providerId: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://benchmark.invalid/v1",
	modelId: "benchmark-model",
	authenticationBinding: { kind: "credential" as const, fingerprint: "benchmark-credential" },
};

function makeEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-27T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function makeBranch(): readonly SessionEntry[] {
	const emptyMessage = makeEntry("entry-0", null, "");
	const checkpointEntry: SessionEntry = {
		type: "custom",
		id: "checkpoint-entry",
		parentId: "entry-4999",
		timestamp: "2026-07-27T00:00:00.000Z",
		customType: CODEX_REMOTE_COMPACTION_KIND,
		data: {
			...identity,
			kind: CODEX_REMOTE_COMPACTION_KIND,
			version: 1,
			checkpointId: "benchmark-checkpoint",
			coveredEntryId: "entry-4999",
			implementation: "remote_v2",
			output: [{ type: "compaction", encrypted_content: "benchmark-opaque" }],
			tokensBefore: 1,
		},
	};
	const messageCount = ENTRY_COUNT - 1;
	const emptyMessageBytes = Array.from({ length: messageCount }, (_, index) =>
		Buffer.byteLength(
			JSON.stringify(makeEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, "")),
		),
	).reduce((total, bytes) => total + bytes + 1, 0);
	const fixedBytes = emptyMessageBytes + Buffer.byteLength(JSON.stringify(checkpointEntry)) + 1;
	const contentLength = Math.max(1, Math.floor((TARGET_JSONL_BYTES - fixedBytes) / messageCount));
	const content = "x".repeat(contentLength);
	const branch: SessionEntry[] = [];
	let parentId: string | null = null;
	for (let index = 0; index < messageCount; index += 1) {
		if (index === 5_000) {
			branch.push(checkpointEntry);
			parentId = checkpointEntry.id;
		}
		const id = `entry-${index}`;
		const entry =
			index === 0
				? { ...emptyMessage, message: { role: "user" as const, content, timestamp: 1 } }
				: makeEntry(id, parentId, content);
		branch.push(entry);
		parentId = id;
	}
	return branch;
}

function measure(operation: () => void): { p50: number; p95: number } {
	operation();
	const values: number[] = [];
	for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
		const start = performance.now();
		operation();
		values.push(performance.now() - start);
	}
	values.sort((left, right) => left - right);
	return {
		p50: values[Math.floor(values.length * 0.5)] ?? 0,
		p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] ?? 0,
	};
}

const branch = makeBranch();
const jsonlBytes = Buffer.byteLength(
	`${branch.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);
const fullProjection = measure(() => {
	void projectCanonicalEntries(branch);
});
const scan = measure(() => {
	void scanRemoteCompactionCheckpoints(branch, identity);
});
const selected = scanRemoteCompactionCheckpoints(branch, identity).matching;
if (selected === undefined) throw new Error("Benchmark checkpoint fixture did not parse");
const suffix = measure(() => {
	void projectCanonicalEntries(branch.slice(selected.coveredIndex + 1));
});
const beforeProviderPayload = measure(() => {
	const current = scanRemoteCompactionCheckpoints(branch, identity).matching;
	if (current === undefined) throw new Error("Benchmark checkpoint fixture disappeared");
	const suffixItems = projectCanonicalEntries(branch.slice(current.coveredIndex + 1));
	void [...current.checkpoint.output, ...suffixItems];
});

console.log(
	JSON.stringify(
		{
			entries: branch.length,
			jsonlMiB: Number((jsonlBytes / (1024 * 1024)).toFixed(3)),
			iterations: ITERATIONS,
			milliseconds: {
				canonicalProjection: fullProjection,
				checkpointScan: scan,
				suffixProjection: suffix,
				beforeProviderPayload: beforeProviderPayload,
			},
		},
		null,
		2,
	),
);

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
	assertCredentialFree,
	normalizeEventTypes,
	normalizeRequestBody,
	parseSseEvents,
	type ResponsesAllowlist,
} from "../conformance/allowlist.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const responsesRoot = resolve(repositoryRoot, "fixtures/responses");

describe("responses wire fixtures", () => {
	test("request, SSE, and WebSocket fixtures stay credential-free", async () => {
		const files = [
			"allowlist.json",
			"request-basic.json",
			"sse-basic.sse",
			"websocket-basic.jsonl",
			"expected-normalized.json",
		];
		for (const file of files) {
			const text = await readFile(resolve(responsesRoot, file), "utf8");
			assertCredentialFree(text, file);
			expect(text.length).toBeGreaterThan(0);
		}
	});

	test("SSE and WebSocket fixtures share the same allowlisted event order", async () => {
		const allowlist = JSON.parse(
			await readFile(resolve(responsesRoot, "allowlist.json"), "utf8"),
		) as ResponsesAllowlist;
		const expected = JSON.parse(
			await readFile(resolve(responsesRoot, "expected-normalized.json"), "utf8"),
		) as { eventTypes: string[]; terminalStatus: string; responseId: string };
		const request = JSON.parse(
			await readFile(resolve(responsesRoot, "request-basic.json"), "utf8"),
		) as Record<string, unknown>;
		const sse = await readFile(resolve(responsesRoot, "sse-basic.sse"), "utf8");
		const websocket = await readFile(resolve(responsesRoot, "websocket-basic.jsonl"), "utf8");

		const sseEvents = parseSseEvents(sse);
		const websocketEvents = websocket
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.direction === "server");

		expect(normalizeEventTypes(sseEvents, allowlist)).toEqual(expected.eventTypes);
		expect(normalizeEventTypes(websocketEvents, allowlist)).toEqual(expected.eventTypes);
		expect(expected.terminalStatus).toBe("completed");
		expect(expected.responseId).toBe("fixture-response");
		expect(normalizeRequestBody(request, allowlist).model).toBe("fixture-model");
		expect(normalizeRequestBody(request, allowlist).stream).toBe(true);
	});
});

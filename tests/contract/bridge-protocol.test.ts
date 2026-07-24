import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";

import {
	BRIDGE_PROTOCOL_VERSION,
	BridgeProtocolError,
	decodeServerFrame,
	encodeClientMessage,
	MAX_FRAME_BYTES,
	ProviderConnectionSchema,
	ServerFrameDecoder,
	verifyHandshake,
} from "../../src/infrastructure/codex-bridge/protocol.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("bridge protocol v5", () => {
	test("keeps the canonical summary request fixture structurally valid", async () => {
		const fixture = await readFile(
			resolve(repositoryRoot, "fixtures/bridge-protocol/client-v5.jsonl"),
			"utf8",
		);
		const request = fixture
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((frame) => frame.method === "contexts.summarize");
		expect(request).toMatchObject({
			type: "request",
			params: {
				modelId: "fixture-model",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "fixture context" }],
					},
				],
			},
		});
	});

	test("decodes every native server contract frame", async () => {
		const fixture = await readFile(
			resolve(repositoryRoot, "fixtures/bridge-protocol/server-v5.jsonl"),
			"utf8",
		);
		const messages = fixture.trimEnd().split("\n").map(decodeServerFrame);

		expect(messages).toHaveLength(7);
		expect(messages[0]).toMatchObject({
			type: "handshake",
			handshake: {
				bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
				capabilities: expect.arrayContaining(["portable_context_summary"]),
			},
		});
	});

	test("retains unknown official event payloads", () => {
		const message = decodeServerFrame(
			'{"type":"event","requestId":"request-1","sequence":1,"event":{"type":"future.event","opaque":{"retained":true}}}\n',
		);

		expect(message).toEqual({
			type: "event",
			requestId: "request-1",
			sequence: 1,
			event: { type: "future.event", opaque: { retained: true } },
		});
	});

	test("encodes canonical camel-case client envelopes", () => {
		const frame = encodeClientMessage({
			type: "cancel",
			requestId: "cancel-1",
			targetRequestId: "request-1",
		});

		expect(new TextDecoder().decode(frame)).toBe(
			'{"type":"cancel","requestId":"cancel-1","targetRequestId":"request-1"}\n',
		);
	});

	test("rejects unknown envelope fields without reflecting frame content", () => {
		const sentinel = "private-sentinel-value";

		try {
			decodeServerFrame(
				`{"type":"result","requestId":"request-1","status":"completed","result":{},"opaque":"${sentinel}"}`,
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BridgeProtocolError);
			expect(String(error)).not.toContain(sentinel);
		}
	});

	test("rejects an oversized frame before parsing it", () => {
		const frame = new Uint8Array(MAX_FRAME_BYTES + 1);
		frame.fill(120);

		expect(() => decodeServerFrame(frame)).toThrow("exceeds");
	});

	test("rejects multiple records supplied as one frame", () => {
		expect(() =>
			decodeServerFrame(
				'{"type":"result","requestId":"one","status":"completed","result":{}}\n{"type":"result","requestId":"two","status":"completed","result":{}}\n',
			),
		).toThrow("multiple JSONL frames");
	});

	test("decodes arbitrarily chunked process output", async () => {
		const fixture = await readFile(
			resolve(repositoryRoot, "fixtures/bridge-protocol/server-v5.jsonl"),
		);
		const decoder = new ServerFrameDecoder();
		const messages = [];

		for (let offset = 0; offset < fixture.byteLength; offset += 7) {
			messages.push(...decoder.push(fixture.subarray(offset, offset + 7)));
		}
		decoder.finish();

		expect(messages).toHaveLength(7);
	});

	test("rejects unterminated process output", () => {
		const decoder = new ServerFrameDecoder();
		decoder.push(new TextEncoder().encode('{"type":"event"}'));

		expect(() => decoder.finish()).toThrow("unterminated JSONL frame");
	});

	test("advertises approval decisions in decline, cancel, allow_once order", async () => {
		const fixture = await readFile(
			resolve(repositoryRoot, "fixtures/bridge-protocol/server-v5.jsonl"),
			"utf8",
		);
		const approval = fixture
			.trimEnd()
			.split("\n")
			.map(decodeServerFrame)
			.find((message) => message.type === "approval_request");
		if (approval?.type !== "approval_request") {
			throw new Error("Contract fixture must include an approval request");
		}

		expect(approval.approval.availableDecisions).toEqual(["decline", "cancel", "allow_once"]);
		expect(approval.approval.availableDecisions).not.toContain("allow_session");
	});

	test("rejects secret-bearing malformed frames without echoing contents", () => {
		const secret = "fixture-secret-sentinel";

		try {
			decodeServerFrame(
				`{"type":"error","requestId":"request-1","error":{"category":"ProtocolError","code":"invalid_frame","message":"x","retryable":false},"token":"${secret}"}`,
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BridgeProtocolError);
			expect(String(error)).not.toContain(secret);
			expect((error as BridgeProtocolError).message).toBe(
				"Bridge frame does not match protocol v5",
			);
		}
	});

	test("verifies every immutable handshake field", async () => {
		const fixture = await readFile(
			resolve(repositoryRoot, "fixtures/bridge-protocol/server-v5.jsonl"),
			"utf8",
		);
		const message = decodeServerFrame(fixture.split("\n")[0] ?? "");
		if (message.type !== "handshake") {
			throw new Error("Contract fixture must begin with a handshake");
		}

		verifyHandshake(message.handshake, "x86_64-unknown-linux-musl", {
			expectedBuildSourceCommit: "0000000000000000000000000000000000000000",
		});
		expect(() =>
			verifyHandshake(
				{ ...message.handshake, officialCodexVersion: "0.0.0" },
				"x86_64-unknown-linux-musl",
			),
		).toThrow("officialCodexVersion");
		expect(() =>
			verifyHandshake(message.handshake, "x86_64-unknown-linux-musl", {
				expectedBuildSourceCommit: "1111111111111111111111111111111111111111",
			}),
		).toThrow("build source");
	});

	test("session_write empty and non-empty frames remain valid protocol envelopes", () => {
		const nonEmpty = encodeClientMessage({
			type: "session_write",
			requestId: "write-1",
			sessionId: "session-1",
			authorization: "require_approval",
			data: "sample input",
		});
		const empty = encodeClientMessage({
			type: "session_write",
			requestId: "write-2",
			sessionId: "session-1",
			authorization: "preauthorized",
			data: "",
		});
		expect(new TextDecoder().decode(nonEmpty)).toContain('"data":"sample input"');
		expect(new TextDecoder().decode(empty)).toContain('"data":""');
	});

	test("rejects missing and unknown session_write authorization", () => {
		const withoutAuthorization = {
			type: "session_write",
			requestId: "write-1",
			sessionId: "session-1",
			data: "input",
		};
		const unknownAuthorization = {
			...withoutAuthorization,
			authorization: "allow_once",
		};

		expect(() => encodeClientMessage(withoutAuthorization as never)).toThrow("protocol v5");
		expect(() => encodeClientMessage(unknownAuthorization as never)).toThrow("protocol v5");
	});

	test("provider connection timeoutMs accepts finite bounds and Pi's disabled sentinel", () => {
		const validator = Compile(ProviderConnectionSchema);
		const base = {
			providerId: "fixture-provider",
			baseUrl: "https://example.invalid/v1",
			headers: {},
			authentication: { kind: "none" as const },
		};

		expect(validator.Check({ ...base, timeoutMs: 1 })).toBe(true);
		expect(validator.Check({ ...base, timeoutMs: 86_400_000 })).toBe(true);
		expect(validator.Check({ ...base, timeoutMs: 2_147_483_647 })).toBe(true);
		expect(validator.Check({ ...base, timeoutMs: 0 })).toBe(false);
		expect(validator.Check({ ...base, timeoutMs: 86_400_001 })).toBe(false);
		expect(validator.Check({ ...base, timeoutMs: 2_147_483_646 })).toBe(false);
		expect(validator.Check({ ...base, timeoutMs: 2_147_483_648 })).toBe(false);
		expect(validator.Check({ ...base, websocketConnectTimeoutMs: 2_147_483_647 })).toBe(false);
	});
});

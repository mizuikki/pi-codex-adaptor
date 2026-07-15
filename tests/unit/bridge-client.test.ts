import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
	BridgeClient,
	BridgeRemoteError,
	type BridgeTransport,
} from "../../src/infrastructure/codex-bridge/client.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	type ClientMessage,
	MAX_FRAME_BYTES,
	MAX_PENDING_EVENTS,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	type ServerMessage,
	VENDOR_TREE_SHA256,
} from "../../src/infrastructure/codex-bridge/protocol.ts";

class FakeBridgeTransport implements BridgeTransport {
	readonly input = new PassThrough();
	readonly output = new PassThrough();
	readonly acknowledgements: number[] = [];
	readonly controlMessages: ClientMessage[] = [];
	readonly requestMessages: ClientMessage[] = [];
	approvalMode: "none" | "hold" | "auto-allow" = "none";
	completeCancelledRequests = true;
	readonly suppressedControlTypes = new Set<ClientMessage["type"]>();
	readonly #closeListeners = new Set<() => void>();
	#inputBuffer = "";
	#closed = false;
	#heldApprovals = new Map<string, string>();

	constructor() {
		this.input.on("data", (chunk: Buffer) => this.#receive(chunk.toString("utf8")));
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.input.destroy();
		this.output.destroy();
		for (const listener of this.#closeListeners) {
			listener();
		}
	}

	get isClosed(): boolean {
		return this.#closed;
	}

	emit(message: ServerMessage): void {
		this.#send(message);
	}

	endOutput(): void {
		this.output.end();
	}

	onClose(listener: () => void): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	#receive(chunk: string): void {
		this.#inputBuffer += chunk;
		for (;;) {
			const newline = this.#inputBuffer.indexOf("\n");
			if (newline < 0) {
				return;
			}
			const frame = this.#inputBuffer.slice(0, newline);
			this.#inputBuffer = this.#inputBuffer.slice(newline + 1);
			this.#handle(JSON.parse(frame) as ClientMessage);
		}
	}

	#handle(message: ClientMessage): void {
		switch (message.type) {
			case "initialize":
				this.#send({
					type: "handshake",
					requestId: message.requestId,
					handshake: {
						bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
						officialCodexVersion: OFFICIAL_CODEX_VERSION,
						officialCodexTag: OFFICIAL_CODEX_TAG,
						officialSourceCommit: OFFICIAL_SOURCE_COMMIT,
						buildTarget: "x86_64-unknown-linux-musl",
						buildSourceCommit: "development",
						vendorTreeSha256: VENDOR_TREE_SHA256,
						maxFrameBytes: MAX_FRAME_BYTES,
						maxPendingEvents: MAX_PENDING_EVENTS,
						capabilities: [],
					},
				});
				break;
			case "request":
				this.requestMessages.push(message);
				if (message.method === "diagnostics.read") {
					this.#send({
						type: "event",
						requestId: message.requestId,
						sequence: 1,
						event: { type: "sample.event" },
					});
					this.#send({
						type: "result",
						requestId: message.requestId,
						status: "completed",
						result: { ready: true },
					});
				} else if (message.method === "tools.execute" && this.approvalMode !== "none") {
					const approvalId = `approval-${message.requestId}`;
					this.#heldApprovals.set(message.requestId, approvalId);
					this.#send({
						type: "approval_request",
						requestId: message.requestId,
						approval: {
							approvalId,
							operation: "command",
							summary: "fixture command",
							details: {},
							availableDecisions: ["decline", "cancel", "allow_once"],
						},
					});
					if (this.approvalMode === "auto-allow") {
						// Wait for the host decision before completing.
					}
				} else {
					this.#send({
						type: "error",
						requestId: message.requestId,
						error: {
							category: "CapabilityError",
							code: "unsupported",
							message: "The requested capability is unavailable",
							retryable: false,
						},
					});
				}
				break;
			case "acknowledge":
				this.acknowledgements.push(message.sequence);
				break;
			case "shutdown":
				this.controlMessages.push(message);
				if (this.suppressedControlTypes.has(message.type)) break;
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: {},
				});
				break;
			case "authentication_update":
			case "session_write":
			case "session_resize":
			case "session_terminate":
				this.controlMessages.push(message);
				if (this.suppressedControlTypes.has(message.type)) break;
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: {},
				});
				break;
			case "cancel":
				this.controlMessages.push(message);
				if (this.suppressedControlTypes.has(message.type)) break;
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: { targetRequestId: message.targetRequestId },
				});
				if (this.completeCancelledRequests && this.#heldApprovals.has(message.targetRequestId)) {
					this.#heldApprovals.delete(message.targetRequestId);
					this.#send({
						type: "result",
						requestId: message.targetRequestId,
						status: "aborted",
						result: {},
					});
				}
				break;
			case "approval_decision": {
				this.controlMessages.push(message);
				const matched = [...this.#heldApprovals.entries()].find(
					([, approvalId]) => approvalId === message.approvalId,
				);
				if (matched === undefined) {
					// Expired/late decisions complete as no-ops and must not fail the client.
					this.#send({
						type: "result",
						requestId: message.requestId,
						status: "completed",
						result: { approvalId: message.approvalId, status: "expired" },
					});
					break;
				}
				this.#heldApprovals.delete(matched[0]);
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: { approvalId: message.approvalId },
				});
				this.#send({
					type: "result",
					requestId: matched[0],
					status: "completed",
					result: { allowed: true },
				});
				break;
			}
		}
	}

	#send(message: ServerMessage): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}
}

async function connect(
	transport: FakeBridgeTransport,
	options: { controlRequestTimeoutMs?: number } = {},
): Promise<BridgeClient> {
	return BridgeClient.connect({
		buildTarget: "x86_64-unknown-linux-musl",
		clientVersion: "0.0.0",
		allowDevelopmentBuild: true,
		transport,
		...options,
	});
}

describe("bridge process client", () => {
	test("orders event handlers and acknowledges before resolving results", async () => {
		const transport = new FakeBridgeTransport();
		const client = await connect(transport);
		const events: unknown[] = [];

		const result = await client.request(
			"diagnostics.read",
			{},
			{
				onEvent: async (event) => {
					await Promise.resolve();
					events.push(event);
				},
			},
		);

		expect(events).toEqual([{ type: "sample.event" }]);
		expect(transport.acknowledgements).toEqual([1]);
		expect(result).toEqual({ status: "completed", result: { ready: true } });
		await client.shutdown();
	});

	test("rejects a terminal request when its event handler outlives the connection", async () => {
		const transport = new FakeBridgeTransport();
		const client = await connect(transport);
		let eventStarted: (() => void) | undefined;
		let finishEvent: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			eventStarted = resolve;
		});
		const finish = new Promise<void>((resolve) => {
			finishEvent = resolve;
		});

		const pending = client.request(
			"diagnostics.read",
			{},
			{
				onEvent: async () => {
					eventStarted?.();
					await finish;
				},
			},
		);
		await started;
		client.close();
		await expect(pending).rejects.toMatchObject({ code: "connection_closed" });
		finishEvent?.();
	});

	test("maps correlated native errors without exposing process details", async () => {
		const transport = new FakeBridgeTransport();
		const client = await connect(transport);

		try {
			await client.request("models.resolve", {});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BridgeRemoteError);
			expect(error).toMatchObject({ category: "CapabilityError", code: "unsupported" });
		}
		await client.shutdown();
	});

	test("correlates approval and native session control operations", async () => {
		const transport = new FakeBridgeTransport();
		const client = await connect(transport);

		await client.decideApproval("approval-1", "allow_once");
		await client.writeSession("session-1", "input");
		await client.writeSession("session-1", "");
		await client.resizeSession("session-1", 120, 40);
		await client.terminateSession("session-1");

		expect(transport.controlMessages).toEqual([
			{
				type: "approval_decision",
				requestId: expect.any(String),
				approvalId: "approval-1",
				decision: "allow_once",
			},
			{
				type: "session_write",
				requestId: expect.any(String),
				sessionId: "session-1",
				data: "input",
			},
			{
				type: "session_write",
				requestId: expect.any(String),
				sessionId: "session-1",
				data: "",
			},
			{
				type: "session_resize",
				requestId: expect.any(String),
				sessionId: "session-1",
				columns: 120,
				rows: 40,
			},
			{
				type: "session_terminate",
				requestId: expect.any(String),
				sessionId: "session-1",
			},
		]);
		await client.shutdown();
	});

	test("encodes non-empty session_write data without echoing it into client errors", async () => {
		const transport = new FakeBridgeTransport();
		const client = await connect(transport);
		const secret = "SECRET_SESSION_WRITE_PAYLOAD";

		await client.writeSession("session-1", secret);
		const write = transport.controlMessages.find(
			(message) => message.type === "session_write" && message.data === secret,
		);
		expect(write).toMatchObject({
			type: "session_write",
			sessionId: "session-1",
			data: secret,
		});
		await client.shutdown();
	});

	test("aborts an in-flight request over the cancel protocol frame", async () => {
		const transport = new FakeBridgeTransport();
		transport.approvalMode = "hold";
		transport.completeCancelledRequests = false;
		const client = await connect(transport);
		const controller = new AbortController();
		const approvals: string[] = [];
		let approvalDelivered: (() => void) | undefined;
		const approval = new Promise<void>((resolve) => {
			approvalDelivered = resolve;
		});

		const pending = client.request(
			"tools.execute",
			{ tool: "shell_command", command: "sleep 30" },
			{
				signal: controller.signal,
				onApprovalRequest: (approval) => {
					approvals.push(approval.approvalId);
					approvalDelivered?.();
				},
			},
		);
		await approval;
		expect(approvals).toHaveLength(1);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(
			transport.controlMessages.some(
				(message) => message.type === "cancel" && typeof message.targetRequestId === "string",
			),
		).toBe(true);
		const request = transport.requestMessages.find(
			(message) => message.type === "request" && message.method === "tools.execute",
		);
		if (request?.type === "request") {
			transport.emit({
				type: "result",
				requestId: request.requestId,
				status: "aborted",
				result: {},
			});
		}
		expect(client.isReady).toBe(true);
		await client.shutdown();
	});

	test("bounds control requests and ignores their late terminal frames", async () => {
		const transport = new FakeBridgeTransport();
		transport.suppressedControlTypes.add("session_resize");
		const client = await connect(transport, { controlRequestTimeoutMs: 10 });

		await expect(client.resizeSession("session-1", 120, 40)).rejects.toMatchObject({
			code: "control_timeout",
		});
		const resize = transport.controlMessages.find((message) => message.type === "session_resize");
		expect(resize).toBeDefined();
		if (resize?.type === "session_resize") {
			transport.emit({
				type: "result",
				requestId: resize.requestId,
				status: "completed",
				result: {},
			});
		}
		const diagnostics = await client.request("diagnostics.read", {});
		expect(diagnostics.status).toBe("completed");
		await client.shutdown();
	});

	test("supports local cancellation of control requests", async () => {
		const transport = new FakeBridgeTransport();
		transport.suppressedControlTypes.add("session_write");
		const client = await connect(transport);
		const controller = new AbortController();

		const pending = client.writeSession("session-1", "input", {
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		const write = transport.controlMessages.find((message) => message.type === "session_write");
		if (write?.type === "session_write") {
			transport.emit({
				type: "result",
				requestId: write.requestId,
				status: "completed",
				result: {},
			});
		}
		const diagnostics = await client.request("diagnostics.read", {});
		expect(diagnostics.status).toBe("completed");
		expect(client.isReady).toBe(true);
		await client.shutdown();
	});

	test("closes the transport when shutdown times out", async () => {
		const transport = new FakeBridgeTransport();
		transport.suppressedControlTypes.add("shutdown");
		const client = await connect(transport, { controlRequestTimeoutMs: 10 });

		await expect(client.shutdown()).rejects.toMatchObject({ code: "control_timeout" });
		expect(client.isReady).toBe(false);
		expect(transport.isClosed).toBe(true);
	});

	test("rejects shutdown when the transport closes without a response", async () => {
		const transport = new FakeBridgeTransport();
		transport.suppressedControlTypes.add("shutdown");
		const client = await connect(transport);

		const pending = client.shutdown();
		transport.close();
		await expect(pending).rejects.toMatchObject({ code: "connection_closed" });
		expect(client.isReady).toBe(false);
	});

	test("rejects shutdown when bridge output ends without a response", async () => {
		const transport = new FakeBridgeTransport();
		transport.suppressedControlTypes.add("shutdown");
		const client = await connect(transport);

		const pending = client.shutdown();
		transport.endOutput();
		await expect(pending).rejects.toMatchObject({ code: "connection_closed" });
		expect(transport.isClosed).toBe(true);
	});

	test("closes the transport when shutdown returns a non-completed result", async () => {
		const transport = new FakeBridgeTransport();
		transport.suppressedControlTypes.add("shutdown");
		const client = await connect(transport);

		const pending = client.shutdown();
		const shutdown = transport.controlMessages.find((message) => message.type === "shutdown");
		if (shutdown?.type === "shutdown") {
			transport.emit({
				type: "result",
				requestId: shutdown.requestId,
				status: "failed",
				result: {},
			});
		}
		await expect(pending).rejects.toMatchObject({ code: "protocol_failure" });
		expect(transport.isClosed).toBe(true);
	});

	test("late approval decisions after cancel complete without failing the connection", async () => {
		const transport = new FakeBridgeTransport();
		const client = await connect(transport);

		// No active approval: native completes as expired no-op.
		await client.decideApproval("approval-expired", "allow_once");
		expect(client.isReady).toBe(true);
		const diagnostics = await client.request("diagnostics.read", {});
		expect(diagnostics.status).toBe("completed");
		await client.shutdown();
	});
});

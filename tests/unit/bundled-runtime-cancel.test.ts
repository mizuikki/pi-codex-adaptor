import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
	type BridgeAuthentication,
	BridgeClient,
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
import { BundledCodexRuntime } from "../../src/infrastructure/codex-bridge/runtime.ts";

class ScriptedTransport implements BridgeTransport {
	readonly input = new PassThrough();
	readonly output = new PassThrough();
	readonly controlMessages: ClientMessage[] = [];
	readonly #closeListeners = new Set<() => void>();
	#inputBuffer = "";
	#closed = false;
	#held = new Map<string, string>();
	connections = 1;

	constructor() {
		this.input.on("data", (chunk: Buffer) => this.#receive(chunk.toString("utf8")));
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.input.destroy();
		this.output.destroy();
		for (const listener of this.#closeListeners) listener();
	}

	onClose(listener: () => void): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	failConnection(): void {
		this.close();
	}

	#receive(chunk: string): void {
		this.#inputBuffer += chunk;
		for (;;) {
			const newline = this.#inputBuffer.indexOf("\n");
			if (newline < 0) return;
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
				if (message.method === "tools.execute") {
					const approvalId = `approval-${message.requestId}`;
					this.#held.set(message.requestId, approvalId);
					this.#send({
						type: "approval_request",
						requestId: message.requestId,
						approval: {
							approvalId,
							operation: "command",
							summary: "fixture",
							details: {},
							availableDecisions: ["decline", "cancel", "allow_once"],
						},
					});
				} else if (message.method === "diagnostics.read") {
					this.#send({
						type: "result",
						requestId: message.requestId,
						status: "completed",
						result: { ready: true, connection: this.connections },
					});
				} else {
					this.#send({
						type: "result",
						requestId: message.requestId,
						status: "completed",
						result: {},
					});
				}
				break;
			case "cancel":
				this.controlMessages.push(message);
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: { targetRequestId: message.targetRequestId },
				});
				if (this.#held.has(message.targetRequestId)) {
					this.#held.delete(message.targetRequestId);
					this.#send({
						type: "result",
						requestId: message.targetRequestId,
						status: "aborted",
						result: {},
					});
				}
				break;
			case "approval_decision":
				this.controlMessages.push(message);
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: { approvalId: message.approvalId, status: "expired" },
				});
				break;
			case "shutdown":
				this.#send({
					type: "result",
					requestId: message.requestId,
					status: "completed",
					result: {},
				});
				break;
			default:
				if ("requestId" in message) {
					this.#send({
						type: "result",
						requestId: message.requestId,
						status: "completed",
						result: {},
					});
				}
		}
	}

	#send(message: ServerMessage): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}
}

const fixtureAuthentication = {
	kind: "openai_api_key" as const,
	apiKey: "sk-test-not-a-secret",
};

function createRuntime(
	openBridge: (input: { authentication?: BridgeAuthentication }) => Promise<BridgeClient>,
): BundledCodexRuntime {
	return new BundledCodexRuntime({
		packageRoot: "/tmp/pi-codex-adaptor-test",
		clientVersion: "0.0.0",
		allowDevelopmentBuild: true,
		openBridge,
	});
}

async function openScriptedBridge(
	transport: ScriptedTransport,
	input: { authentication?: BridgeAuthentication } = {},
): Promise<BridgeClient> {
	return BridgeClient.connect({
		buildTarget: "x86_64-unknown-linux-musl",
		clientVersion: "0.0.0",
		allowDevelopmentBuild: true,
		transport,
		...(input.authentication === undefined ? {} : { authentication: input.authentication }),
	});
}

describe("cancellation and approval recovery", () => {
	test("BundledCodexRuntime abort during approval does not send a late decision", async () => {
		const transport = new ScriptedTransport();
		const runtime = createRuntime((input) => openScriptedBridge(transport, input));
		const controller = new AbortController();
		let uiFinished = false;
		let finishUi: (() => void) | undefined;
		const uiCompletion = new Promise<void>((resolve) => {
			finishUi = resolve;
		});

		const pending = runtime.executeTool({
			authentication: fixtureAuthentication,
			tool: "shell_command",
			argumentsValue: { command: "sleep 30" },
			workdir: "/tmp",
			workspaceRoots: ["/tmp"],
			signal: controller.signal,
			onApproval: async () => {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 250);
					controller.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
				uiFinished = true;
				finishUi?.();
				return "allow_once" as const;
			},
		});
		await Bun.sleep(20);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await uiCompletion;
		expect(uiFinished).toBe(true);
		expect(transport.controlMessages.some((message) => message.type === "approval_decision")).toBe(
			false,
		);
		expect(
			transport.controlMessages.some(
				(message) => message.type === "cancel" && typeof message.targetRequestId === "string",
			),
		).toBe(true);
		await runtime.shutdown();
	});

	test("BundledCodexRuntime late expired approval decision does not fail the next request", async () => {
		const transport = new ScriptedTransport();
		const runtime = createRuntime((input) => openScriptedBridge(transport, input));
		const controller = new AbortController();

		const pending = runtime.executeTool({
			authentication: fixtureAuthentication,
			tool: "shell_command",
			argumentsValue: { command: "printf should-not-run" },
			workdir: "/tmp",
			workspaceRoots: ["/tmp"],
			signal: controller.signal,
			onApproval: async () => {
				controller.abort();
				return "allow_once" as const;
			},
		});
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(transport.controlMessages.some((message) => message.type === "approval_decision")).toBe(
			false,
		);

		const diagnostics = await runtime.readDiagnostics();
		expect(diagnostics).toEqual({ ready: true, connection: 1 });
		await runtime.shutdown();
	});

	test("BundledCodexRuntime discards a fatally failed client and reconnects without credential leakage", async () => {
		const transports: ScriptedTransport[] = [];
		let opens = 0;
		const runtime = createRuntime(async (input) => {
			opens += 1;
			const transport = new ScriptedTransport();
			transport.connections = opens;
			transports.push(transport);
			return openScriptedBridge(transport, input);
		});

		const first = await runtime.readDiagnostics();
		expect(first).toEqual({ ready: true, connection: 1 });
		expect(opens).toBe(1);

		transports[0]?.failConnection();

		const second = await runtime.readDiagnostics();
		expect(second).toEqual({ ready: true, connection: 2 });
		expect(opens).toBe(2);
		expect(JSON.stringify(second)).not.toContain("sk-");
		expect(JSON.stringify(second)).not.toContain("Bearer");
		expect(JSON.stringify(second)).not.toContain(fixtureAuthentication.apiKey);
		await runtime.shutdown();
	});
});

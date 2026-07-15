import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { createBridgeChildEnvironment } from "./environment.ts";
import {
	BRIDGE_PROTOCOL_VERSION,
	type BridgeHandshake,
	type ClientMessage,
	encodeClientMessage,
	ServerFrameDecoder,
	type ServerMessage,
	verifyHandshake,
} from "./protocol.ts";

export type BridgeAuthentication = NonNullable<
	Extract<ClientMessage, { type: "initialize" }>["authentication"]
>;
export type BridgeRequestMethod = Extract<ClientMessage, { type: "request" }>["method"];
export type BridgeTerminalStatus = Extract<ServerMessage, { type: "result" }>["status"];
export type BridgeApprovalRequest = Extract<
	ServerMessage,
	{ type: "approval_request" }
>["approval"];
export type BridgeApprovalDecision = Extract<
	ClientMessage,
	{ type: "approval_decision" }
>["decision"];

export interface BridgeResult {
	status: BridgeTerminalStatus;
	result: unknown;
}

export interface BridgeRequestOptions {
	signal?: AbortSignal;
	onEvent?: (event: unknown, sequence: number) => void | Promise<void>;
	onApprovalRequest?: (approval: BridgeApprovalRequest) => void | Promise<void>;
	onBackpressure?: (state: "paused" | "resumed", pendingEvents: number) => void | Promise<void>;
}

export interface BridgeControlRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface BridgeTransport {
	readonly input: Writable;
	readonly output: Readable;
	close(): void;
	onClose(listener: () => void): () => void;
}

export interface BridgeClientOptions {
	buildTarget: string;
	clientVersion: string;
	authentication?: BridgeAuthentication;
	allowDevelopmentBuild?: boolean;
	expectedBuildSourceCommit?: string;
	handshakeTimeoutMs?: number;
	controlRequestTimeoutMs?: number;
	transport: BridgeTransport;
}

interface PendingRequest {
	resolve: (result: BridgeResult) => void;
	reject: (error: Error) => void;
	options: BridgeRequestOptions;
	eventChain: Promise<void>;
	removeAbortListener?: () => void;
	clearTimeout?: () => void;
}

interface PendingHandshake {
	requestId: string;
	resolve: (handshake: BridgeHandshake) => void;
	reject: (error: Error) => void;
}

export class BridgeRemoteError extends Error {
	readonly category: Extract<ServerMessage, { type: "error" }>["error"]["category"];
	readonly code: string;
	readonly retryable: boolean;

	constructor(error: Extract<ServerMessage, { type: "error" }>["error"]) {
		super(error.message);
		this.name = "BridgeRemoteError";
		this.category = error.category;
		this.code = error.code;
		this.retryable = error.retryable;
	}
}

export class BridgeConnectionError extends Error {
	readonly code:
		| "connection_closed"
		| "control_timeout"
		| "event_handler_failed"
		| "handshake_timeout"
		| "protocol_failure"
		| "write_failed";

	constructor(code: BridgeConnectionError["code"], message: string) {
		super(message);
		this.name = "BridgeConnectionError";
		this.code = code;
	}
}

export class BridgeClient {
	readonly #options: BridgeClientOptions;
	readonly #decoder = new ServerFrameDecoder();
	readonly #pending = new Map<string, PendingRequest>();
	readonly #ignoredRequestIds = new Set<string>();
	#handshake: PendingHandshake | undefined;
	#ready = false;
	#closing = false;
	#closed = false;
	#shutdownPromise: Promise<void> | undefined;

	private constructor(options: BridgeClientOptions) {
		this.#options = options;
		options.transport.output.on("data", (chunk: Buffer) => this.#receive(chunk));
		options.transport.output.on("end", () => this.#outputEnded());
		options.transport.onClose(() => this.#transportClosed());
	}

	static async connect(options: BridgeClientOptions): Promise<BridgeClient> {
		const client = new BridgeClient(options);
		try {
			await client.#initialize();
			return client;
		} catch (error) {
			client.#fail(
				error instanceof Error
					? error
					: new BridgeConnectionError("protocol_failure", "Bridge initialization failed"),
			);
			throw error;
		}
	}

	get isReady(): boolean {
		return this.#ready && !this.#closed;
	}

	async request(
		method: BridgeRequestMethod,
		params: unknown,
		options: BridgeRequestOptions = {},
	): Promise<BridgeResult> {
		this.#requireReady();
		if (options.signal?.aborted === true) {
			throw new DOMException("The bridge request was aborted", "AbortError");
		}

		const requestId = randomUUID();
		const result = new Promise<BridgeResult>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve,
				reject,
				options,
				eventChain: Promise.resolve(),
			};
			if (options.signal !== undefined) {
				const abort = () => {
					this.#rejectPending(requestId, abortedRequestError());
					this.#ignoreLateMessages(requestId);
					void this.cancel(requestId).catch(() => {});
				};
				options.signal.addEventListener("abort", abort, { once: true });
				pending.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
			}
			this.#pending.set(requestId, pending);
		});

		void this.#write({ type: "request", requestId, method, params }).catch((error) => {
			this.#rejectPending(requestId, toError(error));
		});
		return result;
	}

	async cancel(targetRequestId: string, options: BridgeControlRequestOptions = {}): Promise<void> {
		const result = await this.#controlRequest(
			(requestId) => ({
				type: "cancel",
				requestId,
				targetRequestId,
			}),
			options,
		);
		if (result.status !== "completed") {
			throw new BridgeConnectionError("protocol_failure", "Bridge cancellation did not complete");
		}
	}

	async updateAuthentication(
		authentication: BridgeAuthentication,
		options: BridgeControlRequestOptions = {},
	): Promise<void> {
		const result = await this.#controlRequest(
			(requestId) => ({
				type: "authentication_update",
				requestId,
				authentication,
			}),
			options,
		);
		if (result.status !== "completed") {
			throw new BridgeConnectionError(
				"protocol_failure",
				"Bridge authentication update did not complete",
			);
		}
	}

	async decideApproval(
		approvalId: string,
		decision: BridgeApprovalDecision,
		options: BridgeControlRequestOptions = {},
	): Promise<void> {
		await this.#completedControlRequest(
			(requestId) => ({
				type: "approval_decision",
				requestId,
				approvalId,
				decision,
			}),
			options,
		);
	}

	async writeSession(
		sessionId: string,
		data: string,
		options: BridgeControlRequestOptions = {},
	): Promise<BridgeResult> {
		return this.#completedControlRequest(
			(requestId) => ({
				type: "session_write",
				requestId,
				sessionId,
				data,
			}),
			options,
		);
	}

	async resizeSession(
		sessionId: string,
		columns: number,
		rows: number,
		options: BridgeControlRequestOptions = {},
	): Promise<BridgeResult> {
		return this.#completedControlRequest(
			(requestId) => ({
				type: "session_resize",
				requestId,
				sessionId,
				columns,
				rows,
			}),
			options,
		);
	}

	async terminateSession(
		sessionId: string,
		options: BridgeControlRequestOptions = {},
	): Promise<BridgeResult> {
		return this.#completedControlRequest(
			(requestId) => ({
				type: "session_terminate",
				requestId,
				sessionId,
			}),
			options,
		);
	}

	shutdown(options: BridgeControlRequestOptions = {}): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#shutdownPromise ??= this.#performShutdown(options);
		return this.#shutdownPromise;
	}

	async #performShutdown(options: BridgeControlRequestOptions): Promise<void> {
		this.#closing = true;
		try {
			const result = await this.#controlRequest(
				(requestId) => ({ type: "shutdown", requestId }),
				options,
				true,
			);
			if (result.status !== "completed") {
				throw new BridgeConnectionError("protocol_failure", "Bridge shutdown did not complete");
			}
		} finally {
			this.#options.transport.input.end();
			this.close();
		}
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		this.#closing = true;
		this.#closed = true;
		this.#ready = false;
		this.#options.transport.close();
		this.#rejectAll(new BridgeConnectionError("connection_closed", "Bridge connection was closed"));
	}

	async #initialize(): Promise<void> {
		const requestId = randomUUID();
		const handshake = new Promise<BridgeHandshake>((resolve, reject) => {
			this.#handshake = { requestId, resolve, reject };
		});
		const timeoutMs = this.#options.handshakeTimeoutMs ?? 10_000;
		const timeout = setTimeout(() => {
			this.#handshake?.reject(
				new BridgeConnectionError("handshake_timeout", "Bridge handshake timed out"),
			);
		}, timeoutMs);

		try {
			const authentication =
				this.#options.authentication === undefined
					? {}
					: { authentication: this.#options.authentication };
			await this.#write({
				type: "initialize",
				requestId,
				protocolVersion: BRIDGE_PROTOCOL_VERSION,
				client: { name: "pi-codex-adaptor", version: this.#options.clientVersion },
				...authentication,
			});
			await handshake;
			this.#ready = true;
		} finally {
			clearTimeout(timeout);
			this.#handshake = undefined;
		}
	}

	async #controlRequest(
		factory: (requestId: string) => ClientMessage,
		options: BridgeControlRequestOptions = {},
		allowClosing = false,
	): Promise<BridgeResult> {
		if (allowClosing) {
			this.#requireReadyOrClosing();
		} else {
			this.#requireReady();
		}
		if (options.signal?.aborted === true) {
			throw abortedControlError();
		}
		const requestId = randomUUID();
		const result = new Promise<BridgeResult>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve,
				reject,
				options: {},
				eventChain: Promise.resolve(),
			};
			if (options.signal !== undefined) {
				const abort = () => {
					this.#rejectPending(requestId, abortedControlError());
					this.#ignoreLateMessages(requestId);
				};
				options.signal.addEventListener("abort", abort, { once: true });
				pending.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
			}
			const timeoutMs = resolveControlTimeoutMs(
				options.timeoutMs,
				this.#options.controlRequestTimeoutMs,
			);
			const timeout = setTimeout(() => {
				this.#rejectPending(
					requestId,
					new BridgeConnectionError("control_timeout", "Bridge control operation timed out"),
				);
				this.#ignoreLateMessages(requestId);
			}, timeoutMs);
			pending.clearTimeout = () => clearTimeout(timeout);
			this.#pending.set(requestId, pending);
		});
		void this.#write(factory(requestId)).catch((error) => {
			this.#rejectPending(requestId, toError(error));
		});
		return result;
	}

	async #completedControlRequest(
		factory: (requestId: string) => ClientMessage,
		options: BridgeControlRequestOptions = {},
	): Promise<BridgeResult> {
		const result = await this.#controlRequest(factory, options);
		if (result.status !== "completed") {
			throw new BridgeConnectionError(
				"protocol_failure",
				"Bridge control operation did not complete",
			);
		}
		return result;
	}

	async #write(message: ClientMessage): Promise<void> {
		if (this.#closed) {
			throw new BridgeConnectionError("connection_closed", "Bridge connection is closed");
		}
		const frame = encodeClientMessage(message);
		await new Promise<void>((resolve, reject) => {
			this.#options.transport.input.write(Buffer.from(frame), (error?: Error | null) => {
				if (error === undefined || error === null) {
					resolve();
				} else {
					reject(new BridgeConnectionError("write_failed", "Bridge stdin write failed"));
				}
			});
		});
	}

	#receive(chunk: Uint8Array): void {
		if (this.#closed) {
			return;
		}
		try {
			for (const message of this.#decoder.push(chunk)) {
				this.#route(message);
			}
		} catch {
			this.#fail(
				new BridgeConnectionError("protocol_failure", "Bridge emitted an invalid protocol frame"),
			);
		}
	}

	#route(message: ServerMessage): void {
		if (!this.#ready) {
			this.#routeHandshake(message);
			return;
		}
		if (message.type === "handshake") {
			this.#fail(
				new BridgeConnectionError("protocol_failure", "Bridge emitted a duplicate handshake"),
			);
			return;
		}
		if (message.requestId !== undefined && this.#ignoredRequestIds.has(message.requestId)) {
			if (message.type === "result" || message.type === "error") {
				this.#ignoredRequestIds.delete(message.requestId);
			}
			return;
		}

		if (message.type === "error") {
			if (message.requestId === undefined) {
				this.#fail(new BridgeRemoteError(message.error));
			} else {
				this.#rejectPending(message.requestId, new BridgeRemoteError(message.error));
			}
			return;
		}

		const requestId = message.requestId;
		if (requestId === undefined) {
			this.#fail(
				new BridgeConnectionError(
					"protocol_failure",
					"Bridge emitted an uncorrelated request event",
				),
			);
			return;
		}
		const pending = this.#pending.get(requestId);
		if (pending === undefined) {
			this.#fail(
				new BridgeConnectionError(
					"protocol_failure",
					"Bridge emitted an event for an unknown request",
				),
			);
			return;
		}

		switch (message.type) {
			case "event":
				this.#enqueueHandler(requestId, pending, async () => {
					await pending.options.onEvent?.(message.event, message.sequence);
					await this.#write({
						type: "acknowledge",
						targetRequestId: requestId,
						sequence: message.sequence,
					});
				});
				break;
			case "approval_request":
				this.#enqueueHandler(requestId, pending, () =>
					pending.options.onApprovalRequest?.(message.approval),
				);
				break;
			case "backpressure":
				this.#enqueueHandler(requestId, pending, () =>
					pending.options.onBackpressure?.(message.state, message.pendingEvents),
				);
				break;
			case "result":
				void pending.eventChain.then(
					() => this.#resolvePending(requestId, message),
					(error) => this.#rejectPending(requestId, toError(error)),
				);
				break;
		}
	}

	#routeHandshake(message: ServerMessage): void {
		const pending = this.#handshake;
		if (pending === undefined) {
			this.#fail(
				new BridgeConnectionError(
					"protocol_failure",
					"Bridge emitted output before initialization",
				),
			);
			return;
		}
		if (message.type === "error" && message.requestId === pending.requestId) {
			pending.reject(new BridgeRemoteError(message.error));
			return;
		}
		if (message.type !== "handshake" || message.requestId !== pending.requestId) {
			pending.reject(
				new BridgeConnectionError(
					"protocol_failure",
					"Bridge emitted an invalid handshake response",
				),
			);
			return;
		}

		try {
			verifyHandshake(message.handshake, this.#options.buildTarget, {
				allowDevelopmentBuild: this.#options.allowDevelopmentBuild === true,
				...(this.#options.expectedBuildSourceCommit === undefined
					? {}
					: { expectedBuildSourceCommit: this.#options.expectedBuildSourceCommit }),
			});
			pending.resolve(message.handshake);
		} catch {
			pending.reject(
				new BridgeConnectionError(
					"protocol_failure",
					"Bridge identity does not match the product contract",
				),
			);
		}
	}

	#enqueueHandler(
		_requestId: string,
		pending: PendingRequest,
		handler: () => void | Promise<void>,
	): void {
		pending.eventChain = pending.eventChain.then(handler).catch(() => {
			const error = new BridgeConnectionError(
				"event_handler_failed",
				"Bridge event handler failed",
			);
			this.#fail(error);
		});
	}

	#resolvePending(requestId: string, message: Extract<ServerMessage, { type: "result" }>): void {
		const pending = this.#pending.get(requestId);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(requestId);
		this.#cleanupPending(pending);
		pending.resolve({ status: message.status, result: message.result });
	}

	#rejectPending(requestId: string, error: Error): void {
		const pending = this.#pending.get(requestId);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(requestId);
		this.#cleanupPending(pending);
		pending.reject(error);
	}

	#cleanupPending(pending: PendingRequest): void {
		pending.removeAbortListener?.();
		pending.clearTimeout?.();
		delete pending.removeAbortListener;
		delete pending.clearTimeout;
	}

	#ignoreLateMessages(requestId: string): void {
		const maximumIgnoredRequestIds = 65_536;
		if (
			!this.#ignoredRequestIds.has(requestId) &&
			this.#ignoredRequestIds.size >= maximumIgnoredRequestIds
		) {
			this.#fail(
				new BridgeConnectionError(
					"connection_closed",
					"Bridge cancellation tracking limit was exceeded",
				),
			);
			return;
		}
		this.#ignoredRequestIds.add(requestId);
	}

	#rejectAll(error: Error): void {
		this.#handshake?.reject(error);
		for (const requestId of this.#pending.keys()) {
			this.#rejectPending(requestId, error);
		}
	}

	#outputEnded(): void {
		try {
			this.#decoder.finish();
		} catch {
			this.#fail(
				new BridgeConnectionError("protocol_failure", "Bridge output ended with a partial frame"),
			);
			return;
		}
		this.#fail(new BridgeConnectionError("connection_closed", "Bridge output ended"));
	}

	#transportClosed(): void {
		this.#fail(
			new BridgeConnectionError("connection_closed", "Bridge process closed unexpectedly"),
		);
	}

	#fail(error: Error): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		this.#ready = false;
		this.#rejectAll(error);
		this.#options.transport.close();
	}

	#requireReady(): void {
		if (!this.isReady || this.#closing) {
			throw new BridgeConnectionError("connection_closed", "Bridge connection is not ready");
		}
	}

	#requireReadyOrClosing(): void {
		if ((!this.#ready && !this.#closing) || this.#closed) {
			throw new BridgeConnectionError("connection_closed", "Bridge connection is not ready");
		}
	}
}

export function spawnBridgeTransport(executablePath: string): BridgeTransport {
	const child = spawn(executablePath, ["serve"], {
		env: createBridgeChildEnvironment(),
		shell: false,
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
	});
	let closed = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		if (closed) {
			return;
		}
		closed = true;
		for (const listener of listeners) {
			listener();
		}
	};
	child.once("error", notify);
	child.once("exit", notify);

	return {
		input: child.stdin,
		output: child.stdout,
		close: () => {
			if (!closed) {
				child.kill();
			}
		},
		onClose: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function toError(error: unknown): Error {
	return error instanceof Error
		? error
		: new BridgeConnectionError("protocol_failure", "Bridge operation failed");
}

function abortedRequestError(): DOMException {
	return new DOMException("The bridge request was aborted", "AbortError");
}

function abortedControlError(): DOMException {
	return new DOMException("The bridge control operation was aborted", "AbortError");
}

function resolveControlTimeoutMs(
	requested: number | undefined,
	configured: number | undefined,
): number {
	for (const value of [requested, configured]) {
		if (Number.isSafeInteger(value) && (value ?? 0) > 0) return value as number;
	}
	return 30_000;
}

export { createBridgeChildEnvironment, isCredentialEnvironmentVariable } from "./environment.ts";

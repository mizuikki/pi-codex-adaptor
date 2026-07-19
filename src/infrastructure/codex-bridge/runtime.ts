import type {
	CodexRuntime,
	CompactResponseOptions,
	CreateResponseOptions,
	CreateResponseResult,
	ExecuteToolOptions,
} from "../../application/codex-runtime.ts";
import { connectBundledBridge } from "./binary.ts";
import {
	type BridgeApprovalDecision,
	type BridgeClient,
	BridgeConnectionError,
	BridgeRemoteError,
} from "./client.ts";
import { buildToolsExecuteParams } from "./tool-execute-params.ts";

export interface BundledCodexRuntimeOptions {
	packageRoot: string;
	clientVersion: string;
	allowDevelopmentBuild?: boolean;
	executable?: string;
	buildTarget?: string;
	/**
	 * Optional bridge opener used by unit tests. Production always loads the
	 * packaged or development sidecar through `connectBundledBridge`.
	 */
	openBridge?: () => Promise<BridgeClient>;
}

export class BundledCodexRuntime implements CodexRuntime {
	readonly #options: BundledCodexRuntimeOptions;
	#client: BridgeClient | undefined;
	#connecting: Promise<BridgeClient> | undefined;
	readonly #models = new Map<string, unknown>();

	constructor(options: BundledCodexRuntimeOptions) {
		this.#options = options;
	}

	async createResponse(options: CreateResponseOptions): Promise<CreateResponseResult> {
		const client = await this.#connect();
		try {
			return await client.request(
				"responses.create",
				{
					connection: options.connection,
					request: options.request,
					transportMode: options.transportMode,
					providerSupportsWebsockets: options.providerSupportsWebsockets,
				},
				{
					...(options.signal === undefined ? {} : { signal: options.signal }),
					onEvent: options.onEvent,
				},
			);
		} catch (error) {
			this.#discardClientIfFatal(client, error);
			throw error;
		}
	}

	async compact(options: CompactResponseOptions): Promise<CreateResponseResult> {
		const client = await this.#connect();
		try {
			return await client.request(
				"responses.compact",
				{
					connection: options.connection,
					request: options.request,
					implementation: options.implementation,
					transportMode: options.transportMode,
					providerSupportsWebsockets: options.providerSupportsWebsockets,
				},
				options.signal === undefined ? {} : { signal: options.signal },
			);
		} catch (error) {
			this.#discardClientIfFatal(client, error);
			throw error;
		}
	}

	async readDiagnostics(): Promise<unknown> {
		const client = await this.#connect();
		try {
			const result = await client.request("diagnostics.read", {});
			if (result.status !== "completed") {
				throw new Error("Native diagnostics did not complete");
			}
			return result.result;
		} catch (error) {
			this.#discardClientIfFatal(client, error);
			throw error;
		}
	}

	async resolveModel(modelId: string): Promise<unknown> {
		const cached = this.#models.get(modelId);
		if (cached !== undefined) return cached;
		const client = await this.#connect();
		try {
			const result = await client.request("models.resolve", {
				modelId,
			});
			if (result.status !== "completed") {
				throw new Error("Native model metadata resolution did not complete");
			}
			this.#models.set(modelId, result.result);
			return result.result;
		} catch (error) {
			this.#discardClientIfFatal(client, error);
			throw error;
		}
	}

	async resolveTools(params: unknown): Promise<unknown> {
		const client = await this.#connect();
		try {
			const result = await client.request("tools.resolve", params);
			if (result.status !== "completed") {
				throw new Error("Native tool surface resolution did not complete");
			}
			return result.result;
		} catch (error) {
			this.#discardClientIfFatal(client, error);
			throw error;
		}
	}

	async executeTool(options: ExecuteToolOptions): Promise<CreateResponseResult> {
		const client = await this.#connect();
		try {
			const params = buildToolsExecuteParams({
				tool: options.tool,
				argumentsValue: options.argumentsValue,
				workdir: options.workdir,
				workspaceRoots: options.workspaceRoots,
			});
			if (isNetworkTool(options.tool) && options.connection !== undefined) {
				params.connection = options.connection;
			}
			return await client.request("tools.execute", params, {
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
				onApprovalRequest: async (approval) => {
					await this.#handleApprovalRequest(client, options, approval);
				},
			});
		} catch (error) {
			this.#discardClientIfFatal(client, error);
			throw error;
		}
	}

	async shutdown(): Promise<void> {
		const client = this.#client;
		this.#forgetClient();
		if (client !== undefined) {
			await client.shutdown();
		}
	}

	async #handleApprovalRequest(
		client: BridgeClient,
		options: ExecuteToolOptions,
		approval: {
			approvalId: string;
			operation: "command" | "patch" | "filesystem" | "network";
			summary: string;
			details: unknown;
			availableDecisions: readonly ("allow_once" | "allow_session" | "decline" | "cancel")[];
		},
	): Promise<void> {
		// Race the Pi approval UI against the request AbortSignal. On abort the UI
		// is disposed fail-closed and no decision is sent for the expired id.
		if (isSignalAborted(options.signal)) {
			return;
		}
		let decision: BridgeApprovalDecision = "decline";
		try {
			decision = (await raceWithAbort(
				Promise.resolve(options.onApproval?.(approval) ?? "decline"),
				options.signal,
			)) as BridgeApprovalDecision;
		} catch (error) {
			if (isAbortError(error) || isSignalAborted(options.signal)) {
				return;
			}
			throw error;
		}
		if (isSignalAborted(options.signal)) {
			return;
		}
		try {
			await client.decideApproval(
				approval.approvalId,
				decision,
				options.signal === undefined ? {} : { signal: options.signal },
			);
		} catch (error) {
			// Late/unknown approvals after cancel must not fail the bridge connection.
			if (isExpiredApprovalError(error) || isSignalAborted(options.signal)) {
				return;
			}
			throw error;
		}
	}

	async #connect(): Promise<BridgeClient> {
		if (this.#client !== undefined && !this.#client.isReady) {
			// Fatally failed clients are discarded so the next request reconnects.
			this.#forgetClient();
		}
		if (this.#client !== undefined) {
			return this.#client;
		}
		if (this.#connecting !== undefined) {
			const client = await this.#connecting;
			if (!client.isReady) {
				this.#forgetClient();
				return this.#connect();
			}
			return client;
		}
		this.#connecting =
			this.#options.openBridge !== undefined
				? this.#options.openBridge()
				: connectBundledBridge({
						packageRoot: this.#options.packageRoot,
						clientVersion: this.#options.clientVersion,
						...(this.#options.allowDevelopmentBuild === undefined
							? {}
							: { allowDevelopmentBuild: this.#options.allowDevelopmentBuild }),
						...(this.#options.executable === undefined
							? {}
							: { executable: this.#options.executable }),
						...(this.#options.buildTarget === undefined
							? {}
							: { buildTarget: this.#options.buildTarget as never }),
					});
		try {
			this.#client = await this.#connecting;
			return this.#client;
		} finally {
			this.#connecting = undefined;
		}
	}

	#discardClientIfFatal(client: BridgeClient, _error: unknown): void {
		if (client !== this.#client) {
			return;
		}
		// BridgeClient marks itself not-ready on fatal connection failures. Drop the
		// reference so the next request reconnects with a fresh process and handshake.
		if (!client.isReady) {
			this.#forgetClient();
		}
	}

	#forgetClient(): void {
		this.#client = undefined;
		this.#connecting = undefined;
		this.#models.clear();
	}
}

function isNetworkTool(tool: string): boolean {
	return tool === "web.run" || tool === "image_gen.imagegen";
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
	return Boolean(signal?.aborted);
}

function isExpiredApprovalError(error: unknown): boolean {
	if (error instanceof BridgeRemoteError) {
		return error.code === "unknown_approval";
	}
	if (error instanceof BridgeConnectionError) {
		// decideApproval may surface protocol_failure when the native side
		// completes an expired decision with a non-completed status.
		return error.code === "protocol_failure";
	}
	return false;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) {
		return promise;
	}
	if (signal.aborted) {
		throw new DOMException("The bridge request was aborted", "AbortError");
	}
	return await new Promise<T>((resolve, reject) => {
		const abort = () => {
			reject(new DOMException("The bridge request was aborted", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

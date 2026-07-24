import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import type {
	CodexProviderAuthentication,
	CodexProviderConnection,
} from "../../application/codex-runtime.ts";
import type { EffectiveCapabilitySnapshot } from "../../application/resolve-effective-capabilities.ts";
import {
	isStrictJsonArray,
	isStrictJsonValue,
	isStrictPlainRecord,
} from "../../application/structured-json.ts";
import type { CodexConfig } from "../../domain/config.ts";

export interface CodexProviderRequestRecordInput {
	readonly options: SimpleStreamOptions;
	readonly sessionId: string;
	readonly model: Model<string>;
	readonly context: Context;
	readonly request: Record<string, unknown>;
	readonly inputLedger: readonly unknown[];
	readonly connection: CodexProviderConnection;
	readonly config: CodexConfig;
	readonly capabilities: EffectiveCapabilitySnapshot;
	readonly signal?: AbortSignal;
}

export type CodexProviderModelSnapshot = Readonly<
	Pick<Model<string>, "id" | "provider" | "api" | "contextWindow">
>;

export type CodexProviderRequestRecord = Omit<CodexProviderRequestRecordInput, "model"> & {
	readonly model: CodexProviderModelSnapshot;
	readonly generation: number;
	readonly requestDigest: string;
	approvedRequest?: Record<string, unknown>;
	approvedDigest?: string;
	closed: boolean;
};

const RECORD_UNAVAILABLE = "Codex provider request approval is unavailable";
const RECORD_REJECTED = "Codex provider request failed approval";

/**
 * Extension-instance-local request provenance and final payload approval.
 *
 * The async-local scope is opened by the selected session dispatcher and covers the
 * awaited Pi `onPayload` callback. It is intentionally not stored in the process-wide
 * router slot or keyed by session id, because one session can have overlapping synthetic callbacks.
 */
export class CodexProviderRequestGuard {
	readonly #storage = new AsyncLocalStorage<CodexProviderRequestRecord>();
	readonly #records = new Map<number, CodexProviderRequestRecord>();
	#nextGeneration = 0;
	#disposed = false;

	open(input: CodexProviderRequestRecordInput): CodexProviderRequestRecord {
		if (this.#disposed) throw new Error(RECORD_UNAVAILABLE);
		const generation = ++this.#nextGeneration;
		const record: CodexProviderRequestRecord = {
			...input,
			options: snapshotSimpleStreamOptions(input.options) ?? input.options,
			model: snapshotProviderModel(input.model),
			connection: cloneConnection(input.connection),
			inputLedger: cloneFrozenJson(input.inputLedger),
			config: cloneFrozenJson(input.config),
			capabilities: cloneFrozenJson(input.capabilities),
			generation,
			requestDigest: digestJson(input.request),
			closed: false,
		};
		this.#records.set(generation, record);
		return record;
	}

	async run<T>(record: CodexProviderRequestRecord, callback: () => Promise<T> | T): Promise<T> {
		this.assertLive(record);
		return this.#storage.run(record, async () => callback());
	}

	current(): CodexProviderRequestRecord | undefined {
		return this.#storage.getStore();
	}

	approve(
		record: CodexProviderRequestRecord,
		request: Record<string, unknown>,
	): Record<string, unknown> {
		this.assertLive(record);
		if (this.current() !== record) throw new Error(RECORD_REJECTED);
		const frozen = deepFreeze(request);
		record.approvedRequest = frozen;
		record.approvedDigest = digestJson(frozen);
		return frozen;
	}

	assertApproved(record: CodexProviderRequestRecord, request: unknown): Record<string, unknown> {
		this.assertLive(record);
		if (
			record.approvedRequest === undefined ||
			record.approvedDigest === undefined ||
			!isRecord(request) ||
			digestJson(request) !== record.approvedDigest
		) {
			throw new Error(RECORD_REJECTED);
		}
		return record.approvedRequest;
	}

	consume(record: CodexProviderRequestRecord): void {
		if (record.closed) return;
		record.closed = true;
		this.#records.delete(record.generation);
	}

	invalidateSession(sessionId: string): void {
		for (const record of this.#records.values()) {
			if (record.sessionId === sessionId) this.#close(record);
		}
	}

	invalidateAll(): void {
		for (const record of this.#records.values()) this.#close(record);
	}

	dispose(): void {
		this.#disposed = true;
		this.invalidateAll();
	}

	assertRoute(record: CodexProviderRequestRecord, hookSessionId: string): void {
		this.assertLive(record);
		if (record.sessionId !== hookSessionId) throw new Error(RECORD_REJECTED);
	}

	get activeRecordCount(): number {
		return this.#records.size;
	}

	#close(record: CodexProviderRequestRecord): void {
		record.closed = true;
		this.#records.delete(record.generation);
	}

	assertLive(record: CodexProviderRequestRecord): void {
		if (
			this.#disposed ||
			record.closed ||
			this.#records.get(record.generation) !== record ||
			record.signal?.aborted === true ||
			record.options.signal?.aborted === true
		) {
			throw new Error(RECORD_REJECTED);
		}
	}
}

function snapshotProviderModel(model: Model<string>): CodexProviderModelSnapshot {
	if (
		typeof model.id !== "string" ||
		typeof model.provider !== "string" ||
		typeof model.api !== "string" ||
		typeof model.contextWindow !== "number" ||
		!Number.isFinite(model.contextWindow)
	) {
		throw new Error(RECORD_UNAVAILABLE);
	}
	return Object.freeze({
		id: model.id,
		provider: model.provider,
		api: model.api,
		contextWindow: model.contextWindow,
	});
}

export function snapshotSimpleStreamOptions(
	options: SimpleStreamOptions | undefined,
): SimpleStreamOptions | undefined {
	if (options === undefined) return undefined;
	const snapshot = cloneOptionRecord(
		options as unknown as Record<string, unknown>,
	) as SimpleStreamOptions;
	return deepFreeze(snapshot);
}

export function sessionFingerprint(sessionId: string): string {
	return sha256(`pi-codex-adaptor/session/v1/${sessionId}`);
}

export function credentialFingerprint(credential: string): string {
	return sha256(`pi-codex-adaptor/credential/v1/${credential}`);
}

export function accountFingerprint(accountId: string): string {
	return sha256(`pi-codex-adaptor/jwt-account/v1/${accountId}`);
}

export function authenticationSummary(
	authentication: CodexProviderAuthentication,
	accountId: string | undefined,
	accountIdSource: "header" | "jwt" | undefined,
): { kind: "jwt_account" | "credential"; fingerprint: string } | undefined {
	if (authentication.kind !== "bearer") return undefined;
	const verifiedAccount = extractAccountClaim(authentication.token);
	if (
		verifiedAccount !== undefined &&
		accountIdSource === "header" &&
		accountId !== verifiedAccount
	) {
		return undefined;
	}
	if (verifiedAccount !== undefined) {
		return { kind: "jwt_account", fingerprint: accountFingerprint(verifiedAccount) };
	}
	return { kind: "credential", fingerprint: credentialFingerprint(authentication.token) };
}

export function digestJson(value: unknown): string {
	if (!isStrictJsonValue(value)) throw new Error(RECORD_REJECTED);
	return sha256(JSON.stringify(sortJson(value)));
}

export function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		if (!isStrictJsonArray(value)) throw new Error(RECORD_REJECTED);
		Object.freeze(value);
		for (let index = 0; index < value.length; index += 1) deepFreeze(value[index]);
		return value;
	}
	if (!isRecord(value)) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype === Object.prototype || prototype === null) throw new Error(RECORD_REJECTED);
		return value;
	}
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

function cloneOptionRecord(value: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(RECORD_UNAVAILABLE);
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value)) result[key] = cloneOptionValue(value[key]);
	return result;
}

function cloneOptionValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		if (!isStrictJsonArray(value)) throw new Error(RECORD_UNAVAILABLE);
		return value.map(cloneOptionValue);
	}
	if (isRecord(value)) return cloneOptionRecord(value);
	return value;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortJson(value[key])]),
		);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isStrictPlainRecord(value);
}

function cloneFrozenJson<T>(value: T): T {
	if (!isStrictJsonValue(value)) throw new Error(RECORD_UNAVAILABLE);
	return deepFreeze(structuredClone(value));
}

function cloneConnection(connection: CodexProviderConnection): CodexProviderConnection {
	return Object.freeze(cloneFrozenJson(connection));
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value: string): string {
	return `sha256:${sha256Hex(value)}`;
}

function extractAccountClaim(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) return undefined;
	try {
		const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(
			atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
		) as unknown;
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") return undefined;
		return auth.chatgpt_account_id.length > 0 ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

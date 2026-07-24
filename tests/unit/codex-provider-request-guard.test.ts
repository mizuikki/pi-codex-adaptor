import { describe, expect, test } from "bun:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import type { EffectiveCapabilitySnapshot } from "../../src/application/resolve-effective-capabilities.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import type { CodexProviderRequestRecordInput } from "../../src/integration/pi/codex-provider-request-guard.ts";
import {
	authenticationSummary,
	CodexProviderRequestGuard,
	snapshotSimpleStreamOptions,
} from "../../src/integration/pi/codex-provider-request-guard.ts";
import { createProviderConnection } from "../../src/integration/pi/provider-connection.ts";

const model: Model<string> = {
	id: "fixture-model",
	name: "Fixture model",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://invalid.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

const context = { messages: [] } as unknown as Context;
const capabilities = {} as EffectiveCapabilitySnapshot;
const config = createDefaultConfig();

function jwt(accountId: string, marker: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.${marker}`;
}

function openRecord(
	guard: CodexProviderRequestGuard,
	sessionId: string,
	options: SimpleStreamOptions = { sessionId },
) {
	return guard.open({
		...openRecordInput(sessionId),
		options: snapshotSimpleStreamOptions(options) ?? { sessionId },
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

function openRecordInput(sessionId: string): CodexProviderRequestRecordInput {
	return {
		options: { sessionId },
		sessionId,
		model,
		context,
		request: { model: model.id, input: [{ type: "message", role: "user", content: [] }] },
		inputLedger: [{ type: "message", role: "user", content: [] }],
		connection: createProviderConnection(model, { apiKey: "synthetic-credential" }),
		config,
		capabilities,
	};
}

describe("Codex provider request guard", () => {
	test("snapshots caller-owned options synchronously and preserves signals/functions", () => {
		const callback = () => undefined;
		const source: SimpleStreamOptions = {
			sessionId: "session-source",
			headers: { "X-Synthetic": "before" },
			onPayload: callback,
		};
		const snapshot = snapshotSimpleStreamOptions(source);
		if (snapshot === undefined) throw new Error("snapshot missing");
		const sourceHeaders = source.headers as Record<string, string>;
		sourceHeaders["X-Synthetic"] = "after";
		expect(snapshot.sessionId).toBe("session-source");
		expect(snapshot.headers).toEqual({ "X-Synthetic": "before" });
		expect(snapshot.onPayload).toBe(callback);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.headers)).toBe(true);
		const accessor = {} as SimpleStreamOptions;
		Object.defineProperty(accessor, "sessionId", {
			enumerable: true,
			get: () => "session-accessor",
		});
		expect(() => snapshotSimpleStreamOptions(accessor)).toThrow();
	});

	test("snapshots only replay-relevant model identity from Pi model records", () => {
		const guard = new CodexProviderRequestGuard();
		const piModel = { ...model, headers: undefined } as unknown as Model<string>;
		const record = guard.open({
			...openRecordInput("session-model-snapshot"),
			model: piModel,
		});
		expect(record.model).toEqual({
			id: model.id,
			provider: model.provider,
			api: model.api,
			contextWindow: model.contextWindow,
		});
		expect(Object.isFrozen(record.model)).toBe(true);
		expect("headers" in record.model).toBe(false);
	});

	test("keeps exact overlapping request identity inside AsyncLocalStorage", async () => {
		const guard = new CodexProviderRequestGuard();
		const first = openRecord(guard, "session-same", { sessionId: "session-same" });
		const second = openRecord(guard, "session-same", { sessionId: "session-same" });
		const firstSeen: unknown[] = [];
		const secondSeen: unknown[] = [];
		const run = (record: typeof first) =>
			guard.run(record, async () => {
				const seen = record === first ? firstSeen : secondSeen;
				seen.push(guard.current());
				await Promise.resolve();
				seen.push(guard.current());
			});
		await Promise.all([run(first), run(second)]);
		expect(firstSeen).toEqual([first, first]);
		expect(secondSeen).toEqual([second, second]);
		expect(guard.current()).toBeUndefined();
		expect(guard.activeRecordCount).toBe(2);
	});

	test("requires structurally unchanged current approval before dispatch", async () => {
		const guard = new CodexProviderRequestGuard();
		const record = openRecord(guard, "session-approval");
		const request = { model: model.id, input: [{ type: "message", role: "user", content: [] }] };
		const approved = await guard.run(record, () => guard.approve(record, request));
		expect(approved).toBe(request);
		expect(Object.isFrozen(approved)).toBe(true);
		expect(Object.isFrozen(approved.input)).toBe(true);
		expect(guard.assertApproved(record, approved)).toBe(approved);
		expect(guard.assertApproved(record, structuredClone(approved))).toBe(approved);
		expect(() => guard.assertApproved(record, { ...approved, model: "changed" })).toThrow(
			"approval",
		);
		guard.consume(record);
		expect(() => guard.assertApproved(record, approved)).toThrow("approval");
	});

	test("rejects unsafe request and ledger records before approval", () => {
		const guard = new CodexProviderRequestGuard();
		const unsafeRequest = {
			model: model.id,
			input: [{ type: "message", role: "user", content: [] }],
		} as Record<string, unknown>;
		Object.defineProperty(unsafeRequest, "model", {
			enumerable: true,
			get: () => model.id,
		});
		expect(() =>
			guard.open({
				...openRecordInput("session-unsafe"),
				request: unsafeRequest,
			}),
		).toThrow();
		const sparse = new Array(2);
		sparse[1] = { type: "message" };
		expect(() =>
			guard.open({
				...openRecordInput("session-sparse"),
				inputLedger: sparse,
			}),
		).toThrow();
	});

	test("disposal and session invalidation reject stale generations", () => {
		const guard = new CodexProviderRequestGuard();
		const session = openRecord(guard, "session-invalidated");
		const other = openRecord(guard, "session-other");
		guard.invalidateSession("session-invalidated");
		expect(() => guard.assertLive(session)).toThrow("approval");
		expect(() => guard.assertLive(other)).not.toThrow();
		guard.dispose();
		expect(() => openRecord(guard, "session-after-dispose")).toThrow();
	});
});

describe("provider-bound authentication", () => {
	test("uses the verified account claim across JWT refresh", () => {
		const first = createProviderConnection(model, { apiKey: jwt("account-fixture", "first") });
		const second = createProviderConnection(model, { apiKey: jwt("account-fixture", "second") });
		const firstBinding = authenticationSummary(
			first.authentication,
			first.accountId,
			first.accountIdSource,
		);
		const secondBinding = authenticationSummary(
			second.authentication,
			second.accountId,
			second.accountIdSource,
		);
		expect(firstBinding).toEqual(secondBinding);
		expect(firstBinding?.kind).toBe("jwt_account");
	});

	test("rejects conflicting explicit account headers and binds opaque credentials exactly", () => {
		const conflict = createProviderConnection(model, {
			apiKey: jwt("account-fixture", "signed"),
			headers: { "chatgpt-account-id": "other-account" },
		});
		expect(
			authenticationSummary(conflict.authentication, conflict.accountId, conflict.accountIdSource),
		).toBeUndefined();
		const first = createProviderConnection(model, { apiKey: "synthetic-key-one" });
		const second = createProviderConnection(model, { apiKey: "synthetic-key-two" });
		const firstBinding = authenticationSummary(
			first.authentication,
			first.accountId,
			first.accountIdSource,
		);
		const secondBinding = authenticationSummary(
			second.authentication,
			second.accountId,
			second.accountIdSource,
		);
		expect(firstBinding?.kind).toBe("credential");
		expect(firstBinding).not.toEqual(secondBinding);
		expect(authenticationSummary({ kind: "none" }, undefined, undefined)).toBeUndefined();
	});
});

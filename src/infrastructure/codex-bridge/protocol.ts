import Type from "typebox";
import Schema from "typebox/schema";

import {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
} from "./identity.ts";

export {
	BRIDGE_PROTOCOL_VERSION,
	OFFICIAL_CODEX_TAG,
	OFFICIAL_CODEX_VERSION,
	OFFICIAL_SOURCE_COMMIT,
	VENDOR_TREE_SHA256,
};
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_PENDING_EVENTS = 256;

const RequestId = Type.String({ minLength: 1, maxLength: 256 });
const Sequence = Type.Integer({ minimum: 0, maximum: 4_294_967_295 });
const UnknownPayload = Type.Unknown();

const Authentication = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("oauth_bearer"),
			token: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
			accountId: Type.String({ minLength: 1, maxLength: 256 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("openai_api_key"),
			apiKey: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
		},
		{ additionalProperties: false },
	),
]);

const ApprovalDecision = Type.Union([
	Type.Literal("allow_once"),
	Type.Literal("allow_session"),
	Type.Literal("decline"),
	Type.Literal("cancel"),
]);

const RequestMethod = Type.Union([
	Type.Literal("responses.create"),
	Type.Literal("responses.compact"),
	Type.Literal("models.resolve"),
	Type.Literal("tools.resolve"),
	Type.Literal("tools.execute"),
	Type.Literal("diagnostics.read"),
]);

export const ClientMessageSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("initialize"),
			requestId: RequestId,
			protocolVersion: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
			client: Type.Object(
				{
					name: Type.String({ minLength: 1, maxLength: 256 }),
					version: Type.String({ minLength: 1, maxLength: 256 }),
				},
				{ additionalProperties: false },
			),
			authentication: Type.Optional(Authentication),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("authentication_update"),
			requestId: RequestId,
			authentication: Authentication,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("request"),
			requestId: RequestId,
			method: RequestMethod,
			params: UnknownPayload,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("cancel"),
			requestId: RequestId,
			targetRequestId: RequestId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("approval_decision"),
			requestId: RequestId,
			approvalId: RequestId,
			decision: ApprovalDecision,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("session_write"),
			requestId: RequestId,
			sessionId: RequestId,
			data: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("session_resize"),
			requestId: RequestId,
			sessionId: RequestId,
			columns: Type.Integer({ minimum: 1, maximum: 65_535 }),
			rows: Type.Integer({ minimum: 1, maximum: 65_535 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("session_terminate"),
			requestId: RequestId,
			sessionId: RequestId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("acknowledge"),
			targetRequestId: RequestId,
			sequence: Sequence,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("shutdown"),
			requestId: RequestId,
		},
		{ additionalProperties: false },
	),
]);

const BridgeCapability = Type.Union([
	Type.Literal("responses_sse"),
	Type.Literal("responses_websocket"),
	Type.Literal("remote_compaction_v2"),
	Type.Literal("compact_endpoint"),
	Type.Literal("model_metadata"),
	Type.Literal("update_plan"),
	Type.Literal("unified_exec"),
	Type.Literal("shell_command"),
	Type.Literal("apply_patch"),
	Type.Literal("view_image"),
	Type.Literal("image_generation"),
	Type.Literal("standalone_web_search"),
	Type.Literal("hosted_web_search"),
]);

const TerminalStatus = Type.Union([
	Type.Literal("completed"),
	Type.Literal("incomplete"),
	Type.Literal("failed"),
	Type.Literal("aborted"),
	Type.Literal("timed_out"),
]);

const BridgeError = Type.Object(
	{
		category: Type.Union([
			Type.Literal("ConfigurationError"),
			Type.Literal("AuthenticationError"),
			Type.Literal("ProtocolError"),
			Type.Literal("CapabilityError"),
			Type.Literal("NativeToolError"),
		]),
		code: Type.String({ minLength: 1, maxLength: 256 }),
		message: Type.String({ maxLength: 4_096 }),
		retryable: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const ApprovalRequest = Type.Object(
	{
		approvalId: RequestId,
		operation: Type.Union([
			Type.Literal("command"),
			Type.Literal("patch"),
			Type.Literal("filesystem"),
			Type.Literal("network"),
		]),
		summary: Type.String({ maxLength: 4_096 }),
		details: UnknownPayload,
		availableDecisions: Type.Array(ApprovalDecision, { minItems: 1, uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export const ServerMessageSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("handshake"),
			requestId: RequestId,
			handshake: Type.Object(
				{
					bridgeProtocolVersion: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
					officialCodexVersion: Type.String({ minLength: 1 }),
					officialCodexTag: Type.String({ minLength: 1 }),
					officialSourceCommit: Type.String({ pattern: "^[0-9a-f]{40}$" }),
					buildTarget: Type.String({ minLength: 1, maxLength: 256 }),
					buildSourceCommit: Type.Union([
						Type.String({ pattern: "^[0-9a-f]{40}$" }),
						Type.Literal("development"),
					]),
					vendorTreeSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
					maxFrameBytes: Type.Integer({ minimum: 1 }),
					maxPendingEvents: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
					capabilities: Type.Array(BridgeCapability, { uniqueItems: true }),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("event"),
			requestId: RequestId,
			sequence: Sequence,
			event: UnknownPayload,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("result"),
			requestId: RequestId,
			status: TerminalStatus,
			result: UnknownPayload,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("error"),
			requestId: Type.Optional(RequestId),
			error: BridgeError,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("approval_request"),
			requestId: RequestId,
			approval: ApprovalRequest,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("backpressure"),
			requestId: Type.Optional(RequestId),
			state: Type.Union([Type.Literal("paused"), Type.Literal("resumed")]),
			pendingEvents: Type.Integer({ minimum: 0, maximum: 4_294_967_295 }),
			capacity: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }),
		},
		{ additionalProperties: false },
	),
]);

export type ClientMessage = Type.Static<typeof ClientMessageSchema>;
export type ServerMessage = Type.Static<typeof ServerMessageSchema>;
export type BridgeHandshake = Extract<ServerMessage, { type: "handshake" }>["handshake"];

const clientMessageValidator = Schema.Compile(ClientMessageSchema);
const serverMessageValidator = Schema.Compile(ServerMessageSchema);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class BridgeProtocolError extends Error {
	readonly code:
		| "empty_frame"
		| "frame_too_large"
		| "handshake_mismatch"
		| "invalid_frame"
		| "multiple_frames"
		| "truncated_frame";

	constructor(code: BridgeProtocolError["code"], message: string) {
		super(message);
		this.name = "BridgeProtocolError";
		this.code = code;
	}
}

export interface HandshakeVerificationOptions {
	allowDevelopmentBuild?: boolean;
	expectedBuildSourceCommit?: string;
}

export function verifyHandshake(
	handshake: BridgeHandshake,
	expectedBuildTarget: string,
	options: HandshakeVerificationOptions = {},
): void {
	const expectedFields: ReadonlyArray<readonly [keyof BridgeHandshake, unknown]> = [
		["bridgeProtocolVersion", BRIDGE_PROTOCOL_VERSION],
		["officialCodexVersion", OFFICIAL_CODEX_VERSION],
		["officialCodexTag", OFFICIAL_CODEX_TAG],
		["officialSourceCommit", OFFICIAL_SOURCE_COMMIT],
		["buildTarget", expectedBuildTarget],
		["vendorTreeSha256", VENDOR_TREE_SHA256],
		["maxFrameBytes", MAX_FRAME_BYTES],
		["maxPendingEvents", MAX_PENDING_EVENTS],
	];

	for (const [field, expected] of expectedFields) {
		if (handshake[field] !== expected) {
			throw new BridgeProtocolError(
				"handshake_mismatch",
				`Bridge handshake field ${field} does not match the product contract`,
			);
		}
	}

	if (
		handshake.buildSourceCommit === "development"
			? options.allowDevelopmentBuild !== true
			: !/^[0-9a-f]{40}$/.test(handshake.buildSourceCommit)
	) {
		throw new BridgeProtocolError(
			"handshake_mismatch",
			"Bridge handshake build source identity is invalid",
		);
	}
	if (
		options.expectedBuildSourceCommit !== undefined &&
		handshake.buildSourceCommit !== options.expectedBuildSourceCommit
	) {
		throw new BridgeProtocolError(
			"handshake_mismatch",
			"Bridge handshake build source does not match the package artifact",
		);
	}
}

export class ServerFrameDecoder {
	readonly #chunks: Uint8Array[] = [];
	#pendingBytes = 0;

	push(chunk: Uint8Array): ServerMessage[] {
		const messages: ServerMessage[] = [];
		let offset = 0;

		for (let index = 0; index < chunk.byteLength; index += 1) {
			if (chunk[index] !== 10) {
				continue;
			}

			this.#append(chunk.subarray(offset, index));
			const frame = new Uint8Array(this.#pendingBytes + 1);
			let frameOffset = 0;
			for (const part of this.#chunks) {
				frame.set(part, frameOffset);
				frameOffset += part.byteLength;
			}
			frame[this.#pendingBytes] = 10;

			this.#reset();
			messages.push(decodeServerFrame(frame));
			offset = index + 1;
		}

		this.#append(chunk.subarray(offset));
		return messages;
	}

	finish(): void {
		if (this.#pendingBytes !== 0) {
			this.#reset();
			throw new BridgeProtocolError(
				"truncated_frame",
				"Bridge output ended with an unterminated JSONL frame",
			);
		}
	}

	#append(part: Uint8Array): void {
		if (part.byteLength === 0) {
			return;
		}

		this.#chunks.push(part);
		this.#pendingBytes += part.byteLength;
		const permitsTrailingCarriageReturn =
			this.#pendingBytes === MAX_FRAME_BYTES + 1 && part.at(-1) === 13;
		if (this.#pendingBytes > MAX_FRAME_BYTES && !permitsTrailingCarriageReturn) {
			this.#reset();
			throw new BridgeProtocolError(
				"frame_too_large",
				`Bridge frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
			);
		}
	}

	#reset(): void {
		this.#chunks.length = 0;
		this.#pendingBytes = 0;
	}
}

export function decodeServerFrame(frame: string | Uint8Array): ServerMessage {
	const bytes = typeof frame === "string" ? encoder.encode(frame) : frame;
	const payload = stripLineTerminator(bytes);

	if (payload.byteLength === 0) {
		throw new BridgeProtocolError("empty_frame", "Bridge frame is empty");
	}
	if (payload.byteLength > MAX_FRAME_BYTES) {
		throw new BridgeProtocolError(
			"frame_too_large",
			`Bridge frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
		);
	}
	if (payload.includes(10) || payload.includes(13)) {
		throw new BridgeProtocolError("multiple_frames", "Bridge input contains multiple JSONL frames");
	}

	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		throw new BridgeProtocolError("invalid_frame", "Bridge frame is not valid JSON");
	}

	if (!serverMessageValidator.Check(value)) {
		throw new BridgeProtocolError("invalid_frame", "Bridge frame does not match protocol v1");
	}

	return value;
}

export function encodeClientMessage(message: ClientMessage): Uint8Array {
	if (!clientMessageValidator.Check(message)) {
		throw new BridgeProtocolError("invalid_frame", "Client frame does not match protocol v1");
	}

	let payload: Uint8Array;
	try {
		payload = encoder.encode(JSON.stringify(message));
	} catch {
		throw new BridgeProtocolError("invalid_frame", "Client frame is not JSON serializable");
	}

	if (payload.byteLength > MAX_FRAME_BYTES) {
		throw new BridgeProtocolError(
			"frame_too_large",
			`Client frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
		);
	}

	const frame = new Uint8Array(payload.byteLength + 1);
	frame.set(payload);
	frame[payload.byteLength] = 10;
	return frame;
}

function stripLineTerminator(frame: Uint8Array): Uint8Array {
	if (frame.at(-1) !== 10) {
		return frame;
	}

	const withoutLineFeed = frame.subarray(0, -1);
	return withoutLineFeed.at(-1) === 13 ? withoutLineFeed.subarray(0, -1) : withoutLineFeed;
}

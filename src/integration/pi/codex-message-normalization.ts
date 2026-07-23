export const INTERRUPTED_TOOL_RESULT_TEXT =
	"Tool result was not recorded. The tool may have partially executed; inspect state before retrying.";

const NORMALIZATION_ERROR = "OpenAI Codex message history is invalid";
const RESPONSE_ITEM_SIGNATURE_KIND = "pi-codex-adaptor.response-item";
const RESPONSE_ITEM_SIGNATURE_VERSION = 2;

type OutputKind = "function" | "custom";

interface PendingToolCall {
	readonly callId: string;
	readonly toolName: string;
	readonly outputKind: OutputKind;
}

export function normalizeCodexContextMessages(messages: readonly unknown[]): readonly unknown[] {
	const normalized: unknown[] = [];
	let pending: PendingToolCall[] = [];

	const flushPending = (): void => {
		for (const call of pending) normalized.push(syntheticToolResult(call));
		pending = [];
	};

	for (const message of messages) {
		const raw = record(message);
		if (raw === undefined || typeof raw.role !== "string") {
			normalized.push(message);
			continue;
		}

		if (isTurnBoundary(raw)) flushPending();

		if (raw.role === "assistant") {
			if (raw.stopReason === "error" || raw.stopReason === "aborted") continue;
			pending = collectToolCalls(raw);
			normalized.push(message);
			continue;
		}

		if (raw.role === "toolResult") {
			const callId = raw.toolCallId;
			if (typeof callId === "string") {
				const index = pending.findIndex((call) => call.callId === callId);
				if (index >= 0) {
					const call = pending[index];
					if (call === undefined || resultKind(raw) !== call.outputKind) failNormalization();
					pending.splice(index, 1);
				}
			}
		}

		normalized.push(message);
	}

	flushPending();
	return unchanged(messages, normalized) ? messages : normalized;
}

function isTurnBoundary(message: Record<string, unknown>): boolean {
	switch (message.role) {
		case "user":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
		case "assistant":
			return true;
		case "bashExecution":
			return message.excludeFromContext !== true;
		default:
			return false;
	}
}

function collectToolCalls(message: Record<string, unknown>): PendingToolCall[] {
	if (!Array.isArray(message.content)) return [];
	const calls: PendingToolCall[] = [];
	const ids = new Set<string>();
	for (const block of message.content) {
		const content = record(block);
		if (content?.type !== "toolCall") continue;
		const callId = nonEmptyString(content.id);
		const toolName = nonEmptyString(content.name);
		if (callId === undefined || toolName === undefined || ids.has(callId)) failNormalization();
		const visibleKind = outputKindForToolName(toolName);
		const signedKind = signedToolCallKind(content.thoughtSignature, callId);
		if (signedKind !== undefined && signedKind !== visibleKind) failNormalization();
		ids.add(callId);
		calls.push({ callId, toolName, outputKind: signedKind ?? visibleKind });
	}
	return calls;
}

function signedToolCallKind(value: unknown, visibleCallId: string): OutputKind | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
	const envelope = record(parsed);
	if (
		envelope === undefined ||
		!hasExactKeys(envelope, ["v", "kind", "item"]) ||
		envelope.v !== RESPONSE_ITEM_SIGNATURE_VERSION ||
		envelope.kind !== RESPONSE_ITEM_SIGNATURE_KIND
	) {
		return undefined;
	}
	const item = record(envelope.item);
	if (item === undefined) failNormalization();
	const callId = nonEmptyString(item.call_id);
	if (callId === undefined || callId !== visibleCallId) failNormalization();
	if (item.type === "custom_tool_call") return "custom";
	if (item.type === "function_call") return "function";
	failNormalization();
}

function syntheticToolResult(call: PendingToolCall): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: call.callId,
		toolName: call.toolName,
		content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
		isError: true,
		timestamp: 0,
	};
}

function resultKind(message: Record<string, unknown>): OutputKind {
	return outputKindForToolName(typeof message.toolName === "string" ? message.toolName : "");
}

function outputKindForToolName(toolName: string): OutputKind {
	return toolName === "apply_patch" ? "custom" : "function";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unchanged(source: readonly unknown[], normalized: readonly unknown[]): boolean {
	return (
		source.length === normalized.length &&
		source.every((value, index) => value === normalized[index])
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
				return undefined;
			}
		}
		return value as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function failNormalization(): never {
	throw new Error(NORMALIZATION_ERROR);
}

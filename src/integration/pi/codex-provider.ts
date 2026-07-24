import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";

import {
	type CodexProviderConnection,
	type CodexRuntime,
	remoteCompactionV2Context,
} from "../../application/codex-runtime.ts";
import {
	CodexCompactionStore,
	isSupportedStructuredResponseItem,
	matchingOpaqueSnapshotOutput,
} from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	capabilityCacheKey,
	type EffectiveCapabilitySnapshot,
	ResolveEffectiveCapabilities,
	withSupplementalSessionInstructions,
} from "../../application/resolve-effective-capabilities.ts";
import { isStrictJsonValue, isStrictPlainRecord } from "../../application/structured-json.ts";
import { CapabilityError } from "../../domain/capability.ts";
import type { CodexConfig } from "../../domain/config.ts";
import { normalizeCodexContextMessages } from "./codex-message-normalization.ts";
import { toPiProviderErrorMessage } from "./codex-provider-error.ts";
import {
	authenticationSummary,
	type CodexProviderRequestGuard,
	type CodexProviderRequestRecord,
	sessionFingerprint,
	sha256Hex,
	snapshotSimpleStreamOptions,
} from "./codex-provider-request-guard.ts";
import {
	type CodexToolProfileCoordinator,
	createUnavailableCodexToolProfile,
} from "./codex-tool-profile.ts";
import { selectCodexToolSurface } from "./codex-tool-surface.ts";
import { createProviderConnection } from "./provider-connection.ts";

export { officialToolNames } from "./codex-tool-surface.ts";

export function createCodexStreamSimple(
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	activation: ProviderActivationPolicy,
	compactions = new CodexCompactionStore(),
	capabilities = new ResolveEffectiveCapabilities(runtime),
	profile: CodexToolProfileCoordinator = createUnavailableCodexToolProfile(),
	requestGuard?: CodexProviderRequestGuard,
): (
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		void runResponse(
			stream,
			runtime,
			configuration,
			compactions,
			activation,
			capabilities,
			profile,
			model,
			context,
			snapshotSimpleStreamOptions(options),
			requestGuard,
		);
		return stream;
	};
}

async function runResponse(
	stream: AssistantMessageEventStream,
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	compactions: CodexCompactionStore,
	activation: ProviderActivationPolicy,
	capabilities: ResolveEffectiveCapabilities,
	profile: CodexToolProfileCoordinator,
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	requestGuard: CodexProviderRequestGuard | undefined,
): Promise<void> {
	const output = createOutput(model);
	let requestRecord: CodexProviderRequestRecord | undefined;
	let dispatchConnection: CodexProviderConnection | undefined;
	let dispatchConfig: CodexConfig["codex"] | undefined;
	let dispatchProviderSupportsWebsockets: boolean | undefined;
	stream.push({ type: "start", partial: output });
	try {
		if (!activation.isActive(model)) {
			throw new CapabilityError(
				"inactive_provider",
				"Codex dispatch is inactive for the selected provider and API",
			);
		}
		const connection = createProviderConnection(model, options);
		const config = await configuration.load();
		const capabilityKey = capabilityCacheKey({
			modelId: model.id,
			providerId: model.provider,
			config,
			contextWindow: model.contextWindow,
		});
		if (!profile.isHealthy(capabilityKey)) {
			throw new CapabilityError(
				"effective_capability_invalid",
				"Codex tool profile is unavailable for the selected capability",
			);
		}
		const snapshot = await capabilities.resolve({
			modelId: model.id,
			providerId: model.provider,
			config,
			contextWindow: model.contextWindow,
		});
		dispatchConnection = connection;
		dispatchConfig = config.codex;
		dispatchProviderSupportsWebsockets = snapshot.providerSupportsWebsockets;
		const officialTools = snapshot.modelTools;
		let request = buildRequest(
			model,
			context,
			options,
			config.codex,
			connection,
			officialTools,
			compactions,
			snapshot,
		);
		if (requestGuard !== undefined) {
			const requestOptions = options;
			if (requestOptions === undefined || requestOptions.sessionId === undefined) {
				throw new Error("Codex provider session route is unavailable");
			}
			requestRecord = requestGuard.open({
				options: requestOptions,
				sessionId: requestOptions.sessionId,
				model,
				context,
				request,
				inputLedger: Array.isArray(request.input) ? request.input : [],
				connection,
				config,
				capabilities: snapshot,
				...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
			});
			const replacement = await requestGuard.run(requestRecord, async () =>
				requestOptions.onPayload?.(request, model),
			);
			if (replacement !== undefined) request = asRequest(replacement);
			const approvedRecord: CodexProviderRequestRecord = requestRecord;
			requestGuard.assertApproved(approvedRecord, request);
			dispatchConnection = approvedRecord.connection;
			dispatchConfig = approvedRecord.config.codex;
			dispatchProviderSupportsWebsockets = approvedRecord.capabilities.providerSupportsWebsockets;
		} else {
			const replacement = await options?.onPayload?.(request, model);
			if (replacement !== undefined) request = asRequest(replacement);
		}
		const state = new ResponseState(output, stream, model);
		const remoteV2Context = remoteCompactionV2Context(
			snapshot.compaction.implementation,
			options?.sessionId,
		);
		const result = await runtime.createResponse({
			connection: dispatchConnection ?? connection,
			request,
			transportMode: dispatchConfig?.transport.mode ?? config.codex.transport.mode,
			providerSupportsWebsockets:
				dispatchProviderSupportsWebsockets ?? snapshot.providerSupportsWebsockets,
			...(remoteV2Context === undefined ? {} : { remoteCompactionV2Context: remoteV2Context }),
			...(options?.signal === undefined ? {} : { signal: options.signal }),
			onEvent: (event) => state.accept(event),
		});
		if (result.status === "aborted" || options?.signal?.aborted === true) {
			throw new DOMException("The OpenAI Codex request was aborted", "AbortError");
		}
		if (result.status !== "completed") {
			throw new Error(`OpenAI Codex response ended with status ${result.status}`);
		}
		state.complete(result.result);
		calculateCost(model, output.usage);
		const reason =
			output.stopReason === "toolUse" || output.stopReason === "length"
				? output.stopReason
				: "stop";
		stream.push({ type: "done", reason, message: output });
		stream.end();
	} catch (error) {
		output.stopReason = options?.signal?.aborted === true ? "aborted" : "error";
		output.errorMessage = toPiProviderErrorMessage(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	} finally {
		if (requestGuard !== undefined && requestRecord !== undefined) {
			requestGuard.consume(requestRecord);
		}
	}
}

class ResponseState {
	readonly #output: AssistantMessage;
	readonly #stream: AssistantMessageEventStream;
	readonly #model: Model<string>;
	#textIndex: number | undefined;
	#thinkingIndex: number | undefined;
	#hasToolCall = false;

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<string>) {
		this.#output = output;
		this.#stream = stream;
		this.#model = model;
	}

	accept(value: unknown): void {
		const event = record(value);
		if (event === undefined || typeof event.type !== "string") return;
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string") this.#appendText(event.delta);
				break;
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta":
				if (typeof event.delta === "string") this.#appendThinking(event.delta);
				break;
			case "response.output_item.done":
				this.#finishItem(event.item);
				break;
			case "response.server_model":
				if (typeof event.model === "string") this.#output.responseModel = event.model;
				break;
		}
	}

	complete(value: unknown): void {
		this.#endOpenBlocks();
		const completion = record(value);
		if (completion !== undefined) {
			if (typeof completion.responseId === "string") {
				this.#output.responseId = completion.responseId;
			}
			applyUsage(this.#output, completion.tokenUsage);
		}
		this.#output.stopReason = this.#hasToolCall ? "toolUse" : "stop";
	}

	#appendText(delta: string): void {
		const index = this.#ensureText();
		const content = this.#output.content[index];
		if (content?.type !== "text") return;
		content.text += delta;
		this.#stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.#output });
	}

	#appendThinking(delta: string): void {
		const index = this.#ensureThinking();
		const content = this.#output.content[index];
		if (content?.type !== "thinking") return;
		content.thinking += delta;
		this.#stream.push({
			type: "thinking_delta",
			contentIndex: index,
			delta,
			partial: this.#output,
		});
	}

	#finishItem(value: unknown): void {
		const item = record(value);
		if (item === undefined || typeof item.type !== "string") return;
		if (item.type === "message") {
			this.#applyCompletedText(item.content);
			this.#applyTextSignature(item);
			return;
		}
		if (item.type === "web_search_call") {
			this.#consumeHostedWebSearch(item);
			return;
		}
		if (item.type === "reasoning") {
			this.#applyCompletedThinking(item.summary);
			const signature = responseItemSignature(item, "reasoning");
			if (signature !== undefined) {
				const index = this.#ensureThinking();
				const content = this.#output.content[index];
				if (content?.type === "thinking") content.thinkingSignature = signature;
			}
			return;
		}
		if (item.type === "function_call" || item.type === "custom_tool_call") {
			const toolCall = toToolCall(item);
			if (toolCall !== undefined) this.#addToolCall(toolCall);
			return;
		}
		this.#consumeOpaqueItem(item);
	}

	#applyCompletedText(value: unknown): void {
		if (!Array.isArray(value)) return;
		const completed = value
			.map(record)
			.filter((item) => item?.type === "output_text" && typeof item.text === "string")
			.map((item) => (typeof item?.text === "string" ? item.text : ""))
			.join("");
		if (completed.length === 0) return;
		const index = this.#ensureText();
		const content = this.#output.content[index];
		if (content?.type !== "text" || completed === content.text) return;
		const delta = completed.startsWith(content.text)
			? completed.slice(content.text.length)
			: completed;
		if (delta.length > 0) this.#appendText(delta);
	}

	#applyCompletedThinking(value: unknown): void {
		if (!Array.isArray(value)) return;
		const completed = value
			.map(record)
			.filter((item) => item?.type === "summary_text" && typeof item.text === "string")
			.map((item) => (typeof item?.text === "string" ? item.text : ""))
			.join("");
		if (completed.length === 0) return;
		const index = this.#ensureThinking();
		const content = this.#output.content[index];
		if (content?.type !== "thinking" || completed === content.thinking) return;
		const delta = completed.startsWith(content.thinking)
			? completed.slice(content.thinking.length)
			: completed;
		if (delta.length > 0) this.#appendThinking(delta);
	}

	#applyTextSignature(item: Record<string, unknown>): void {
		const index = this.#ensureText();
		const content = this.#output.content[index];
		if (content?.type !== "text") return;
		const normalized = {
			...item,
			...(typeof item.role === "string" ? {} : { role: "assistant" }),
			...(Array.isArray(item.content)
				? {}
				: {
						content: content.text.length === 0 ? [] : [{ type: "output_text", text: content.text }],
					}),
		};
		const signature = responseItemSignature(normalized, "message");
		if (signature !== undefined) content.textSignature = signature;
	}

	#addToolCall(toolCall: ToolCall): void {
		this.#endOpenBlocks();
		const index = this.#output.content.length;
		this.#output.content.push(toolCall);
		this.#hasToolCall = true;
		this.#stream.push({ type: "toolcall_start", contentIndex: index, partial: this.#output });
		this.#stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall,
			partial: this.#output,
		});
	}

	#consumeOpaqueItem(item: Record<string, unknown>): void {
		this.#endOpenBlocks();
		const index = this.#output.content.length;
		this.#output.content.push({
			type: "text",
			text: "",
			textSignature: encodeResponseItemSignature(item),
		});
		this.#stream.push({ type: "text_start", contentIndex: index, partial: this.#output });
		this.#stream.push({
			type: "text_end",
			contentIndex: index,
			content: "",
			partial: this.#output,
		});
	}

	/** Hosted web_search is server-executed; consume the event without creating a local tool call. */
	#consumeHostedWebSearch(item: Record<string, unknown>): void {
		this.#endOpenBlocks();
		const action = record(item.action);
		const query =
			typeof action?.query === "string"
				? action.query
				: Array.isArray(action?.queries)
					? action.queries.filter((value): value is string => typeof value === "string").join("; ")
					: typeof action?.url === "string"
						? action.url
						: typeof action?.pattern === "string"
							? action.pattern
							: "";
		const kind = typeof action?.type === "string" ? action.type : "search";
		const summary =
			kind === "open_page"
				? `Opened page${query.length > 0 ? `: ${query}` : ""}`
				: kind === "find_in_page"
					? `Find in page${query.length > 0 ? `: ${query}` : ""}`
					: `Web search${query.length > 0 ? `: ${query}` : ""}`;
		const index = this.#output.content.length;
		this.#output.content.push({
			type: "text",
			text: summary,
			textSignature: encodeResponseItemSignature(item),
		});
		this.#stream.push({ type: "text_start", contentIndex: index, partial: this.#output });
		this.#stream.push({
			type: "text_delta",
			contentIndex: index,
			delta: summary,
			partial: this.#output,
		});
		this.#stream.push({
			type: "text_end",
			contentIndex: index,
			content: summary,
			partial: this.#output,
		});
	}

	#ensureText(): number {
		if (this.#textIndex !== undefined) return this.#textIndex;
		this.#endThinking();
		const index = this.#output.content.length;
		this.#output.content.push({ type: "text", text: "" });
		this.#textIndex = index;
		this.#stream.push({ type: "text_start", contentIndex: index, partial: this.#output });
		return index;
	}

	#ensureThinking(): number {
		if (this.#thinkingIndex !== undefined) return this.#thinkingIndex;
		this.#endText();
		const index = this.#output.content.length;
		this.#output.content.push({ type: "thinking", thinking: "" });
		this.#thinkingIndex = index;
		this.#stream.push({ type: "thinking_start", contentIndex: index, partial: this.#output });
		return index;
	}

	#endOpenBlocks(): void {
		this.#endText();
		this.#endThinking();
	}

	#endText(): void {
		const index = this.#textIndex;
		if (index === undefined) return;
		const content = this.#output.content[index];
		if (content?.type === "text") {
			this.#stream.push({
				type: "text_end",
				contentIndex: index,
				content: content.text,
				partial: this.#output,
			});
		}
		this.#textIndex = undefined;
	}

	#endThinking(): void {
		const index = this.#thinkingIndex;
		if (index === undefined) return;
		const content = this.#output.content[index];
		if (content?.type === "thinking") {
			this.#stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: content.thinking,
				partial: this.#output,
			});
		}
		this.#thinkingIndex = undefined;
	}
}

export function buildCodexRequest(
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	openai: {
		serviceTier: "default" | "priority" | "flex";
		verbosity: "low" | "medium" | "high";
	},
	connection: CodexProviderConnection | undefined,
	officialTools: readonly unknown[],
	compactions: CodexCompactionStore,
	capabilities: EffectiveCapabilitySnapshot,
): Record<string, unknown> {
	const activeDefinitions = context.tools ?? [];
	const tools = selectCodexToolSurface(
		officialTools,
		activeDefinitions.map((tool) => tool.name),
		activeDefinitions,
	);
	const effort =
		options?.reasoning === undefined
			? undefined
			: (model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning);
	if (options?.sessionId !== undefined && compactions.isReplayInvalid(options.sessionId)) {
		throw new Error("OpenAI Codex compaction replay is invalid for this session");
	}
	const snapshot = compactions.getForSession(options?.sessionId);
	const identity =
		options?.sessionId === undefined || connection === undefined
			? undefined
			: providerRequestIdentity(options.sessionId, model, connection);
	const matchedOpaqueOutput = matchingOpaqueSnapshotOutput(
		snapshot,
		identity,
		snapshot?.source === "manual" ? sha256Hex(snapshot.summary) : undefined,
	);
	const messages =
		matchedOpaqueOutput !== undefined &&
		snapshot?.source === "manual" &&
		isCompactionMarker(context.messages[0], snapshot.summary)
			? context.messages.slice(1)
			: context.messages;
	const canonicalPrefix = messages === context.messages ? [] : (matchedOpaqueOutput ?? []);
	return {
		model: model.id,
		instructions: withSupplementalSessionInstructions(context.systemPrompt ?? "", capabilities),
		input: [...canonicalPrefix, ...responseItemsFromMessages(messages)],
		tools: tools.length === 0 ? null : tools,
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning:
			effort === undefined || effort === null
				? null
				: { effort, summary: "auto", context: "all_turns" },
		store: false,
		stream: true,
		include: ["reasoning.encrypted_content"],
		service_tier: openai.serviceTier,
		prompt_cache_key: options?.sessionId,
		text: { verbosity: openai.verbosity },
	};
}

const buildRequest = buildCodexRequest;

function providerRequestIdentity(
	sessionId: string,
	model: Pick<Model<string>, "id" | "api">,
	connection: CodexProviderConnection,
) {
	const authenticationBinding = authenticationSummary(
		connection.authentication,
		connection.accountId,
		connection.accountIdSource,
	);
	if (authenticationBinding === undefined) return undefined;
	return {
		sessionFingerprint: sessionFingerprint(sessionId),
		providerId: connection.providerId,
		api: model.api,
		baseUrl: connection.baseUrl,
		modelId: model.id,
		authenticationBinding,
	};
}

export function responseItemsFromMessages(messages: readonly unknown[]): unknown[] {
	return normalizeCodexContextMessages(messages).flatMap(toResponseItems);
}

const RESPONSE_ITEM_SIGNATURE_KIND = "pi-codex-adaptor.response-item";
const RESPONSE_ITEM_SIGNATURE_VERSION = 2;
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

/** Encode a complete bridge-supported item in a Pi signature field without interpreting it. */
export function encodeResponseItemSignature(item: unknown): string {
	if (!isInertJson(item) || !isSupportedStructuredResponseItem(item)) {
		throw new Error("Provider response item cannot be persisted safely");
	}
	return JSON.stringify({
		v: RESPONSE_ITEM_SIGNATURE_VERSION,
		kind: RESPONSE_ITEM_SIGNATURE_KIND,
		item,
	});
}

export function decodeResponseItemSignature(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		const envelope = record(parsed);
		const item = envelope?.item;
		if (
			envelope === undefined ||
			!hasExactKeys(envelope, ["v", "kind", "item"]) ||
			envelope?.v !== RESPONSE_ITEM_SIGNATURE_VERSION ||
			envelope.kind !== RESPONSE_ITEM_SIGNATURE_KIND ||
			!isInertJson(item) ||
			!isSupportedStructuredResponseItem(item)
		) {
			return undefined;
		}
		return item as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function toResponseItems(message: unknown): unknown[] {
	const raw = record(message);
	if (raw === undefined || typeof raw.role !== "string") return [];
	if (raw.role === "compactionSummary" && typeof raw.summary === "string") {
		return [userTextItem(`${COMPACTION_SUMMARY_PREFIX}${raw.summary}${COMPACTION_SUMMARY_SUFFIX}`)];
	}
	if (raw.role === "branchSummary" && typeof raw.summary === "string") {
		return [userTextItem(raw.summary)];
	}
	if (raw.role === "custom") {
		return [{ type: "message", role: "user", content: inputContent(raw.content) }];
	}
	if (raw.role === "bashExecution" && raw.excludeFromContext !== true) {
		const command = typeof raw.command === "string" ? raw.command : "";
		const output = typeof raw.output === "string" ? raw.output : "";
		return [userTextItem(`Command: ${command}\nOutput:\n${output}`)];
	}
	if (raw.role === "user") {
		return [{ type: "message", role: "user", content: inputContent(raw.content) }];
	}
	if (raw.role === "toolResult") {
		if (raw.toolName === "apply_patch") {
			return [
				{
					type: "custom_tool_call_output",
					call_id: raw.toolCallId,
					output: toolOutput(Array.isArray(raw.content) ? raw.content : []),
				},
			];
		}
		return [
			{
				type: "function_call_output",
				call_id: raw.toolCallId,
				output: toolOutput(Array.isArray(raw.content) ? raw.content : []),
			},
		];
	}
	if (raw.role !== "assistant" || !Array.isArray(raw.content)) return [];
	const items: unknown[] = [];
	for (const value of raw.content) {
		const content = record(value);
		if (content === undefined) continue;
		if (content.type === "text") {
			const preserved = decodeResponseItemSignature(content.textSignature);
			if (preserved !== undefined) {
				items.push(preserved);
				continue;
			}
			const signature = parseTextSignature(content.textSignature);
			if (signature?.kind === "web_search_call") {
				items.push({
					type: "web_search_call",
					...(typeof signature.id === "string" ? { id: signature.id } : {}),
					...(typeof signature.status === "string" ? { status: signature.status } : {}),
					...(signature.action === undefined ? {} : { action: signature.action }),
				});
				continue;
			}
			items.push({
				type: "message",
				role: "assistant",
				...(typeof signature?.id === "string" ? { id: signature.id } : {}),
				...(signature?.phase === "commentary" || signature?.phase === "final_answer"
					? { phase: signature.phase }
					: {}),
				content: [{ type: "output_text", text: content.text }],
			});
		} else if (content.type === "thinking") {
			const preserved = decodeResponseItemSignature(content.thinkingSignature);
			if (preserved !== undefined) {
				items.push(preserved);
				continue;
			}
			const legacySignature = parseTextSignature(content.thinkingSignature);
			items.push({
				type: "reasoning",
				...(typeof legacySignature?.id === "string" ? { id: legacySignature.id } : {}),
				summary: content.thinking ? [{ type: "summary_text", text: content.thinking }] : [],
				content: null,
				encrypted_content:
					typeof content.thinkingSignature === "string" && legacySignature === undefined
						? content.thinkingSignature
						: null,
			});
		} else {
			const preserved = decodeResponseItemSignature(content.thoughtSignature);
			if (preserved !== undefined) {
				items.push(preserved);
				continue;
			}
			const argumentsValue = record(content.arguments);
			if (content.name === "apply_patch" && typeof argumentsValue?.input === "string") {
				items.push({
					type: "custom_tool_call",
					name: content.name,
					input: argumentsValue.input,
					call_id: content.id,
				});
				continue;
			}
			if (typeof content.name === "string" && content.name.includes(".")) {
				const [namespace, name] = content.name.split(".", 2);
				if (namespace !== undefined && name !== undefined) {
					items.push({
						type: "function_call",
						namespace,
						name,
						arguments: JSON.stringify(content.arguments),
						call_id: content.id,
					});
					continue;
				}
			}
			items.push({
				type: "function_call",
				name: content.name,
				arguments: JSON.stringify(content.arguments),
				call_id: content.id,
			});
		}
	}
	return items;
}

function userTextItem(text: string): unknown {
	return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function isCompactionMarker(message: unknown, summary: string): boolean {
	const value = record(message);
	if (value?.role === "compactionSummary") return value.summary === summary;
	if (value?.role !== "user") return false;
	const content = value.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map(record)
						.filter((item) => item?.type === "text" && typeof item.text === "string")
						.map((item) => (typeof item?.text === "string" ? item.text : ""))
						.join("")
				: "";
	return (
		text.startsWith("The conversation history before this point was compacted") &&
		text.includes(summary)
	);
}

function inputContent(content: unknown): unknown[] {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	if (!Array.isArray(content)) return [];
	const result: unknown[] = [];
	for (const item of content) {
		const value = record(item);
		if (value?.type === "text" && typeof value.text === "string") {
			result.push({ type: "input_text", text: value.text });
			continue;
		}
		if (
			value?.type === "image" &&
			typeof value.data === "string" &&
			typeof value.mimeType === "string"
		) {
			result.push({
				type: "input_image",
				image_url: `data:${value.mimeType};base64,${value.data}`,
				detail: "original",
			});
		}
	}
	return result;
}

function toolOutput(content: readonly unknown[]): string | unknown[] {
	const items: Array<Record<string, unknown>> = [];
	for (const item of content) {
		const value = record(item);
		if (value?.type === "text" && typeof value.text === "string") {
			items.push({ type: "input_text", text: value.text });
			continue;
		}
		if (
			value?.type === "image" &&
			typeof value.data === "string" &&
			typeof value.mimeType === "string"
		) {
			items.push({
				type: "input_image",
				image_url: `data:${value.mimeType};base64,${value.data}`,
			});
		}
	}
	return items.every((item) => item.type === "input_text")
		? items.map((item) => (typeof item.text === "string" ? item.text : "")).join("\n")
		: items;
}

function toToolCall(item: Record<string, unknown>): ToolCall | undefined {
	if (typeof item.call_id !== "string" || typeof item.name !== "string") return undefined;
	const rawArguments = item.type === "custom_tool_call" ? item.input : item.arguments;
	if (typeof rawArguments !== "string") return undefined;
	let parsed: unknown;
	try {
		parsed = item.type === "custom_tool_call" ? { input: rawArguments } : JSON.parse(rawArguments);
	} catch {
		parsed = { input: rawArguments };
	}
	const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
	const signature = responseItemSignature(
		item,
		item.type === "custom_tool_call" ? "custom_tool_call" : "function_call",
	);
	return {
		type: "toolCall",
		id: item.call_id,
		name: namespace === undefined ? item.name : `${namespace}.${item.name}`,
		arguments: record(parsed) ?? { input: rawArguments },
		...(signature === undefined ? {} : { thoughtSignature: signature }),
	};
}

function createOutput(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function applyUsage(output: AssistantMessage, value: unknown): void {
	const usage = record(value);
	if (usage === undefined) return;
	output.usage.input = integer(usage.input_tokens);
	output.usage.cacheRead = integer(usage.cached_input_tokens);
	output.usage.output = integer(usage.output_tokens);
	output.usage.reasoning = integer(usage.reasoning_output_tokens);
	output.usage.totalTokens = integer(usage.total_tokens);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return isStrictPlainRecord(value) ? value : undefined;
}

function parseTextSignature(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		return record(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function integer(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function responseItemSignature(
	item: Record<string, unknown>,
	_type: "message" | "reasoning" | "function_call" | "custom_tool_call",
): string | undefined {
	return encodeResponseItemSignature(item);
}

function isInertJson(value: unknown): boolean {
	return isStrictJsonValue(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	if (!isStrictPlainRecord(value)) return false;
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function asRequest(value: unknown): Record<string, unknown> {
	const request = record(value);
	if (request === undefined || !isStrictJsonValue(request) || !Array.isArray(request.input)) {
		throw new Error("OpenAI Codex provider payload is invalid");
	}
	return request;
}

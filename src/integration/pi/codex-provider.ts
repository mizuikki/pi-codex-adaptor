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

import type { CodexRuntime } from "../../application/codex-runtime.ts";
import { CodexCompactionStore } from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import type { ProviderActivationPolicy } from "../../application/provider-activation.ts";
import {
	buildToolsResolveParams,
	CapabilityError,
	parseModelResolution,
} from "../../domain/capability.ts";
import { createProviderConnection } from "./provider-connection.ts";

export function createCodexStreamSimple(
	runtime: CodexRuntime,
	configuration: ConfigurationService,
	compactions = new CodexCompactionStore(),
	activation: ProviderActivationPolicy,
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
			model,
			context,
			options,
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
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<void> {
	const output = createOutput(model);
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
		const resolution = parseModelResolution(await runtime.resolveModel(model.id), model.id);
		const toolResolution = record(
			await runtime.resolveTools(
				buildToolsResolveParams(resolution, {
					webSearchMode: config.codex.webSearch.mode,
					viewImage: config.tools.optional.viewImage === "auto",
					imageGeneration: config.tools.optional.imageGeneration === "auto",
					standaloneWebSearchExecutorAvailable: true,
				}),
			),
		);
		const officialTools = Array.isArray(toolResolution?.modelTools)
			? toolResolution.modelTools
			: [];
		let request: unknown = buildRequest(
			model,
			context,
			options,
			config.codex,
			officialTools,
			compactions,
		);
		const replacement = await options?.onPayload?.(request, model);
		if (replacement !== undefined) request = replacement;
		const state = new ResponseState(output, stream, model);
		const result = await runtime.createResponse({
			connection,
			request,
			transportMode: config.codex.transport.mode,
			providerSupportsWebsockets: resolution.provider.supportsWebsockets,
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
		output.errorMessage = safeErrorMessage(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
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
			const encrypted = item.encrypted_content;
			if (typeof encrypted === "string" && encrypted.length > 0) {
				const index = this.#ensureThinking();
				const content = this.#output.content[index];
				if (content?.type === "thinking") content.thinkingSignature = encrypted;
			}
			return;
		}
		if (item.type === "function_call" || item.type === "custom_tool_call") {
			const toolCall = toToolCall(item);
			if (toolCall !== undefined) this.#addToolCall(toolCall);
		}
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
		if (typeof item.id !== "string") return;
		const index = this.#ensureText();
		const content = this.#output.content[index];
		if (content?.type !== "text") return;
		content.textSignature = JSON.stringify({
			v: 1,
			id: item.id,
			...(item.phase === "commentary" || item.phase === "final_answer"
				? { phase: item.phase }
				: {}),
		});
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
			textSignature: JSON.stringify({
				v: 1,
				kind: "web_search_call",
				id: item.id,
				status: item.status,
				action: item.action,
			}),
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

function buildRequest(
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	openai: {
		serviceTier: "default" | "priority" | "flex";
		verbosity: "low" | "medium" | "high";
	},
	officialTools: readonly unknown[],
	compactions: CodexCompactionStore,
): unknown {
	const officialNames = officialToolNames(officialTools);
	const piTools = context.tools
		?.filter((tool) => !officialNames.has(tool.name))
		.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: false,
		}));
	const tools = [...officialTools, ...(piTools ?? [])];
	const effort =
		options?.reasoning === undefined
			? undefined
			: (model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning);
	const snapshot = compactions.get(options?.sessionId, model.id);
	const messages =
		snapshot !== undefined && isCompactionMarker(context.messages[0], snapshot.summary)
			? context.messages.slice(1)
			: context.messages;
	const canonicalPrefix = messages === context.messages ? [] : (snapshot?.output ?? []);
	return {
		model: model.id,
		instructions: context.systemPrompt ?? "",
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

export function responseItemsFromMessages(messages: readonly unknown[]): unknown[] {
	return messages.flatMap(toResponseItems);
}

function toResponseItems(message: unknown): unknown[] {
	const raw = record(message);
	if (raw === undefined || typeof raw.role !== "string") return [];
	if (raw.role === "compactionSummary") return [];
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
				content: [{ type: "output_text", text: content.text }],
			});
		} else if (content.type === "thinking") {
			items.push({
				type: "reasoning",
				summary: content.thinking ? [{ type: "summary_text", text: content.thinking }] : [],
				content: null,
				encrypted_content: content.thinkingSignature ?? null,
			});
		} else {
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

export function officialToolNames(tools: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const value of tools) {
		const tool = record(value);
		if (typeof tool?.name !== "string") continue;
		names.add(tool.name);
		if (tool.type !== "namespace" || !Array.isArray(tool.tools)) continue;
		for (const nestedValue of tool.tools) {
			const nested = record(nestedValue);
			if (typeof nested?.name === "string") names.add(`${tool.name}.${nested.name}`);
		}
	}
	return names;
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
	return {
		type: "toolCall",
		id: item.call_id,
		name: namespace === undefined ? item.name : `${namespace}.${item.name}`,
		arguments: record(parsed) ?? { input: rawArguments },
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
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
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

function safeErrorMessage(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") return "Request aborted";
	if (error instanceof CapabilityError) return error.reason;
	if (
		error instanceof Error &&
		["BridgeConnectionError", "BridgeRemoteError", "ConfigurationError"].includes(error.name)
	) {
		return error.message;
	}
	return "OpenAI Codex request failed";
}

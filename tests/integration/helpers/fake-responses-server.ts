import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface FakeModelSpec {
	slug: string;
	shellType?: "unified_exec" | "shell_command" | "disabled" | "default" | "local";
	useResponsesLite?: boolean;
	applyPatchToolType?: "freeform" | "function" | null;
	inputModalities?: readonly string[];
	contextWindow?: number;
	autoCompactTokenLimit?: number | null;
}

export interface FakeResponsesRequest {
	method: string;
	path: string;
	body: string;
	authorization: string | null;
	chatgptAccountId: string | null;
	contentType: string | null;
	headers: Record<string, string>;
}

export interface FakeResponsesServer {
	baseUrl: string;
	requests: FakeResponsesRequest[];
	stop(): void;
}

const repositoryRoot = resolve(import.meta.dir, "../../..");

export async function startFakeResponsesServer(
	models: readonly FakeModelSpec[] = [fixtureModelSpec()],
): Promise<FakeResponsesServer> {
	const sse = await readFile(resolve(repositoryRoot, "fixtures/responses/sse-basic.sse"), "utf8");
	const requests: FakeResponsesServer["requests"] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			const body = request.method === "GET" ? "" : await request.text();
			const headers: Record<string, string> = {};
			for (const [name, value] of request.headers.entries()) {
				headers[name.toLowerCase()] = value;
			}
			requests.push({
				method: request.method,
				path: url.pathname,
				body,
				authorization: request.headers.get("authorization"),
				chatgptAccountId: request.headers.get("chatgpt-account-id"),
				contentType: request.headers.get("content-type"),
				headers,
			});
			if (request.method === "GET" && url.pathname.endsWith("/models")) {
				return Response.json({
					models: models.map((model) => toOfficialModel(model)),
				});
			}
			if (request.method === "POST" && url.pathname.endsWith("/responses")) {
				return new Response(sse, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "close",
					},
				});
			}
			if (request.method === "POST" && url.pathname.endsWith("/responses/compact")) {
				return Response.json({
					output: [{ type: "message", role: "assistant", content: [] }],
				});
			}
			// Official clients may probe websocket upgrade with GET /responses first.
			if (request.method === "GET" && url.pathname.endsWith("/responses")) {
				return new Response("websocket upgrade unavailable", { status: 404 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		stop: () => server.stop(true),
	};
}

export function fixtureModelSpec(overrides: Partial<FakeModelSpec> = {}): FakeModelSpec {
	return {
		slug: "fixture-model",
		shellType: "unified_exec",
		useResponsesLite: false,
		applyPatchToolType: "freeform",
		inputModalities: ["text", "image"],
		contextWindow: 100_000,
		autoCompactTokenLimit: 95_000,
		...overrides,
	};
}

export function firstPostedResponsesRequest(
	requests: readonly FakeResponsesRequest[],
): FakeResponsesRequest {
	const request = requests.find(
		(entry) => entry.method === "POST" && entry.path.endsWith("/responses"),
	);
	if (request === undefined) {
		throw new Error("Fake Responses server did not receive POST /responses");
	}
	return request;
}

function toOfficialModel(model: FakeModelSpec): Record<string, unknown> {
	return {
		slug: model.slug,
		display_name: `${model.slug} display`,
		description: null,
		default_reasoning_level: null,
		supported_reasoning_levels: [],
		shell_type: model.shellType ?? "unified_exec",
		visibility: "list",
		supported_in_api: true,
		priority: 1,
		availability_nux: null,
		upgrade: null,
		base_instructions: "",
		supports_reasoning_summaries: false,
		support_verbosity: false,
		default_verbosity: null,
		apply_patch_tool_type: model.applyPatchToolType ?? "freeform",
		truncation_policy: { mode: "bytes", limit: 10_000 },
		supports_parallel_tool_calls: false,
		context_window: model.contextWindow ?? 100_000,
		auto_compact_token_limit: model.autoCompactTokenLimit ?? 95_000,
		experimental_supported_tools: [],
		input_modalities: [...(model.inputModalities ?? ["text", "image"])],
		use_responses_lite: model.useResponsesLite === true,
	};
}

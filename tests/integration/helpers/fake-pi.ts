import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

export interface FakePi {
	api: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	activeTools: string[];
	handlers: Map<string, EventHandler[]>;
	commands: string[];
	providers: string[];
	status: Map<string, string | undefined>;
	widgets: Map<string, string[] | undefined>;
	notifications: string[];
	context(model?: Model<string> | undefined): ExtensionContext;
}

export function createFakePi(options: {
	token: string;
	cwd?: string;
	thirdPartyTools?: readonly string[];
}): FakePi {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, EventHandler[]>();
	const commands: string[] = [];
	const providers: string[] = [];
	const status = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const notifications: string[] = [];
	let activeTools = [...(options.thirdPartyTools ?? ["third_party"])];
	const cwd = options.cwd ?? process.cwd();

	const api = {
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerProvider: (name: string) => {
			providers.push(name);
		},
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		getAllTools: () => [...tools.values()],
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;

	function context(model: Model<string> | undefined = fixtureModel()): ExtensionContext {
		return {
			model,
			cwd,
			hasUI: true,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: options.token,
					headers: {},
				}),
			},
			ui: {
				setStatus: (key: string, value: string | undefined) => status.set(key, value),
				setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
				select: async (_title: string, choices: string[]) =>
					choices.find((choice) => choice.startsWith("Allow once:")) ?? choices[0],
				notify: (message: string) => {
					notifications.push(message);
				},
			},
			sessionManager: {
				getSessionId: () => "fixture-session",
				getBranch: () => [],
				getEntries: () => [],
			},
			getSystemPrompt: () => "",
		} as unknown as ExtensionContext;
	}

	return {
		api,
		tools,
		get activeTools() {
			return activeTools;
		},
		set activeTools(value: string[]) {
			activeTools = value;
		},
		handlers,
		commands,
		providers,
		status,
		widgets,
		notifications,
		context,
	};
}

export function fixtureToken(accountId = "account-fixture"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

export function fixtureModel(
	id = "fixture-model",
	provider = "openai-codex",
	baseUrl = "https://invalid.example",
): Model<string> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

export async function emit(
	pi: FakePi,
	event: string,
	ctx: ExtensionContext,
	payload: unknown = { type: event },
): Promise<void> {
	for (const handler of pi.handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

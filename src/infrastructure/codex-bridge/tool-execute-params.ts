/**
 * Host-owned construction of native `tools.execute` params.
 *
 * Model tool arguments are copied only through an adaptor allowlist. The
 * test-only base URL may arrive from host runtime options and is never taken
 * from tool-call arguments, so a model cannot redirect authenticated traffic.
 */

const TOOL_EXECUTE_ARGUMENT_KEYS = [
	"command",
	"cmd",
	"timeoutMs",
	"timeout_ms",
	"shell",
	"tty",
	"yield_time_ms",
	"yieldTimeMs",
	"max_output_tokens",
	"maxOutputTokens",
	"login",
	"allow_login_shell",
	"allowLoginShell",
	"allow_background_sessions",
	"allowBackgroundSessions",
	"session_id",
	"sessionId",
	"chars",
	"path",
	"detail",
	"input",
	"prompt",
	"referenced_image_paths",
	"referencedImagePaths",
	"num_last_images_to_include",
	"numLastImagesToInclude",
	"recent_image_urls",
	"recentImageUrls",
	"commands",
	"conversation_items",
	"conversationItems",
	"model",
	"request_session_id",
	"requestSessionId",
	"web_search_mode",
	"webSearchMode",
] as const;

export interface ToolsExecuteParamsInput {
	tool: string;
	argumentsValue: Record<string, unknown>;
	workdir: string;
	workspaceRoots: readonly string[];
	/** Loopback-only OpenAI base URL override supplied by host runtime options. */
	testBaseUrl?: string;
}

/**
 * Build the bridge `tools.execute` params object.
 *
 * Unknown model keys, including `testBaseUrl` / `test_base_url`, are dropped.
 * Host `testBaseUrl` is attached last when present.
 */
export function buildToolsExecuteParams(input: ToolsExecuteParamsInput): Record<string, unknown> {
	const params: Record<string, unknown> = {
		tool: input.tool,
		workdir: input.workdir,
		workspaceRoots: [...input.workspaceRoots],
	};
	for (const key of TOOL_EXECUTE_ARGUMENT_KEYS) {
		if (!Object.hasOwn(input.argumentsValue, key)) {
			continue;
		}
		const value = input.argumentsValue[key];
		if (value !== undefined) {
			params[key] = value;
		}
	}
	if (input.testBaseUrl !== undefined && input.testBaseUrl.length > 0) {
		params.testBaseUrl = input.testBaseUrl;
	}
	return params;
}

/**
 * Host-owned construction of native `tools.execute` params.
 *
 * Model tool arguments are copied only through an adaptor allowlist. Provider
 * connections are attached separately by the runtime for network tools.
 */

import type { NativeAuthorization } from "../../application/codex-runtime.ts";

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
	authorization: NativeAuthorization;
}

/**
 * Build the bridge `tools.execute` params object.
 *
 * Unknown model keys, including provider connection fields, are dropped.
 */
export function buildToolsExecuteParams(input: ToolsExecuteParamsInput): Record<string, unknown> {
	const params: Record<string, unknown> = {
		tool: input.tool,
		workdir: input.workdir,
		workspaceRoots: [...input.workspaceRoots],
		authorization: input.authorization,
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
	return params;
}

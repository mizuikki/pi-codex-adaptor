import { describe, expect, test } from "bun:test";

import {
	buildToolsResolveParams,
	completeProviderContract,
	parseAvailability,
	parseModelResolution,
	parseToolResolution,
	selectCompactionImplementation,
} from "../../src/domain/capability.ts";

describe("capability resolution", () => {
	test("requires exact model metadata and the official resolved compact threshold", () => {
		expect(() => parseModelResolution({ model: { slug: "other" } }, "fixture-model")).toThrow(
			/did not match the selected model/,
		);
		expect(() =>
			parseModelResolution(
				{ model: { slug: "fixture-model" }, shellSurface: "shell-command" },
				"fixture-model",
			),
		).toThrow(/valid auto-compact limit/);

		const resolved = parseModelResolution(
			{
				model: { slug: "fixture-model", shell_type: "unified_exec" },
				shellSurface: "unified-exec",
				autoCompactTokenLimit: 90_000,
			},
			"fixture-model",
		);
		expect(resolved.shellSurface).toBe("unified-exec");
		expect(resolved.autoCompactTokenLimit).toBe(90_000);
		expect(() =>
			parseModelResolution(
				{
					model: { slug: "fixture-model", shell_type: "unified_exec" },
					autoCompactTokenLimit: 90_000,
				},
				"fixture-model",
			),
		).toThrow(/valid shell surface/);
		expect(() =>
			parseModelResolution(
				{
					model: { slug: "fixture-model", shell_type: "unified_exec" },
					shellSurface: "future-shell",
					autoCompactTokenLimit: 90_000,
				},
				"fixture-model",
			),
		).toThrow(/valid shell surface/);
	});

	test("owns the complete provider contract outside model metadata", () => {
		expect(completeProviderContract("openai-codex")).toEqual({
			responsesSse: true,
			responsesWebsocket: "official-only",
			remoteCompactionV2: true,
			compactEndpoint: true,
			namespaceTools: true,
			imagesApi: true,
			searchApi: true,
			hostedWebSearch: true,
		});
		expect(completeProviderContract("custom").responsesWebsocket).toBe("unavailable");
		expect(selectCompactionImplementation(completeProviderContract("custom"))).toBe("remote_v2");
	});

	test("builds protocol-v4 resolver inputs from verified bridge evidence", () => {
		const resolution = parseModelResolution(
			{
				model: { slug: "fixture-model", use_responses_lite: false },
				shellSurface: "shell-command",
				autoCompactTokenLimit: 80_000,
			},
			"fixture-model",
		);
		expect(
			buildToolsResolveParams(resolution, {
				providerId: "openai-codex",
				webSearchMode: "cached",
				viewImage: true,
				imageGeneration: true,
				backgroundSessions: true,
				bridgeCapabilities: ["unified_exec", "standalone_web_search", "view_image"],
			}),
		).toEqual({
			model: { slug: "fixture-model", use_responses_lite: false },
			webSearchMode: "cached",
			providerContract: completeProviderContract("openai-codex"),
			standaloneWebSearch: { featureEnabled: false, executorAvailable: true },
			sessions: { enabled: true, executorAvailable: true },
			shell: { allowLoginShell: true, execPermissionApprovalsEnabled: false },
			optional: { viewImage: true, imageGeneration: false },
		});
	});

	test("strictly parses native tool ownership and availability", () => {
		const result = parseToolResolution({
			modelTools: [],
			dispatchTools: [],
			localToolNames: ["update_plan", "shell_command", "exec_command", "write_stdin"],
			hostedToolNames: [],
			shellSurface: "shell-command",
			sessionSurface: "supplemental",
			webSurface: "disabled",
			imageGenerationSurface: "disabled",
			capabilities: {
				sessions: { status: "available", source: "supplemental" },
				applyPatch: { status: "unavailable", reason: "model_apply_patch_disabled" },
				viewImage: { status: "disabled", reason: "disabled_by_configuration" },
				imageGeneration: { status: "disabled", reason: "disabled_by_configuration" },
				webSearch: { status: "disabled", reason: "disabled_by_configuration" },
			},
		});
		expect(result.sessionSurface).toBe("supplemental");
		expect(result.localToolNames).toContain("write_stdin");
		expect(() => parseAvailability({ status: "available", source: "guessed" })).toThrow();
		expect(() => parseAvailability({ status: "future", source: "official" })).toThrow();
	});
});

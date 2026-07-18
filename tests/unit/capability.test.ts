import { describe, expect, test } from "bun:test";

import {
	buildToolsResolveParams,
	parseModelResolution,
	selectCompactionImplementation,
} from "../../src/domain/capability.ts";

const officialProvider = {
	name: "OpenAI",
	supportsWebsockets: true,
	supportsRemoteCompaction: true,
	namespaceTools: true,
	imageGeneration: true,
	hostedWebSearch: true,
};

describe("capability resolution", () => {
	test("requires exact model and provider metadata from models.resolve", () => {
		expect(() => parseModelResolution({ model: { slug: "other" } }, "fixture-model")).toThrow(
			/did not match the selected model/,
		);
		expect(() =>
			parseModelResolution({ model: { slug: "fixture-model" } }, "fixture-model"),
		).toThrow(/provider capability metadata is unavailable/);

		const resolved = parseModelResolution(
			{
				model: { slug: "fixture-model", shell_type: "unified_exec" },
				shellSurface: "unified-exec",
				autoCompactTokenLimit: 90_000,
				provider: officialProvider,
			},
			"fixture-model",
		);
		expect(resolved.shellSurface).toBe("unified-exec");
		expect(resolved.autoCompactTokenLimit).toBe(90_000);
		expect(resolved.provider.supportsRemoteCompaction).toBe(true);
	});

	test("selects RemoteCompactionV2 or CompactClient from provider capability", () => {
		expect(selectCompactionImplementation(officialProvider)).toBe("remote_v2");
		expect(
			selectCompactionImplementation({
				...officialProvider,
				supportsRemoteCompaction: false,
			}),
		).toBe("compact_endpoint");
	});

	test("builds tools.resolve inputs from official metadata without inventing capability truth", () => {
		const resolution = parseModelResolution(
			{
				model: { slug: "fixture-model", use_responses_lite: false },
				shellSurface: "shell-command",
				autoCompactTokenLimit: null,
				provider: officialProvider,
			},
			"fixture-model",
		);
		expect(
			buildToolsResolveParams(resolution, {
				webSearchMode: "cached",
				viewImage: true,
				imageGeneration: true,
				standaloneWebSearchExecutorAvailable: true,
			}),
		).toEqual({
			model: { slug: "fixture-model", use_responses_lite: false },
			webSearchMode: "cached",
			provider: {
				hostedWebSearch: true,
				namespaceTools: true,
				imageGeneration: true,
			},
			standaloneWebSearch: {
				featureEnabled: false,
				executorAvailable: true,
			},
			shell: {
				allowLoginShell: true,
				execPermissionApprovalsEnabled: false,
			},
			optional: {
				viewImage: true,
				imageGeneration: true,
			},
		});
	});
});

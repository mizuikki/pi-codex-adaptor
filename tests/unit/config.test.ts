import { describe, expect, test } from "bun:test";

import {
	ConfigurationError,
	createDefaultConfig,
	evaluateConfigSettings,
	parseConfig,
	validateConfigForSave,
} from "../../src/domain/config.ts";

describe("versioned product configuration", () => {
	test("creates and parses the documented new-install default", () => {
		const config = createDefaultConfig();
		expect(parseConfig(config)).toEqual(config);
		expect(config.codex.compaction).toEqual({
			mode: "auto",
			autoCompactTokenLimit: "model",
		});
	});

	test("accepts off compaction without an inactive threshold", () => {
		const config = createDefaultConfig();
		const parsed = parseConfig({
			...config,
			codex: { ...config.codex, compaction: { mode: "off" } },
		});
		expect(parsed.codex.compaction).toEqual({ mode: "off" });
	});

	test("reports fixed field paths without reflecting unsupported values", () => {
		const config = createDefaultConfig();
		try {
			parseConfig({
				...config,
				openai: { ...config.codex, serviceTier: "private-sentinel", extra: true },
				codex: { ...config.codex, serviceTier: "private-sentinel", extra: true },
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect(error).toMatchObject({
				issues: expect.arrayContaining([
					expect.objectContaining({ path: "$", code: "unknown_field" }),
					expect.objectContaining({ path: "codex.serviceTier", code: "invalid_value" }),
				]),
			});
			expect((error as Error).message).not.toContain("private-sentinel");
		}
	});

	test("rejects missing schema versions and non-positive compaction limits", () => {
		const config = createDefaultConfig();
		expect(() => parseConfig({ ...config, schemaVersion: undefined })).toThrow(ConfigurationError);
		expect(() =>
			parseConfig({
				...config,
				codex: {
					...config.codex,
					compaction: { mode: "auto", autoCompactTokenLimit: 0 },
				},
			}),
		).toThrow(ConfigurationError);
	});

	test("rejects auto-compact thresholds at or above the known context window", () => {
		const config = createDefaultConfig();
		const draft = {
			...config,
			codex: {
				...config.codex,
				compaction: { mode: "auto" as const, autoCompactTokenLimit: 100_000 },
			},
		};
		try {
			validateConfigForSave(draft, { contextWindow: 100_000 });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect(error).toMatchObject({
				issues: [
					expect.objectContaining({
						path: "codex.compaction.autoCompactTokenLimit",
						code: "invalid_value",
					}),
				],
			});
		}
	});

	test("rejects model auto-compact when metadata has no limit", () => {
		const config = createDefaultConfig();
		expect(() => validateConfigForSave(config, { modelAutoCompactTokenLimit: null })).toThrow(
			ConfigurationError,
		);
	});

	test("rejects enabled web search when the bridge advertises no web surface", () => {
		const config = createDefaultConfig();
		try {
			validateConfigForSave(config, { bridgeCapabilities: ["responses_sse"] });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect(error).toMatchObject({
				issues: expect.arrayContaining([
					expect.objectContaining({
						path: "codex.webSearch.mode",
						code: "unsupported_capability",
					}),
					expect.objectContaining({
						path: "codex.compaction.mode",
						code: "unsupported_capability",
					}),
				]),
			});
		}
	});

	test("exposes explicit unsupported and disabled reasons without inventing availability", () => {
		const config = createDefaultConfig();
		config.tools.backgroundSessions = true;
		const evaluations = evaluateConfigSettings(config, {
			shellSurface: "shell-command",
			bridgeCapabilities: ["responses_sse", "compact_endpoint"],
			providerSupportsWebsockets: false,
			modelAutoCompactTokenLimit: 48_000,
		});

		expect(evaluations).toEqual(
			expect.arrayContaining([
				{
					path: "tools.backgroundSessions",
					availability: {
						status: "unsupported",
						reason: "Unavailable: background sessions apply only to Unified Exec",
					},
				},
				{
					path: "tools.optional.viewImage",
					availability: {
						status: "unsupported",
						reason: "Unavailable: bridge does not advertise view_image",
					},
				},
				{
					path: "codex.transport.mode",
					availability: {
						status: "disabled",
						reason: "WebSocket unavailable for this provider; SSE will be used",
					},
				},
				{
					path: "codex.compaction.autoCompactTokenLimit",
					availability: { status: "enabled" },
				},
			]),
		);
	});

	test("allows a valid numeric threshold below the context window", () => {
		const config = createDefaultConfig();
		const draft = {
			...config,
			codex: {
				...config.codex,
				compaction: { mode: "auto" as const, autoCompactTokenLimit: 48_000 },
				webSearch: { mode: "disabled" as const },
			},
		};
		expect(
			validateConfigForSave(draft, {
				contextWindow: 100_000,
				bridgeCapabilities: ["responses_sse", "compact_endpoint"],
			}),
		).toEqual(draft);
	});

	test("requires an explicit non-empty unique provider activation list", () => {
		const config = createDefaultConfig();
		expect(() => parseConfig({ ...config, activation: { providers: [] } })).toThrow(
			ConfigurationError,
		);
		expect(() =>
			parseConfig({ ...config, activation: { providers: ["openai-codex", "openai-codex"] } }),
		).toThrow(ConfigurationError);
		expect(() => parseConfig({ ...config, activation: { providers: ["   "] } })).toThrow(
			ConfigurationError,
		);
	});

	test("rejects the removed schema version and legacy OpenAI root", () => {
		const config = createDefaultConfig();
		expect(() =>
			parseConfig({
				...config,
				schemaVersion: 1,
				openai: config.codex,
			}),
		).toThrow(ConfigurationError);
	});
});

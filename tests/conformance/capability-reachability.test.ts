import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ResolveEffectiveCapabilities } from "../../src/application/resolve-effective-capabilities.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import { createIntegrationRuntime } from "../integration/helpers/native-bridge.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (shutdowns.length > 0) await shutdowns.pop()?.();
});

describe("bundled capability reachability", () => {
	test("every visible API model can execute every default-enabled capability", async () => {
		const catalog = JSON.parse(
			await readFile(
				resolve(repositoryRoot, "native/vendor/openai-codex/codex-rs/models-manager/models.json"),
				"utf8",
			),
		) as { models?: unknown[] };
		const models = (catalog.models ?? [])
			.map(record)
			.filter(
				(model): model is Record<string, unknown> =>
					model !== undefined && model.visibility === "list" && model.supported_in_api === true,
			);
		expect(models.length).toBeGreaterThan(0);

		const { runtime } = await createIntegrationRuntime();
		shutdowns.push(() => runtime.shutdown());
		const resolver = new ResolveEffectiveCapabilities(runtime);
		for (const model of models) {
			const modelId = String(model.slug);
			const contextWindow = Number(model.context_window);
			const snapshot = await resolver.resolve({
				modelId,
				providerId: "openai-codex",
				config: createDefaultConfig(),
				contextWindow,
			});
			expect(snapshot.localTools, modelId).toContain("update_plan");
			expect(snapshot.shell.bounded.status, modelId).toBe("available");
			expect(snapshot.shell.sessions, modelId).toEqual({
				status: "available",
				source: "supplemental",
			});
			expect(snapshot.localTools, modelId).toContain("shell_command");
			expect(snapshot.localTools, modelId).toContain("exec_command");
			expect(snapshot.localTools, modelId).toContain("write_stdin");
			expect(snapshot.applyPatch.status, modelId).toBe("available");
			expect(snapshot.viewImage.status, modelId).toBe("available");
			expect(snapshot.imageGeneration.status, modelId).toBe("available");
			expect(snapshot.webSearch.status, modelId).toBe("available");
			expect(snapshot.compaction.manual.status, modelId).toBe("available");
			expect(snapshot.compaction.automatic.status, modelId).toBe("available");
			expect(snapshot.compaction.modelThreshold, modelId).toBe(Math.floor(contextWindow * 0.9));
			expect(snapshot.transport.status, modelId).toBe("available");

			const modelVisibleNames = responseToolNames(snapshot.modelTools);
			for (const localTool of snapshot.localTools) {
				expect(modelVisibleNames, `${modelId}:${localTool}`).toContain(localTool);
			}
		}
	}, 60_000);
});

function responseToolNames(tools: readonly unknown[]): string[] {
	const names: string[] = [];
	for (const value of tools) {
		const tool = record(value);
		if (tool === undefined) continue;
		if (typeof tool.name === "string" && tool.type !== "namespace") names.push(tool.name);
		if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
			for (const nestedValue of tool.tools) {
				const nested = record(nestedValue);
				if (typeof nested?.name === "string") names.push(`${tool.name}.${nested.name}`);
			}
		}
	}
	return names;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

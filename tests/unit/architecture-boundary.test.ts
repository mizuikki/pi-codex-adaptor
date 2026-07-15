import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
	analyzeSource,
	classifyImport,
	collectArchitectureViolations,
} from "../../scripts/check-architecture.ts";

const domainFile = resolve("src/domain/config.ts");
const applicationFile = resolve("src/application/diagnostics.ts");

describe("architecture dependency boundary", () => {
	test("rejects Pi, TUI, filesystem, HTTP, and process imports in domain and application", () => {
		const cases: Array<{ layer: "domain" | "application"; file: string; specifier: string }> = [
			{ layer: "domain", file: domainFile, specifier: "@earendil-works/pi-ai" },
			{ layer: "application", file: applicationFile, specifier: "@earendil-works/pi-tui" },
			{ layer: "domain", file: domainFile, specifier: "node:fs" },
			{ layer: "application", file: applicationFile, specifier: "node:fs/promises" },
			{ layer: "domain", file: domainFile, specifier: "node:http" },
			{ layer: "application", file: applicationFile, specifier: "node:https" },
			{ layer: "domain", file: domainFile, specifier: "node:child_process" },
			{ layer: "application", file: applicationFile, specifier: "child_process" },
			{
				layer: "application",
				file: applicationFile,
				specifier: "../infrastructure/codex-bridge/client.ts",
			},
			{
				layer: "application",
				file: applicationFile,
				specifier: "../ui/terminal/settings-model.ts",
			},
			{ layer: "domain", file: domainFile, specifier: "../integration/pi/codex-provider.ts" },
		];

		for (const entry of cases) {
			const reason = classifyImport(entry.file, entry.layer, entry.specifier);
			expect(reason, `${entry.layer} import ${entry.specifier}`).toBeString();
		}
	});

	test("allows domain-to-domain and application-to-domain imports", () => {
		expect(classifyImport(domainFile, "domain", "./redaction.ts")).toBeUndefined();
		expect(classifyImport(applicationFile, "application", "../domain/config.ts")).toBeUndefined();
		expect(classifyImport(applicationFile, "application", "./configuration.ts")).toBeUndefined();
	});

	test("detects forbidden imports from source text", () => {
		const violations = analyzeSource(
			applicationFile,
			[
				'import fs from "node:fs";',
				'import { something } from "@earendil-works/pi-coding-agent";',
				'export { x } from "../infrastructure/diagnostics/file-diagnostics-exporter.ts";',
			].join("\n"),
			"application",
		);
		expect(violations.map((violation) => violation.specifier).sort()).toEqual([
			"../infrastructure/diagnostics/file-diagnostics-exporter.ts",
			"@earendil-works/pi-coding-agent",
			"node:fs",
		]);
	});

	test("passes for the current domain and application trees", async () => {
		const violations = await collectArchitectureViolations();
		expect(violations).toEqual([]);
	});
});

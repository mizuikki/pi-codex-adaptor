import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	createDiagnosticsSnapshot,
	exportDiagnosticsConfirmed,
} from "../../src/application/diagnostics.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import {
	DiagnosticsStorageError,
	FileDiagnosticsExporter,
} from "../../src/infrastructure/diagnostics/file-diagnostics-exporter.ts";

const CHECKSUM = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("file diagnostics exporter", () => {
	test("writes a hashed redacted diagnostic snapshot", async () => {
		const directory = await mkdtemp(resolve(tmpdir(), "pi-codex-diagnostics-"));
		const path = resolve(directory, "diagnostics.json");
		try {
			const result = await new FileDiagnosticsExporter().export(
				{
					schemaVersion: 1,
					configSchemaVersion: 1,
					bridge: { bridgeProtocolVersion: 1 },
					recentErrors: [],
				},
				path,
			);
			expect(result.path).toBe(path);
			expect(result.sha256).toHaveLength(64);
			expect(await readFile(path, "utf8")).toContain('"bridgeProtocolVersion": 1');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("exports the expanded allowlist after confirmation and strips secrets", async () => {
		const directory = await mkdtemp(resolve(tmpdir(), "pi-codex-diagnostics-"));
		const path = join(directory, "out", "diagnostics.json");
		try {
			const snapshot = createDiagnosticsSnapshot(
				createDefaultConfig(),
				{
					bridgeProtocolVersion: 1,
					officialCodexVersion: "0.144.3",
					capabilities: ["responses_sse"],
					prompt: "private",
				},
				{
					adaptorVersion: "0.0.0",
					os: "linux",
					arch: "x64",
					binaryChecksum: CHECKSUM,
					recentErrors: [
						{
							category: "ProtocolError",
							code: "invalid_frame",
							message: "Bridge frame does not match protocol v1",
						},
					],
				},
			);
			const result = await exportDiagnosticsConfirmed(
				new FileDiagnosticsExporter(),
				{
					...snapshot,
					bridge: { ...snapshot.bridge, token: "secret" },
				} as typeof snapshot,
				path,
				{ confirmed: true },
			);
			const body = await readFile(path, "utf8");
			expect(result.sha256).toHaveLength(64);
			expect(body).toContain('"adaptor"');
			expect(body).toContain('"runtime"');
			expect(body).toContain(CHECKSUM);
			expect(body).toContain("ProtocolError");
			expect(body).not.toContain("secret");
			expect(body).not.toContain("private");
			expect(body).not.toContain('schemaVersion": 1,\n  "tools"');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("fails when the export target cannot be written", async () => {
		const directory = await mkdtemp(resolve(tmpdir(), "pi-codex-diagnostics-"));
		try {
			// Use the temporary directory itself as the export path so rename/open fails.
			await expect(
				new FileDiagnosticsExporter().export(
					{
						schemaVersion: 1,
						configSchemaVersion: 1,
						bridge: { bridgeProtocolVersion: 1 },
						recentErrors: [],
					},
					directory,
				),
			).rejects.toBeInstanceOf(DiagnosticsStorageError);
			expect((await stat(directory)).isDirectory()).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

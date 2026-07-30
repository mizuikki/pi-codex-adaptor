import { describe, expect, test } from "bun:test";

import {
	createDiagnosticsSnapshot,
	DiagnosticsExportError,
	type DiagnosticsExporter,
	type DiagnosticsSnapshot,
	exportDiagnosticsConfirmed,
	sanitizeSnapshot,
} from "../../src/application/diagnostics.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";

const CHECKSUM = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("redacted diagnostics", () => {
	test("exports only the allowlisted bridge identity fields by default", () => {
		const snapshot = createDiagnosticsSnapshot(createDefaultConfig(), {
			bridgeProtocolVersion: 5,
			officialCodexVersion: "0.146.0",
			capabilities: ["responses_sse"],
			prompt: "private prompt",
			token: "private token",
			absolutePath: "/private/path",
			compaction: { output: "opaque" },
		});

		expect(snapshot).toEqual({
			schemaVersion: 2,
			configSchemaVersion: 3,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			bridge: {
				bridgeProtocolVersion: 5,
				officialCodexVersion: "0.146.0",
				capabilities: ["responses_sse"],
			},
			recentErrors: [],
		});
	});

	test("drops opaque compaction payloads from bridge diagnostics", () => {
		const snapshot = createDiagnosticsSnapshot(createDefaultConfig(), {
			bridgeProtocolVersion: 5,
			officialCodexVersion: "0.146.0",
			capabilities: ["responses_sse", "remote_compaction_v2"],
			compaction: {
				summary: "secret summary",
				opaque: "opaque fixture",
			},
		});

		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("secret summary");
		expect(serialized).not.toContain("opaque fixture");
		expect(snapshot.bridge).toEqual({
			bridgeProtocolVersion: 5,
			officialCodexVersion: "0.146.0",
			capabilities: ["responses_sse", "remote_compaction_v2"],
		});
	});

	test("includes host-sourced adaptor, Pi, OS/arch, checksum, and safe recent errors", () => {
		const snapshot = createDiagnosticsSnapshot(
			createDefaultConfig(),
			{
				bridgeProtocolVersion: 5,
				officialCodexTag: "rust-v0.146.0",
				officialSourceCommit: "e363b08c9175ac1cbe5893615dd2cb9ddf95043b",
				buildTarget: "x86_64-unknown-linux-musl",
				buildSourceCommit: "development",
				vendorTreeSha256: CHECKSUM,
				capabilities: ["responses_sse", "compact_endpoint"],
				token: "must-not-export",
			},
			{
				adaptorVersion: "0.0.0",
				piVersion: "0.81.1",
				os: "linux",
				arch: "x64",
				binaryChecksum: CHECKSUM,
				recentErrors: [
					{
						category: "CapabilityError",
						code: "unsupported",
						message: "The requested capability is unavailable",
						requestId: "request-1",
						retryable: false,
						token: "secret",
					},
					{
						category: "AuthenticationError",
						code: "invalid",
						message: "token leaked here",
					},
					{
						category: "NativeToolError",
						code: "path",
						message: "/home/user/secret",
					},
				],
			},
		);

		expect(snapshot).toEqual({
			schemaVersion: 2,
			configSchemaVersion: 3,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			adaptor: { version: "0.0.0" },
			pi: { version: "0.81.1" },
			runtime: { os: "linux", arch: "x64" },
			bridge: {
				bridgeProtocolVersion: 5,
				officialCodexTag: "rust-v0.146.0",
				officialSourceCommit: "e363b08c9175ac1cbe5893615dd2cb9ddf95043b",
				buildTarget: "x86_64-unknown-linux-musl",
				buildSourceCommit: "development",
				vendorTreeSha256: CHECKSUM,
				capabilities: ["responses_sse", "compact_endpoint"],
			},
			recentErrors: [
				{
					category: "CapabilityError",
					code: "unsupported",
					message: "The requested capability is unavailable",
					requestId: "request-1",
					retryable: false,
				},
			],
			binaryChecksum: CHECKSUM,
		});
		expect(JSON.stringify(snapshot)).not.toContain("must-not-export");
		expect(JSON.stringify(snapshot)).not.toContain("token leaked");
		expect(JSON.stringify(snapshot)).not.toContain("/home/user");
	});

	test("omits inventable host fields and rejects path-like identities", () => {
		const snapshot = createDiagnosticsSnapshot(
			createDefaultConfig(),
			{},
			{
				adaptorVersion: "/home/user/.pi",
				piVersion: "",
				os: "linux",
				// arch omitted on purpose
				binaryChecksum: "not-a-checksum",
			},
		);
		expect(snapshot.adaptor).toBeUndefined();
		expect(snapshot.pi).toBeUndefined();
		expect(snapshot.runtime).toBeUndefined();
		expect(snapshot.binaryChecksum).toBeUndefined();
	});

	test("requires confirmation before export and re-sanitizes mutated snapshots", async () => {
		const captured: DiagnosticsSnapshot[] = [];
		const exporter: DiagnosticsExporter = {
			export: async (snapshot) => {
				captured.push(snapshot);
				return { path: "unused", sha256: CHECKSUM };
			},
		};
		const snapshot = createDiagnosticsSnapshot(createDefaultConfig(), {
			bridgeProtocolVersion: 5,
		});
		const mutated = {
			...snapshot,
			bridge: {
				...snapshot.bridge,
				token: "secret-token",
				prompt: "private",
			},
			secrets: { apiKey: "x" },
		} as DiagnosticsSnapshot;

		await expect(
			exportDiagnosticsConfirmed(exporter, mutated, "diagnostics.json", { confirmed: false }),
		).rejects.toMatchObject({
			name: "DiagnosticsExportError",
			code: "confirmation_required",
		});

		const result = await exportDiagnosticsConfirmed(exporter, mutated, "diagnostics.json", {
			confirmed: true,
		});
		expect(result.sha256).toBe(CHECKSUM);
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({
			schemaVersion: 2,
			configSchemaVersion: 3,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			bridge: { bridgeProtocolVersion: 5 },
			recentErrors: [],
		});
		expect(JSON.stringify(captured[0])).not.toContain("secret-token");
	});

	test("maps exporter failures to a stable diagnostics export error", async () => {
		const exporter: DiagnosticsExporter = {
			export: async () => {
				throw new Error("disk full");
			},
		};
		await expect(
			exportDiagnosticsConfirmed(
				exporter,
				createDiagnosticsSnapshot(createDefaultConfig(), {}),
				"diagnostics.json",
				{ confirmed: true },
			),
		).rejects.toBeInstanceOf(DiagnosticsExportError);
	});

	test("sanitizeSnapshot never serializes configuration values", () => {
		const snapshot = sanitizeSnapshot({
			schemaVersion: 2,
			configSchemaVersion: 3,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			bridge: { bridgeProtocolVersion: 5, config: createDefaultConfig() as unknown as string },
			recentErrors: [],
		});
		expect(snapshot.bridge).toEqual({ bridgeProtocolVersion: 5 });
	});
});

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
			bridgeProtocolVersion: 3,
			officialCodexVersion: "0.144.3",
			capabilities: ["responses_sse"],
			prompt: "private prompt",
			token: "private token",
			absolutePath: "/private/path",
			compaction: { output: "opaque" },
		});

		expect(snapshot).toEqual({
			schemaVersion: 2,
			configSchemaVersion: 2,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			bridge: {
				bridgeProtocolVersion: 3,
				officialCodexVersion: "0.144.3",
				capabilities: ["responses_sse"],
			},
			recentErrors: [],
		});
	});

	test("includes host-sourced adaptor, Pi, OS/arch, checksum, and safe recent errors", () => {
		const snapshot = createDiagnosticsSnapshot(
			createDefaultConfig(),
			{
				bridgeProtocolVersion: 3,
				officialCodexTag: "rust-v0.144.3",
				officialSourceCommit: "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c",
				buildTarget: "x86_64-unknown-linux-musl",
				buildSourceCommit: "development",
				vendorTreeSha256: CHECKSUM,
				capabilities: ["responses_sse", "compact_endpoint"],
				token: "must-not-export",
			},
			{
				adaptorVersion: "0.0.0",
				piVersion: "0.80.6",
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
			configSchemaVersion: 2,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			adaptor: { version: "0.0.0" },
			pi: { version: "0.80.6" },
			runtime: { os: "linux", arch: "x64" },
			bridge: {
				bridgeProtocolVersion: 3,
				officialCodexTag: "rust-v0.144.3",
				officialSourceCommit: "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c",
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
			bridgeProtocolVersion: 3,
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
			configSchemaVersion: 2,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			bridge: { bridgeProtocolVersion: 3 },
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
			configSchemaVersion: 2,
			activation: {
				providerCount: 1,
				supportedApis: ["openai-responses", "openai-codex-responses"],
			},
			bridge: { bridgeProtocolVersion: 3, config: createDefaultConfig() as unknown as string },
			recentErrors: [],
		});
		expect(snapshot.bridge).toEqual({ bridgeProtocolVersion: 3 });
	});
});

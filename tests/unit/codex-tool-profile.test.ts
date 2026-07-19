import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import {
	createCodexToolProfile,
	isPiCoreAgentToolName,
	normalizedEntryPath,
	PI_CORE_AGENT_TOOL_NAMES,
	reconcileCodexActiveToolNames,
	restorePiActiveToolNames,
	validateManagedToolOwnership,
} from "../../src/integration/pi/codex-tool-profile.ts";
import { selectCodexToolSurface } from "../../src/integration/pi/codex-tool-surface.ts";

const entryPath = "/synthetic/extension.ts";

function tool(name: string, path = entryPath): ToolInfo {
	return {
		name,
		description: `synthetic ${name}`,
		parameters: { type: "object", properties: {} },
		sourceInfo: {
			path,
			source: "synthetic",
			scope: "temporary",
			origin: "top-level",
		},
	};
}

function profileFixture(options?: {
	active?: string[];
	available?: string[];
	entryPath?: string;
	toolSourcePath?: string;
}): {
	profile: ReturnType<typeof createCodexToolProfile>;
	get active(): string[];
	set active(value: string[]);
	setCalls: string[][];
} {
	let active = [...(options?.active ?? ["read", "bash", "issue_lookup"])] as string[];
	const available = new Set(
		options?.available ?? [
			...PI_CORE_AGENT_TOOL_NAMES,
			"issue_lookup",
			"db_tool",
			"new_tool",
			"shell_command",
			"exec_command",
		],
	);
	const setCalls: string[][] = [];
	const api = {
		getActiveTools: () => active,
		setActiveTools: (next: string[]) => {
			active = [...next];
			setCalls.push([...next]);
		},
		getAllTools: () =>
			[...available].map((name) => tool(name, options?.toolSourcePath ?? entryPath)),
	} as unknown as ExtensionAPI;
	const profile = createCodexToolProfile(api, options?.entryPath ?? entryPath);
	return {
		profile,
		get active() {
			return active;
		},
		set active(value: string[]) {
			active = [...value];
		},
		setCalls,
	};
}

describe("Codex tool profile policy", () => {
	test("suppresses every Pi core slot and appends only registered managed names", () => {
		const available = new Set([
			...PI_CORE_AGENT_TOOL_NAMES,
			"external",
			"shell_command",
			"apply_patch",
		]);
		expect(
			reconcileCodexActiveToolNames(
				[
					"read",
					"bash",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"external",
					"shell_command",
					"not_registered",
				],
				available,
				["shell_command", "apply_patch", "shell_command", "not_registered"],
			),
		).toEqual(["external", "shell_command", "apply_patch"]);
		for (const name of PI_CORE_AGENT_TOOL_NAMES) expect(isPiCoreAgentToolName(name)).toBe(true);
	});

	test("restores the captured subset with baseline interleaving and current additives", () => {
		const available = new Set(["read", "bash", "issue_lookup", "db_tool", "new_additive"]);
		expect(
			restorePiActiveToolNames(
				["issue_lookup", "db_tool", "shell_command"],
				available,
				["read", "bash", "issue_lookup"],
				["read", "bash"],
			),
		).toEqual(["read", "bash", "issue_lookup", "db_tool"]);
		expect(
			restorePiActiveToolNames(
				["issue_lookup", "db_tool", "shell_command"],
				available,
				["issue_lookup", "read", "bash"],
				["read", "bash"],
			),
		).toEqual(["issue_lookup", "read", "bash", "db_tool"]);
		expect(
			restorePiActiveToolNames(
				["new_additive", "shell_command"],
				new Set(["read", "bash", "new_additive"]),
				["read", "removed_additive", "bash"],
				["read", "bash"],
			),
		).toEqual(["read", "bash", "new_additive"]);
	});

	test("keeps official tools first and filters stale Pi/core/managed definitions", () => {
		const tools = selectCodexToolSurface(
			[
				{ type: "function", name: "shell_command", description: "official" },
				{ type: "namespace", name: "web", tools: [{ name: "run" }] },
			],
			["read", "bash", "third_party", "shell_command", "view_image", "web.run"],
			[
				tool("read"),
				tool("bash"),
				tool("third_party"),
				tool("shell_command"),
				tool("view_image"),
				tool("web.run"),
			],
		);
		expect(tools).toEqual([
			{ type: "function", name: "shell_command", description: "official" },
			{ type: "namespace", name: "web", tools: [{ name: "run" }] },
			{
				type: "function",
				name: "third_party",
				description: "synthetic third_party",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
		]);
	});

	test("captures only active core names, restores them once, and skips no-op writes", () => {
		const fixture = profileFixture();
		fixture.profile.enterPending("key-a");
		expect(fixture.active).toEqual(["issue_lookup"]);
		const pendingWrites = fixture.setCalls.length;
		expect(fixture.profile.installHealthy("key-a", ["shell_command"], "shell_command")).toBe(true);
		expect(fixture.active).toEqual(["issue_lookup", "shell_command"]);
		const healthyWrites = fixture.setCalls.length;
		expect(fixture.profile.revalidateHealthyOwnership()).toBe(true);
		expect(fixture.setCalls.length).toBe(healthyWrites);
		fixture.active = ["issue_lookup", "db_tool", "shell_command", "new_tool"];
		fixture.profile.restorePi();
		expect(fixture.active).toEqual(["read", "bash", "issue_lookup", "db_tool", "new_tool"]);
		expect(fixture.profile.readiness).toEqual({ kind: "inactive" });
		expect(fixture.setCalls.length).toBeGreaterThan(pendingWrites);
		fixture.profile.restorePi();
		expect(fixture.setCalls.at(-1)).toEqual(fixture.active);
	});

	test("does not restore disabled or no-longer-registered Pi core slots", () => {
		const disabled = profileFixture({ active: ["read", "issue_lookup"] });
		disabled.profile.enterPending("key-disabled");
		disabled.profile.installHealthy("key-disabled", ["shell_command"], "shell_command");
		disabled.active = ["issue_lookup", "shell_command"];
		disabled.profile.restorePi();
		expect(disabled.active).toEqual(["read", "issue_lookup"]);

		const removed = profileFixture({
			active: ["read", "bash", "issue_lookup"],
			available: ["read", "issue_lookup", "shell_command"],
		});
		removed.profile.enterPending("key-removed");
		removed.profile.installHealthy("key-removed", ["shell_command"], "shell_command");
		removed.active = ["issue_lookup", "shell_command"];
		removed.profile.restorePi();
		expect(removed.active).toEqual(["read", "issue_lookup"]);
	});

	test("normalizes exact ownership paths while ignoring provenance labels", () => {
		expect(normalizedEntryPath("/synthetic/project/../extension.ts")).toBe(
			normalizedEntryPath("/synthetic/extension.ts"),
		);
		const owned = tool("shell_command", "/synthetic/project/./extension.ts");
		owned.sourceInfo = {
			...owned.sourceInfo,
			source: "sdk",
			scope: "user",
			origin: "package",
		};
		expect(
			validateManagedToolOwnership([owned], ["shell_command"], "/synthetic/project/extension.ts"),
		).toEqual({ ok: true });
	});

	test("keeps ownership stable across project, explicit, and packaged path forms", () => {
		const pathVariants = [
			{
				entryPath: "/synthetic/project/src/extension.ts",
				toolSourcePath: "/synthetic/project/src/./extension.ts",
			},
			{
				entryPath: "/synthetic/project/src/extension.ts",
				toolSourcePath: "/synthetic/project/src/../src/extension.ts",
			},
			{
				entryPath: "/synthetic/package/src/extension.ts",
				toolSourcePath: "/synthetic/package/src/./extension.ts",
			},
		];
		for (const { entryPath, toolSourcePath } of pathVariants) {
			const fixture = profileFixture({
				entryPath,
				toolSourcePath,
			});
			fixture.profile.enterPending(`key-${toolSourcePath}`);
			expect(
				fixture.profile.installHealthy(`key-${toolSourcePath}`, ["shell_command"], "shell_command"),
			).toBe(true);
		}

		const laterExtension = tool("shell_command", entryPath);
		laterExtension.sourceInfo = {
			...laterExtension.sourceInfo,
			source: "later-extension",
			scope: "project",
			origin: "package",
		};
		expect(validateManagedToolOwnership([laterExtension], ["shell_command"], entryPath)).toEqual({
			ok: true,
		});
	});

	test("canonicalizes real symlink entry paths before ownership comparison", async () => {
		const directory = await mkdtemp(join(tmpdir(), "codex-tool-profile-"));
		try {
			const target = join(directory, "extension.ts");
			const linked = join(directory, "linked-extension.ts");
			await writeFile(target, "export default function fixture() {}\n", "utf8");
			await symlink(target, linked);

			expect(normalizedEntryPath(linked)).toBe(normalizedEntryPath(target));
			expect(
				validateManagedToolOwnership([tool("shell_command", linked)], ["shell_command"], target),
			).toEqual({
				ok: true,
			});
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("rejects earlier-extension and SDK winners while accepting a later non-displacing entry", () => {
		const earlierWinner = tool("shell_command", "/synthetic/earlier-extension.ts");
		earlierWinner.sourceInfo = {
			...earlierWinner.sourceInfo,
			source: "local",
			scope: "project",
		};
		expect(validateManagedToolOwnership([earlierWinner], ["shell_command"], entryPath)).toEqual({
			ok: false,
			conflictingTool: "shell_command",
		});

		const sdkWinner = tool("shell_command", "<sdk:shell_command>");
		sdkWinner.sourceInfo = {
			...sdkWinner.sourceInfo,
			source: "sdk",
			scope: "temporary",
		};
		expect(validateManagedToolOwnership([sdkWinner], ["shell_command"], entryPath)).toEqual({
			ok: false,
			conflictingTool: "shell_command",
		});

		const laterNonDisplacingEntry = tool("shell_command", entryPath);
		expect(
			validateManagedToolOwnership([laterNonDisplacingEntry], ["shell_command"], entryPath),
		).toEqual({ ok: true });
	});

	test("fails closed when a resolved managed tool is not owned by the entry", () => {
		const fixture = profileFixture({
			active: ["read", "third_party"],
			available: [
				...PI_CORE_AGENT_TOOL_NAMES,
				"third_party",
				"shell_command",
				"view_image",
				"exec_command",
			],
			entryPath: "/other/extension.ts",
		});
		fixture.profile.enterPending("key-a");
		const notifications: string[] = [];
		expect(
			fixture.profile.installHealthy(
				"key-a",
				["shell_command", "view_image"],
				"shell_command",
				(message) => notifications.push(message),
			),
		).toBe(false);
		expect(fixture.active).toEqual(["third_party"]);
		expect(fixture.profile.skillLoader).toBeUndefined();
		expect(fixture.profile.readiness).toEqual({ kind: "unavailable", capabilityKey: "key-a" });
		expect(notifications).toEqual([
			"Codex unavailable: managed tool ownership conflict for shell_command",
		]);
		fixture.profile.installUnavailable("key-a", "shell_command", (message) =>
			notifications.push(message),
		);
		expect(notifications).toHaveLength(1);
		expect(JSON.stringify(notifications)).not.toContain("/synthetic/extension.ts");
	});
});

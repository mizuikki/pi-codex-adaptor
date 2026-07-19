import { describe, expect, test } from "bun:test";

import piCodexAdaptor from "../../src/extension.ts";

describe("extension tool smoke", () => {
	test("registers core tools and preserves third-party active tools on a minimal Pi API", async () => {
		const tools: string[] = [];
		let active = ["third_party"];
		const events: string[] = [];
		await piCodexAdaptor({
			registerCommand: () => {},
			registerProvider: () => {},
			registerTool: (tool: { name: string }) => {
				tools.push(tool.name);
			},
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => {
				active = next;
			},
			getAllTools: () => tools.map((name) => ({ name })),
			getThinkingLevel: () => "off",
			on: (name: string) => {
				events.push(name);
			},
		} as never);

		expect(tools).toEqual([
			"update_plan",
			"exec_command",
			"write_stdin",
			"shell_command",
			"apply_patch",
			"view_image",
			"image_gen.imagegen",
			"web.run",
		]);
		expect(events).toEqual(
			expect.arrayContaining(["session_shutdown", "session_start", "model_select"]),
		);
		expect(active).toEqual(["third_party"]);
	});
});

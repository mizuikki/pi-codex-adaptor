import { describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../../src/domain/config.ts";
import { SETTINGS_CATEGORIES, SettingsModel } from "../../src/ui/terminal/settings-model.ts";

function model(): SettingsModel {
	return new SettingsModel(createDefaultConfig(), {
		baseline: "0.144.3",
		provider: "openai",
		model: "unresolved",
		bridge: "pending",
	});
}

describe("settings view model", () => {
	test("keeps a draft until save and supports category navigation", () => {
		const view = model();
		expect(view.category).toBe("General");
		view.moveCategory(1);
		expect(view.category).toBe("Tools");
		view.toggleFocused();
		expect(view.draft.tools.backgroundSessions).toBe(false);
		expect(view.state).toBe("dirty");
		view.discard();
		expect(view.draft.tools.backgroundSessions).toBe(true);
		expect(view.state).toBe("pristine");
	});

	test("supports wide, medium, and narrow layouts", () => {
		const view = model();
		expect(view.layoutFor(120)).toBe("wide");
		expect(view.layoutFor(80)).toBe("medium");
		expect(view.layoutFor(40)).toBe("narrow");
		expect(view.setWidth(120)).toBe("wide");
		expect(view.setWidth(80)).toBe("medium");
		expect(view.setWidth(40)).toBe("narrow");
		expect(SETTINGS_CATEGORIES).toEqual(["General", "Tools", "OpenAI", "Diagnostics"]);
	});

	test("cycles enum fields without writing the configuration", () => {
		const view = model();
		view.moveCategory(1);
		view.moveCategory(1);
		view.moveFocus(1);
		view.cycleFocused();
		expect(view.draft.openai.verbosity).toBe("medium");
		expect(view.state).toBe("dirty");
	});

	test("edits the auto compact threshold in the draft only", () => {
		const view = model();
		view.moveCategory(1);
		view.moveCategory(1);
		expect(view.rows().map((row) => row.id)).toContain("autoCompactTokenLimit");
		view.setAutoCompactTokenLimit(48_000);
		expect(view.draft.openai.compaction).toEqual({
			mode: "auto",
			autoCompactTokenLimit: 48_000,
		});
		expect(view.state).toBe("dirty");
	});

	test.each([120, 80, 40])("renders bounded monochrome lines at width %d", (width) => {
		const view = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-provider-with-a-deliberately-long-display-identifier",
			model: "model-with-a-deliberately-long-display-identifier",
			bridge: "pending",
		});
		const lines = view.lines(width);

		expect(lines.every((line) => line.length <= width)).toBe(true);
		expect(lines.join("\n")).not.toContain("\u001b[");
	});

	test("applies defaults to the draft through the explicit reset path", () => {
		const view = model();
		view.moveCategory(1);
		view.toggleFocused();
		expect(view.state).toBe("dirty");
		view.applyDefaultsToDraft();
		expect(view.draft).toEqual(createDefaultConfig());
		expect(view.state).toBe("dirty");
		expect(view.message).toContain("[info]");
	});

	test("ignores mutations after dispose", () => {
		const view = model();
		view.dispose();
		view.toggleFocused();
		expect(view.state).toBe("pristine");
		expect(view.handleKey(" ")).toEqual({ type: "none" });
		expect(view.lines(80)).toEqual(["Settings closed"]);
	});
});

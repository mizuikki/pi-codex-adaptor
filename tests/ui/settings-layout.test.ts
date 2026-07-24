import { describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../../src/domain/config.ts";
import { isMonochromeEnvironment } from "../../src/ui/terminal/render.ts";
import { SettingsModel } from "../../src/ui/terminal/settings-model.ts";

function createView(): SettingsModel {
	return new SettingsModel(createDefaultConfig(), {
		baseline: "0.144.3",
		provider: "openai-codex-with-a-deliberately-long-provider-identifier",
		model: "gpt-model-with-a-deliberately-long-model-identifier",
		bridge: "protocol v5",
		capabilities: ["responses", "compact", "unified-exec"],
		disabledReasons: {
			imageGeneration: "Unavailable: provider does not advertise image generation.",
		},
	});
}

function snapshot(view: SettingsModel, width: number): string {
	return view.lines(width).join("\n");
}

describe("settings layout snapshots", () => {
	test("wide layout uses a left category column and settings list", () => {
		const view = createView();
		view.setWidth(120);
		const text = snapshot(view, 120);

		expect(view.layoutFor(120)).toBe("wide");
		expect(text).toContain("[General]");
		expect(text).toContain("Tools");
		expect(text).toContain("Baseline");
		expect(text).toContain("Pinned OpenAI Codex runtime baseline.");
		expect(text).toContain("Tab region");
		expect(text.split("\n").every((line) => line.length <= 120)).toBe(true);
		expect(text).not.toContain("\u001b");
	});

	test("medium layout uses a top category tab row", () => {
		const view = createView();
		const text = snapshot(view, 80);

		expect(view.layoutFor(80)).toBe("medium");
		expect(text).toContain("[General]  Tools  Codex  Diagnostics");
		expect(text).toContain("Status bar");
		expect(text).not.toContain("Select section");
		expect(text.split("\n").every((line) => line.length <= 80)).toBe(true);
	});

	test("narrow layout starts on a category picker and opens one section", () => {
		const view = createView();
		const categories = snapshot(view, 48);
		expect(view.layoutFor(48)).toBe("narrow");
		expect(view.narrowScreen).toBe("categories");
		expect(categories).toContain("Select section");
		expect(categories).toContain("> General");
		expect(categories).toContain("Enter open");
		expect(categories).toContain("Esc close");

		expect(view.handleKey("\r")).toEqual({ type: "none" });
		expect(view.narrowScreen).toBe("settings");
		const section = snapshot(view, 48);
		expect(section).toContain("General");
		expect(section).toContain("Baseline");
		expect(section).toMatch(/Esc back|Esc close|Ctrl\+S/);
		expect(section).not.toContain("Select section");

		expect(view.handleKey("\u001b")).toEqual({ type: "none" });
		expect(view.narrowScreen).toBe("categories");
	});

	test("resize preserves category, focus, and dirty draft", () => {
		const view = createView();
		view.setWidth(120);
		view.moveCategory(1);
		view.toggleFocused();
		view.moveFocus(1);
		expect(view.category).toBe("Tools");
		expect(view.focus).toBe(1);
		expect(view.state).toBe("dirty");

		const medium = snapshot(view, 80);
		expect(view.category).toBe("Tools");
		expect(view.focus).toBe(1);
		expect(view.state).toBe("dirty");
		expect(medium).toContain("[Tools]");
		expect(medium).toContain("[modified]");

		const narrow = snapshot(view, 40);
		expect(view.category).toBe("Tools");
		expect(view.focus).toBe(1);
		expect(view.state).toBe("dirty");
		expect(narrow).toContain("[modified]");
	});

	test("monochrome NO_COLOR and TERM=dumb environments stay plain text", () => {
		expect(isMonochromeEnvironment({ NO_COLOR: "1", TERM: "xterm-256color" })).toBe(true);
		expect(isMonochromeEnvironment({ TERM: "dumb" })).toBe(true);
		expect(isMonochromeEnvironment({ TERM: "" })).toBe(true);
		expect(isMonochromeEnvironment({ FORCE_COLOR: "1", TERM: "dumb" })).toBe(false);

		const view = createView();
		view.moveCategory(1);
		view.toggleFocused();
		for (const width of [120, 80, 40]) {
			const text = snapshot(view, width);
			expect(text.includes(String.fromCharCode(27))).toBe(false);
			expect(text).toContain("[modified]");
			expect(text.split("\n").every((line) => line.length <= width)).toBe(true);
		}
	});

	test("disabled capability rows expose textual reasons", () => {
		const view = createView();
		view.setCategory("Tools");
		view.moveFocus(1);
		view.moveFocus(1);
		view.moveFocus(1);
		const text = snapshot(view, 100);
		expect(text).toContain("[disabled]");
		expect(text).toContain("provider does not advertise image generation");
	});
});

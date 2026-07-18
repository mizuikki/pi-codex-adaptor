import { describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../../src/domain/config.ts";
import { SettingsModel } from "../../src/ui/terminal/settings-model.ts";

function model(): SettingsModel {
	return new SettingsModel(createDefaultConfig(), {
		baseline: "0.144.3",
		provider: "openai",
		model: "unresolved",
		bridge: "pending",
	});
}

describe("settings keyboard state machine", () => {
	test("opens help and returns with contextual close keys", () => {
		const view = model();
		expect(view.handleKey("?")).toEqual({ type: "none" });
		expect(view.dialog).toEqual({ kind: "help" });
		const help = view.lines(80).join("\n");
		expect(help).toContain("Codex settings help");
		expect(help).toContain("Ctrl+S");
		expect(view.handleKey("\u001b")).toEqual({ type: "none" });
		expect(view.dialog).toEqual({ kind: "none" });
	});

	test("dirty escape defaults to continue editing", () => {
		const view = model();
		view.setWidth(100);
		view.moveCategory(1);
		view.toggleFocused();
		expect(view.state).toBe("dirty");
		expect(view.handleKey("\u001b")).toEqual({ type: "none" });
		expect(view.dialog).toEqual({ kind: "dirty-close", focus: 0 });
		const dialog = view.lines(80).join("\n");
		expect(dialog).toContain("> Continue editing");
		expect(dialog).toContain("Discard changes");
		expect(dialog).toContain("Save");
		expect(dialog).toContain("Default: Continue editing");

		expect(view.handleKey("\r")).toEqual({ type: "none" });
		expect(view.dialog).toEqual({ kind: "none" });
		expect(view.state).toBe("dirty");
	});

	test("dirty discard and save choices emit close effects", () => {
		const discard = model();
		discard.moveCategory(1);
		discard.toggleFocused();
		discard.handleKey("\u001b");
		discard.handleKey("\u001b[B");
		expect(discard.dialog).toEqual({ kind: "dirty-close", focus: 1 });
		expect(discard.handleKey("\r")).toEqual({ type: "close" });
		expect(discard.state).toBe("pristine");

		const save = model();
		save.moveCategory(1);
		save.toggleFocused();
		save.handleKey("\u001b");
		save.handleKey("\u001b[B");
		save.handleKey("\u001b[B");
		expect(save.dialog).toEqual({ kind: "dirty-close", focus: 2 });
		expect(save.handleKey("\r")).toEqual({ type: "save-and-close" });
	});

	test("reset confirmation defaults to cancel and can request defaults", () => {
		const view = model();
		expect(view.handleKey("r")).toEqual({ type: "none" });
		expect(view.dialog).toEqual({ kind: "reset-confirm", focus: 0 });
		expect(view.lines(70).join("\n")).toContain("> Cancel");
		expect(view.handleKey("\r")).toEqual({ type: "none" });
		expect(view.dialog).toEqual({ kind: "none" });

		view.handleKey("r");
		view.handleKey("j");
		expect(view.dialog).toEqual({ kind: "reset-confirm", focus: 1 });
		expect(view.handleKey("\r")).toEqual({ type: "reset-defaults" });
	});

	test("ctrl+s save and category shortcuts remain contextual", () => {
		const view = model();
		view.setWidth(100);
		expect(view.handleKey("\u0013")).toEqual({ type: "save" });
		view.handleKey("]");
		expect(view.category).toBe("Tools");
		view.handleKey("]");
		expect(view.category).toBe("Codex");
		expect(view.handleKey("c")).toEqual({ type: "compact" });
		view.handleKey("]");
		expect(view.category).toBe("Diagnostics");
		expect(view.handleKey("e")).toEqual({ type: "export" });
		expect(view.handleKey("c")).toEqual({ type: "none" });
	});

	test("wide layout tab switches regions and j/k move the active region", () => {
		const view = model();
		view.setWidth(120);
		expect(view.region).toBe("list");
		view.handleKey("\t");
		expect(view.region).toBe("nav");
		view.handleKey("j");
		expect(view.category).toBe("Tools");
		view.handleKey("\t");
		expect(view.region).toBe("list");
		view.handleKey("j");
		expect(view.focus).toBe(1);
	});

	test("pristine escape closes the overlay", () => {
		const view = model();
		expect(view.handleKey("\u001b")).toEqual({ type: "close" });
	});

	test("extended terminal key sequences drive the settings state machine", () => {
		const kitty = model();
		kitty.setWidth(100);
		expect(kitty.handleKey("\u001b[57420u")).toEqual({ type: "none" });
		expect(kitty.focus).toBe(1);
		expect(kitty.handleKey("\u001b[115;5u")).toEqual({ type: "save" });
		expect(kitty.handleKey("\u001b[27u")).toEqual({ type: "close" });

		const modifyOtherKeys = model();
		expect(modifyOtherKeys.handleKey("\u001b[27;1;27~")).toEqual({ type: "close" });
	});
});

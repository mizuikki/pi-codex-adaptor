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

	test("keeps background sessions reversible after they are disabled", () => {
		const config = createDefaultConfig();
		config.tools.backgroundSessions = false;
		const view = new SettingsModel(config, {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "fixture-model",
			bridge: "protocol v5",
		});

		view.setCategory("Tools");
		expect(view.rows().find((row) => row.id === "backgroundSessions")).toMatchObject({
			value: "off",
			enabled: true,
		});
		view.toggleFocused();
		expect(view.draft.tools.backgroundSessions).toBe(true);
		expect(view.state).toBe("dirty");
	});

	test("supports wide, medium, and narrow layouts", () => {
		const view = model();
		expect(view.layoutFor(120)).toBe("wide");
		expect(view.layoutFor(80)).toBe("medium");
		expect(view.layoutFor(40)).toBe("narrow");
		expect(view.setWidth(120)).toBe("wide");
		expect(view.setWidth(80)).toBe("medium");
		expect(view.setWidth(40)).toBe("narrow");
		expect(SETTINGS_CATEGORIES).toEqual(["General", "Tools", "Codex", "Diagnostics"]);
	});

	test("cycles enum fields without writing the configuration", () => {
		const view = model();
		view.moveCategory(1);
		view.moveCategory(1);
		view.moveFocus(1);
		view.cycleFocused();
		expect(view.draft.codex.verbosity).toBe("medium");
		expect(view.state).toBe("dirty");
	});

	test("exposes the approval policy in Tools and keeps prompt as the safe default", () => {
		const view = model();
		view.setCategory("Tools");
		const policy = view.rows().find((row) => row.id === "approvalPolicy");
		expect(policy).toMatchObject({
			label: "Approval policy",
			value: "prompt",
			kind: "enum",
		});
	});

	test("edits the auto compact threshold in the draft only", () => {
		const view = model();
		view.moveCategory(1);
		view.moveCategory(1);
		expect(view.rows().map((row) => row.id)).toContain("autoCompactTokenLimit");
		view.setAutoCompactTokenLimit(48_000);
		expect(view.draft.codex.compaction).toEqual({
			mode: "auto",
			autoCompactTokenLimit: 48_000,
		});
		expect(view.state).toBe("dirty");
	});

	test("reports compact now as disabled when compaction is off", () => {
		const config = createDefaultConfig();
		config.codex.compaction = { mode: "off" };
		const view = new SettingsModel(config, {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "fixture-model",
			bridge: "pending",
		});

		view.setCategory("Codex");
		const compactNow = view.rows().find((row) => row.id === "compactNow");
		expect(compactNow).toMatchObject({
			value: "disabled",
			enabled: false,
			disabledReason: "Compaction is disabled.",
		});
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

	test("recomputes the activation route after successful save and restore", () => {
		const config = createDefaultConfig();
		const view = new SettingsModel(config, {
			baseline: "0.144.3",
			provider: "custom-codex",
			model: "fixture-model",
			bridge: "pending",
			activationModel: { provider: "custom-codex", api: "openai-responses" },
		});

		expect(view.rows().find((row) => row.id === "route")?.value).toBe(
			"inactive (provider not selected: custom-codex)",
		);

		view.setActivationProviders(["openai-codex", "custom-codex"]);
		expect(view.state).toBe("dirty");
		expect(view.rows().find((row) => row.id === "route")?.value).toBe(
			"inactive (provider not selected: custom-codex)",
		);

		const saved = view.beginSave();
		view.markSaved(saved);
		expect(view.state).toBe("saved");
		expect(view.rows().find((row) => row.id === "route")?.value).toBe(
			"active (custom-codex / openai-responses)",
		);

		view.replaceWithSaved(createDefaultConfig());
		expect(view.state).toBe("saved");
		expect(view.rows().find((row) => row.id === "route")?.value).toBe(
			"inactive (provider not selected: custom-codex)",
		);
	});

	test("keeps the last persisted activation route when save fails", () => {
		const config = createDefaultConfig();
		const view = new SettingsModel(config, {
			baseline: "0.144.3",
			provider: "custom-codex",
			model: "fixture-model",
			bridge: "pending",
			activationModel: { provider: "custom-codex", api: "openai-responses" },
		});

		const inactive = "inactive (provider not selected: custom-codex)";
		expect(view.rows().find((row) => row.id === "route")?.value).toBe(inactive);

		view.setActivationProviders(["openai-codex", "custom-codex"]);
		view.markError("Codex settings could not be saved", "write-error");

		expect(view.state).toBe("write-error");
		expect(view.rows().find((row) => row.id === "route")?.value).toBe(inactive);
	});

	test("disables compact now when the current route is inactive", () => {
		const view = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "custom-codex",
			model: "fixture-model",
			bridge: "pending",
			activationModel: { provider: "custom-codex", api: "openai-responses" },
		});

		view.setCategory("Codex");
		const compactNow = view.rows().find((row) => row.id === "compactNow");
		expect(compactNow).toMatchObject({
			value: "inactive",
			enabled: false,
			disabledReason: "Codex route is inactive for the current provider and API.",
		});
	});
});

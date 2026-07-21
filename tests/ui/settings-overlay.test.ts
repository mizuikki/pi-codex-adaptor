import { describe, expect, test } from "bun:test";
import { CodexCompactionCoordinator } from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import type { DiagnosticsSnapshot } from "../../src/application/diagnostics.ts";
import type { ResolveEffectiveCapabilities } from "../../src/application/resolve-effective-capabilities.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { SettingsModel } from "../../src/ui/terminal/settings-model.ts";
import { openSettingsOverlay, SettingsOverlay } from "../../src/ui/terminal/settings-overlay.ts";

function diagnostics(): DiagnosticsSnapshot {
	return {
		schemaVersion: 2,
		configSchemaVersion: 2,
		activation: {
			providerCount: 1,
			supportedApis: ["openai-responses", "openai-codex-responses"],
		},
		bridge: { bridgeProtocolVersion: 3, capabilities: ["responses"] },
	};
}

function createService(config: CodexConfig = createDefaultConfig()) {
	let stored = structuredClone(config);
	const service = {
		async load() {
			return structuredClone(stored);
		},
		async applyDraft(draft: unknown) {
			stored = draft as CodexConfig;
			return structuredClone(stored);
		},
		async resetToDefaults() {
			stored = createDefaultConfig();
			return structuredClone(stored);
		},
		async restoreBackup() {
			return structuredClone(stored);
		},
		get stored() {
			return structuredClone(stored);
		},
	};
	return service as ConfigurationService & { stored: CodexConfig };
}

function createCtx(options?: {
	confirm?: boolean;
	provider?: string;
	api?: string;
	compact?: (options?: { onComplete?: () => void; onError?: (error: Error) => void }) => void;
}) {
	const notifications: string[] = [];
	let compactCalls = 0;
	let customCalls = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/workspace",
		model: {
			provider: options?.provider ?? "openai-codex",
			id: "test-model",
			api: options?.api ?? "openai-codex-responses",
		},
		sessionManager: {
			getSessionId: () => "session-fixture",
		},
		compact(compactOptions?: { onComplete?: () => void; onError?: (error: Error) => void }) {
			compactCalls += 1;
			if (options?.compact !== undefined) {
				options.compact(compactOptions);
				return;
			}
			compactOptions?.onComplete?.();
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			async select() {
				return undefined;
			},
			async confirm() {
				return options?.confirm ?? false;
			},
			async input() {
				return undefined;
			},
			async custom() {
				customCalls += 1;
				return undefined;
			},
		},
		notifications,
		get compactCalls() {
			return compactCalls;
		},
		get customCalls() {
			return customCalls;
		},
	};
	return ctx as unknown as ConstructorParameters<typeof SettingsOverlay>[2] & {
		notifications: string[];
		compactCalls: number;
		customCalls: number;
	};
}

describe("settings overlay disposal", () => {
	test("opens with reduced capability context when resolution fails", async () => {
		const service = createService();
		const ctx = createCtx();
		const resolver = {
			async resolve() {
				throw new Error("fixture capability failure");
			},
		} as unknown as ResolveEffectiveCapabilities;

		await openSettingsOverlay(ctx, service, undefined, undefined, undefined, resolver);

		expect(ctx.notifications).toEqual(["Codex effective capabilities could not be resolved"]);
		expect(ctx.customCalls).toBe(1);
	});

	test("Kitty escape closes a pristine overlay", () => {
		const service = createService();
		const ctx = createCtx();
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		let done = false;
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {
			done = true;
		});

		overlay.handleInput("\u001b[27u");

		expect(done).toBe(true);
		expect(model.disposed).toBe(true);
	});

	test("dispose cancels late save updates", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const service = createService();
		const originalApply = service.applyDraft.bind(service);
		service.applyDraft = async (draft) => {
			await gate;
			return originalApply(draft);
		};
		const ctx = createCtx();
		let done = false;
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {
			done = true;
		});

		model.moveCategory(1);
		model.toggleFocused();
		overlay.handleInput("\u0013");
		overlay.dispose();
		release?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(done).toBe(false);
		expect(model.disposed).toBe(true);
		expect(["dirty", "saving", "validating"]).toContain(model.state);
		expect(ctx.notifications).toEqual([]);
		overlay.handleInput("\u001b");
		expect(done).toBe(false);
	});

	test("reset-to-defaults writes through the configuration service", async () => {
		const service = createService({
			...createDefaultConfig(),
			tools: {
				backgroundSessions: false,
				optional: { viewImage: "off", imageGeneration: "off" },
			},
		});
		const ctx = createCtx();
		const model = new SettingsModel(await service.load(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {});

		overlay.handleInput("r");
		overlay.handleInput("j");
		overlay.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(service.stored).toEqual(createDefaultConfig());
		expect(model.state).toBe("saved");
		expect(ctx.notifications.some((message) => message.includes("defaults"))).toBe(true);
	});

	test("save effect persists the draft", async () => {
		const service = createService();
		const ctx = createCtx();
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {});
		model.moveCategory(1);
		model.toggleFocused();
		overlay.handleInput("\u0013");
		await Promise.resolve();
		await Promise.resolve();
		expect(service.stored.tools.backgroundSessions).toBe(false);
		expect(model.state).toBe("saved");
	});

	test("approval bypass confirmation warns only after explicit enablement", async () => {
		const service = createService();
		const ctx = createCtx();
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {});

		model.moveCategory(1);
		model.moveFocus(1);
		overlay.handleInput("\r");
		await Promise.resolve();
		expect(model.dialog).toEqual({ kind: "approval-bypass-confirm", focus: 0 });
		expect(ctx.notifications).toEqual([]);

		overlay.handleInput("j");
		overlay.handleInput("\r");
		await Promise.resolve();
		expect(model.draft.security.approvalPolicy).toBe("bypass");
		expect(model.state).toBe("dirty");
		expect(ctx.notifications).toHaveLength(1);
		expect(ctx.notifications[0]).toContain("user's permissions");
		expect(ctx.notifications[0]).toContain("workspace roots do not sandbox shell behavior");
	});

	test("blocks manual compact while coordinator is busy", async () => {
		const service = createService();
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.begin("session-fixture")).toBe(true);
		const ctx = createCtx({ confirm: true });
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		const overlay = new SettingsOverlay(
			model,
			service,
			ctx,
			diagnostics(),
			undefined,
			() => {},
			coordinator,
		);

		// Codex section, compact action
		model.moveCategory(1);
		model.moveCategory(1);
		overlay.handleInput("c");
		await Promise.resolve();
		await Promise.resolve();

		expect(ctx.compactCalls).toBe(0);
		expect(ctx.notifications.some((message) => message.includes("already in progress"))).toBe(true);
		expect(coordinator.isBusy("session-fixture")).toBe(true);
	});

	test("manual compact reuses the official path through the shared coordinator", async () => {
		const service = createService();
		const coordinator = new CodexCompactionCoordinator();
		const ctx = createCtx({ confirm: true });
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v4",
		});
		const overlay = new SettingsOverlay(
			model,
			service,
			ctx,
			diagnostics(),
			undefined,
			() => {},
			coordinator,
		);

		model.moveCategory(1);
		model.moveCategory(1);
		overlay.handleInput("c");
		await Promise.resolve();
		await Promise.resolve();

		expect(ctx.compactCalls).toBe(1);
		expect(coordinator.isBusy("session-fixture")).toBe(false);
		expect(ctx.notifications.some((message) => message.includes("compaction requested"))).toBe(
			true,
		);
	});

	test("save and reset recompute the displayed activation route from the persisted config", async () => {
		const service = createService();
		const ctx = createCtx({ provider: "custom-codex", api: "openai-responses" });
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "custom-codex",
			model: "test-model",
			bridge: "protocol v4",
			activationModel: { provider: "custom-codex", api: "openai-responses" },
		});
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {});

		expect(model.rows().find((row) => row.id === "route")?.value).toBe(
			"inactive (provider not selected: custom-codex)",
		);

		model.setActivationProviders(["openai-codex", "custom-codex"]);
		overlay.handleInput("\u0013");
		await Promise.resolve();
		await Promise.resolve();

		expect(model.state).toBe("saved");
		expect(service.stored.activation.providers).toEqual(["openai-codex", "custom-codex"]);
		expect(model.rows().find((row) => row.id === "route")?.value).toBe(
			"active (custom-codex / openai-responses)",
		);

		overlay.handleInput("r");
		overlay.handleInput("j");
		overlay.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(model.state).toBe("saved");
		expect(service.stored).toEqual(createDefaultConfig());
		expect(model.rows().find((row) => row.id === "route")?.value).toBe(
			"inactive (provider not selected: custom-codex)",
		);
	});

	test("failed save keeps the previous activation route", async () => {
		const service = createService();
		service.applyDraft = async () => {
			throw new Error("write failed");
		};
		const ctx = createCtx({ provider: "custom-codex", api: "openai-responses" });
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "custom-codex",
			model: "test-model",
			bridge: "protocol v4",
			activationModel: { provider: "custom-codex", api: "openai-responses" },
		});
		const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), undefined, () => {});
		const inactive = "inactive (provider not selected: custom-codex)";

		model.setActivationProviders(["openai-codex", "custom-codex"]);
		overlay.handleInput("\u0013");
		await Promise.resolve();
		await Promise.resolve();

		expect(model.state).toBe("write-error");
		expect(model.rows().find((row) => row.id === "route")?.value).toBe(inactive);
	});
});

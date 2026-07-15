import { describe, expect, test } from "bun:test";
import { CodexCompactionCoordinator } from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import type { DiagnosticsSnapshot } from "../../src/application/diagnostics.ts";
import { type CodexConfig, createDefaultConfig } from "../../src/domain/config.ts";
import { SettingsModel } from "../../src/ui/terminal/settings-model.ts";
import { SettingsOverlay } from "../../src/ui/terminal/settings-overlay.ts";

function diagnostics(): DiagnosticsSnapshot {
	return {
		schemaVersion: 1,
		configSchemaVersion: 1,
		bridge: { bridgeProtocolVersion: 1, capabilities: ["responses"] },
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
	compact?: (options?: { onComplete?: () => void; onError?: (error: Error) => void }) => void;
}) {
	const notifications: string[] = [];
	let compactCalls = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/workspace",
		model: { provider: "openai-codex", id: "test-model" },
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
				return undefined;
			},
		},
		notifications,
		get compactCalls() {
			return compactCalls;
		},
	};
	return ctx as unknown as ConstructorParameters<typeof SettingsOverlay>[2] & {
		notifications: string[];
		compactCalls: number;
	};
}

describe("settings overlay disposal", () => {
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
			bridge: "protocol v1",
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
			bridge: "protocol v1",
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
			bridge: "protocol v1",
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

	test("blocks manual compact while coordinator is busy", async () => {
		const service = createService();
		const coordinator = new CodexCompactionCoordinator();
		expect(coordinator.begin("session-fixture")).toBe(true);
		const ctx = createCtx({ confirm: true });
		const model = new SettingsModel(createDefaultConfig(), {
			baseline: "0.144.3",
			provider: "openai-codex",
			model: "test-model",
			bridge: "protocol v1",
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

		// OpenAI section, compact action
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
			bridge: "protocol v1",
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
});

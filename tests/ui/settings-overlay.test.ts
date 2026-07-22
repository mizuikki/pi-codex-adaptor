import { describe, expect, test } from "bun:test";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { CodexCompactionCoordinator } from "../../src/application/compaction.ts";
import type { ConfigurationService } from "../../src/application/configuration.ts";
import type {
	DiagnosticsExporter,
	DiagnosticsSnapshot,
} from "../../src/application/diagnostics.ts";
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
	input?: string;
	provider?: string;
	api?: string;
	compact?: (options?: { onComplete?: () => void; onError?: (error: Error) => void }) => void;
	dialog?: (
		kind: "confirm" | "input",
		signal: AbortSignal | undefined,
	) => Promise<boolean | string | undefined>;
	overlayHandle?: OverlayHandle;
}) {
	const notifications: string[] = [];
	const dialogSignals: AbortSignal[] = [];
	let compactCalls = 0;
	let customCalls = 0;
	let customOverlay: SettingsOverlay | undefined;
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
			async confirm(_title: string, _message: string, dialogOptions?: { signal?: AbortSignal }) {
				dialogSignals.push(dialogOptions?.signal as AbortSignal);
				const result =
					options?.dialog === undefined
						? undefined
						: await options.dialog("confirm", dialogOptions?.signal);
				return typeof result === "boolean" ? result : (options?.confirm ?? false);
			},
			async input(_title: string, _placeholder?: string, dialogOptions?: { signal?: AbortSignal }) {
				dialogSignals.push(dialogOptions?.signal as AbortSignal);
				const result =
					options?.dialog === undefined
						? undefined
						: await options.dialog("input", dialogOptions?.signal);
				return typeof result === "string" ? result : options?.input;
			},
			async custom(
				factory: (
					tui: undefined,
					theme: undefined,
					keybindings: undefined,
					done: (result: undefined) => void,
				) => SettingsOverlay,
				customOptions?: { onHandle?: (handle: OverlayHandle) => void },
			) {
				customCalls += 1;
				customOverlay = factory(undefined, undefined, undefined, () => {});
				if (options?.overlayHandle !== undefined) customOptions?.onHandle?.(options.overlayHandle);
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
		get customOverlay() {
			return customOverlay;
		},
		dialogSignals,
	};
	return ctx as unknown as ConstructorParameters<typeof SettingsOverlay>[2] & {
		notifications: string[];
		compactCalls: number;
		customCalls: number;
		customOverlay: SettingsOverlay | undefined;
		dialogSignals: AbortSignal[];
	};
}

function createOverlayHandle(events: string[]): OverlayHandle {
	return {
		hide() {},
		setHidden(hidden: boolean) {
			events.push(hidden ? "hide" : "show");
		},
		isHidden() {
			return false;
		},
		focus() {
			events.push("focus");
		},
		unfocus() {},
		isFocused() {
			return false;
		},
	};
}

function createOverlayForDialog(
	options: Parameters<typeof createCtx>[0] = {},
	exporter?: DiagnosticsExporter,
) {
	const service = createService();
	const ctx = createCtx(options);
	const model = new SettingsModel(createDefaultConfig(), {
		baseline: "0.144.3",
		provider: "openai-codex",
		model: "test-model",
		bridge: "protocol v4",
	});
	const overlay = new SettingsOverlay(model, service, ctx, diagnostics(), exporter, () => {});
	return { ctx, model, overlay };
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

describe("settings overlay Pi dialog handoff", () => {
	test("attaches the custom overlay handle to its matching settings overlay", async () => {
		const events: string[] = [];
		const ctx = createCtx({
			overlayHandle: createOverlayHandle(events),
			input: "provider-a",
		});

		await openSettingsOverlay(ctx, createService());
		ctx.customOverlay?.handleInput("j");
		ctx.customOverlay?.handleInput("j");
		ctx.customOverlay?.handleInput("j");
		ctx.customOverlay?.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(events).toEqual(["hide", "show", "focus"]);
		expect(ctx.dialogSignals).toHaveLength(1);
		expect(ctx.dialogSignals[0]?.aborted).toBe(false);
	});

	test.each([
		{
			name: "manual compaction confirmation",
			response: true,
			activate: (model: SettingsModel, overlay: SettingsOverlay) => {
				model.moveCategory(1);
				model.moveCategory(1);
				overlay.handleInput("c");
			},
		},
		{
			name: "auto compact token limit input",
			response: "128000",
			activate: (model: SettingsModel, overlay: SettingsOverlay) => {
				model.moveCategory(1);
				model.moveCategory(1);
				for (let index = 0; index < 5; index += 1) model.moveFocus(1);
				overlay.handleInput("\r");
			},
		},
		{
			name: "active provider ids input",
			response: "provider-a, provider-b",
			activate: (model: SettingsModel, overlay: SettingsOverlay) => {
				for (let index = 0; index < 3; index += 1) model.moveFocus(1);
				overlay.handleInput("\r");
			},
		},
	])("hides and restores around $name", async ({ response, activate }) => {
		const events: string[] = [];
		const { ctx, model, overlay } = createOverlayForDialog({
			dialog: async (kind, signal) => {
				events.push(kind);
				expect(signal?.aborted).toBe(false);
				return response;
			},
		});
		overlay.attachOverlayHandle(createOverlayHandle(events));

		activate(model, overlay);
		await Promise.resolve();
		await Promise.resolve();

		expect(events).toEqual(["hide", response === true ? "confirm" : "input", "show", "focus"]);
		expect(ctx.dialogSignals).toHaveLength(1);
		expect(ctx.dialogSignals[0]).toBeInstanceOf(AbortSignal);
	});

	test("hands diagnostics dialogs off independently", async () => {
		const events: string[] = [];
		const responses = [true, "/diagnostics.json"];
		const exporter: DiagnosticsExporter = {
			async export() {
				return { path: "/diagnostics.json", sha256: "0".repeat(64) };
			},
		};
		const { ctx, model, overlay } = createOverlayForDialog(
			{
				dialog: async (kind) => {
					events.push(kind);
					return responses.shift();
				},
			},
			exporter,
		);
		overlay.attachOverlayHandle(createOverlayHandle(events));
		model.moveCategory(1);
		model.moveCategory(1);
		model.moveCategory(1);
		overlay.handleInput("e");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(events).toEqual(["hide", "confirm", "show", "focus", "hide", "input", "show", "focus"]);
		expect(ctx.dialogSignals).toHaveLength(2);
	});

	test("preserves cancellation, validation, and no-handle behavior", async () => {
		const cancellation = createOverlayForDialog();
		for (let index = 0; index < 3; index += 1) cancellation.model.moveFocus(1);
		cancellation.overlay.handleInput("\r");
		await Promise.resolve();
		expect(cancellation.model.draft.activation.providers).toEqual(["openai-codex"]);
		expect(cancellation.ctx.dialogSignals).toHaveLength(1);

		const invalid = createOverlayForDialog({ input: "0" });
		invalid.model.moveCategory(1);
		invalid.model.moveCategory(1);
		for (let index = 0; index < 5; index += 1) invalid.model.moveFocus(1);
		invalid.overlay.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();
		expect(invalid.model.state).toBe("validation-error");
	});

	test("does not restore a disposed overlay or apply a pending dialog value", async () => {
		let resolveInput: ((value: boolean | string | undefined) => void) | undefined;
		const pending = new Promise<boolean | string | undefined>((resolve) => {
			resolveInput = resolve;
		});
		const events: string[] = [];
		const { ctx, model, overlay } = createOverlayForDialog({
			dialog: async () => pending,
		});
		overlay.attachOverlayHandle(createOverlayHandle(events));
		for (let index = 0; index < 3; index += 1) model.moveFocus(1);
		overlay.handleInput("\r");
		await Promise.resolve();
		overlay.dispose();
		resolveInput?.("provider-a");
		await Promise.resolve();
		await Promise.resolve();

		expect(events).toEqual(["hide"]);
		expect(ctx.dialogSignals[0]?.aborted).toBe(true);
		expect(model.disposed).toBe(true);
		expect(model.draft.activation.providers).toEqual(["openai-codex"]);
	});
});

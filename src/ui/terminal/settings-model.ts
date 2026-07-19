import { parseKey as parseTuiKey } from "@earendil-works/pi-tui";

import {
	type CodexConfig,
	createDefaultConfig,
	parseConfig,
	type WebSearchMode,
} from "../../domain/config.ts";
import {
	type ProviderActivationModel,
	resolveProviderActivation,
} from "../../domain/provider-activation.ts";
import { fitLine, joinFooter, padEndVisible, statusLabel, wrapText } from "./render.ts";

export const SETTINGS_CATEGORIES = ["General", "Tools", "Codex", "Diagnostics"] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];
export type SettingsLayout = "wide" | "medium" | "narrow";
export type SettingsState =
	| "pristine"
	| "dirty"
	| "validating"
	| "saving"
	| "saved"
	| "validation-error"
	| "write-error";
export type SettingsFocusRegion = "nav" | "list";
export type NarrowScreen = "categories" | "settings";
export type SettingsDialog =
	| { kind: "none" }
	| { kind: "dirty-close"; focus: number }
	| { kind: "reset-confirm"; focus: number }
	| { kind: "help" };

export type SettingsEffect =
	| { type: "none" }
	| { type: "save" }
	| { type: "save-and-close" }
	| { type: "close" }
	| { type: "compact" }
	| { type: "export" }
	| { type: "edit-providers" }
	| { type: "edit-auto-compact" }
	| { type: "reset-defaults" };

export type SettingsRowKind = "readonly" | "toggle" | "enum" | "action" | "number";

export interface SettingsRow {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly description: string;
	readonly kind: SettingsRowKind;
	readonly enabled: boolean;
	readonly disabledReason?: string;
}

export interface SettingsModelOptions {
	baseline: string;
	provider: string;
	model: string;
	bridge: string;
	/** Current Pi model used to recompute the displayed activation route after save/reset/restore. */
	activationModel?: ProviderActivationModel;
	activationStatus?: string;
	capabilities?: readonly string[];
	disabledReasons?: Readonly<Record<string, string>>;
}

const DIRTY_CLOSE_OPTIONS = ["Continue editing", "Discard changes", "Save"] as const;
const RESET_OPTIONS = ["Cancel", "Reset to defaults"] as const;
const NAV_WIDTH = 20;

export class SettingsModel {
	#saved: CodexConfig;
	#draft: CodexConfig;
	readonly #options: SettingsModelOptions;
	readonly #activationModel: ProviderActivationModel | undefined;
	#activationStatus: string | undefined;
	#categoryIndex = 0;
	#focus = 0;
	#region: SettingsFocusRegion = "list";
	#narrowScreen: NarrowScreen = "categories";
	#scroll = 0;
	#state: SettingsState = "pristine";
	#message: string | undefined;
	#dialog: SettingsDialog = { kind: "none" };
	#disposed = false;
	#width = 80;

	constructor(config: CodexConfig, options: SettingsModelOptions) {
		this.#saved = structuredClone(config);
		this.#draft = structuredClone(config);
		this.#options = options;
		this.#activationModel = options.activationModel;
		this.#activationStatus =
			options.activationStatus ??
			(options.activationModel === undefined
				? undefined
				: formatActivationStatus(options.activationModel, config));
	}

	get draft(): CodexConfig {
		return structuredClone(this.#draft);
	}

	get category(): SettingsCategory {
		return SETTINGS_CATEGORIES[this.#categoryIndex] ?? "General";
	}

	get focus(): number {
		return this.#focus;
	}

	get region(): SettingsFocusRegion {
		return this.#region;
	}

	get narrowScreen(): NarrowScreen {
		return this.#narrowScreen;
	}

	get scroll(): number {
		return this.#scroll;
	}

	get state(): SettingsState {
		return this.#state;
	}

	get message(): string | undefined {
		return this.#message;
	}

	get dialog(): SettingsDialog {
		return this.#dialog;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get width(): number {
		return this.#width;
	}

	layoutFor(width = this.#width): SettingsLayout {
		return width >= 100 ? "wide" : width >= 60 ? "medium" : "narrow";
	}

	/** @deprecated Prefer layoutFor; retained for existing callers. */
	setWidth(width: number): SettingsLayout {
		this.#width = Math.max(0, width);
		return this.layoutFor(this.#width);
	}

	dispose(): void {
		this.#disposed = true;
		this.#dialog = { kind: "none" };
	}

	moveCategory(delta: -1 | 1): void {
		if (this.#disposed || this.#dialog.kind !== "none") return;
		this.#categoryIndex =
			(this.#categoryIndex + delta + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
		this.#focus = 0;
		this.#scroll = 0;
	}

	setCategory(category: SettingsCategory): void {
		if (this.#disposed) return;
		this.#categoryIndex = SETTINGS_CATEGORIES.indexOf(category);
		this.#focus = 0;
		this.#scroll = 0;
	}

	moveFocus(delta: -1 | 1): void {
		if (this.#disposed || this.#dialog.kind !== "none") return;
		const layout = this.layoutFor();
		if (layout === "narrow" && this.#narrowScreen === "categories") {
			this.#categoryIndex = Math.max(
				0,
				Math.min(SETTINGS_CATEGORIES.length - 1, this.#categoryIndex + delta),
			);
			return;
		}
		if (layout === "wide" && this.#region === "nav") {
			this.moveCategory(delta);
			return;
		}
		const count = this.rows().length;
		if (count === 0) {
			this.#focus = 0;
			return;
		}
		this.#focus = Math.max(0, Math.min(count - 1, this.#focus + delta));
		this.#ensureFocusVisible();
	}

	rows(): SettingsRow[] {
		switch (this.category) {
			case "General":
				return [
					row(
						"baseline",
						"Baseline",
						this.#options.baseline,
						"Pinned OpenAI Codex runtime baseline.",
						"readonly",
					),
					row(
						"provider",
						"Provider",
						this.#options.provider,
						"Active Pi provider id for this session.",
						"readonly",
					),
					row("model", "Model", this.#options.model, "Active model id resolved by Pi.", "readonly"),
					row(
						"providers",
						"Active providers",
						this.#draft.activation.providers.join(", "),
						"Exact Pi provider ids that opt into the Codex adaptor. Separate ids with commas.",
						"action",
					),
					row(
						"route",
						"Current route",
						this.#activationStatus ?? "unavailable",
						"Whether the current provider and API use the Codex adaptor.",
						"readonly",
					),
					row(
						"status",
						"Status bar",
						this.#draft.ui.status ? "on" : "off",
						"Show a compact Codex status line in the Pi UI.",
						"toggle",
					),
					row(
						"reset",
						"Reset to defaults",
						"action",
						"Replace the draft with the product default configuration.",
						"action",
					),
				];
			case "Tools":
				return [
					row(
						"backgroundSessions",
						"Background sessions",
						this.#draft.tools.backgroundSessions ? "on" : "off",
						"Keep Unified Exec sessions alive after the initial yield for write_stdin polling.",
						"toggle",
					),
					row(
						"viewImage",
						"view_image",
						this.#draft.tools.optional.viewImage,
						"Enable the official view_image tool when the model accepts image inputs.",
						"enum",
						this.#disabled("viewImage"),
					),
					row(
						"imageGeneration",
						"image_gen.imagegen",
						this.#draft.tools.optional.imageGeneration,
						"Enable image generation when the provider and bridge advertise the capability.",
						"enum",
						this.#disabled("imageGeneration"),
					),
				];
			case "Codex": {
				const rows: SettingsRow[] = [
					row(
						"serviceTier",
						"Service tier",
						this.#draft.codex.serviceTier,
						"OpenAI service tier preference for Responses requests.",
						"enum",
					),
					row(
						"verbosity",
						"Verbosity",
						this.#draft.codex.verbosity,
						"Text verbosity preference for Responses requests.",
						"enum",
					),
					row(
						"transport",
						"Transport",
						this.#draft.codex.transport.mode,
						"Preferred transport mode. auto selects the official default path.",
						"enum",
					),
					row(
						"webSearch",
						"Web search mode",
						this.#draft.codex.webSearch.mode,
						"Standalone or hosted web search mode requested from the resolver.",
						"enum",
					),
					row(
						"compaction",
						"Compaction",
						this.#draft.codex.compaction.mode,
						"off disables adaptor compaction. auto uses the official compaction path.",
						"enum",
					),
				];
				if (this.#draft.codex.compaction.mode === "auto") {
					rows.push(
						row(
							"autoCompactTokenLimit",
							"Auto compact limit",
							String(this.#draft.codex.compaction.autoCompactTokenLimit),
							"model uses the official model threshold. A positive integer overrides it.",
							"number",
						),
					);
				}
				rows.push(
					row(
						"compactNow",
						"Compact now",
						this.#state === "dirty"
							? "save first"
							: this.#draft.codex.compaction.mode === "off"
								? "disabled"
								: this.#routeIsActive()
									? "action"
									: "inactive",
						"Run official compaction for the current session after settings are clean.",
						"action",
						this.#state === "dirty"
							? { enabled: false, reason: "Save or discard the draft before compaction." }
							: this.#draft.codex.compaction.mode === "off"
								? { enabled: false, reason: "Compaction is disabled." }
								: this.#routeIsActive()
									? undefined
									: {
											enabled: false,
											reason: "Codex route is inactive for the current provider and API.",
										},
					),
				);
				return rows;
			}
			case "Diagnostics":
				return [
					row(
						"bridge",
						"Bridge",
						this.#options.bridge,
						"Native bridge protocol identity.",
						"readonly",
					),
					row(
						"capabilities",
						"Capabilities",
						this.#options.capabilities?.join(", ") || "unavailable",
						"Capabilities advertised by the native bridge handshake.",
						"readonly",
					),
					row(
						"schema",
						"Config schema",
						`v${this.#draft.schemaVersion}`,
						"Supported configuration schema version.",
						"readonly",
					),
					row(
						"state",
						"Draft state",
						this.#state,
						"Current settings transaction state.",
						"readonly",
					),
					row(
						"export",
						"Export diagnostics",
						"action",
						"Export redacted adaptor and bridge metadata after confirmation.",
						"action",
					),
				];
		}
	}

	focusedRow(): SettingsRow | undefined {
		return this.rows()[this.#focus];
	}

	toggleFocused(): void {
		if (this.#disposed || this.#dialog.kind !== "none") return;
		const current = this.focusedRow();
		if (current === undefined || !current.enabled || current.kind !== "toggle") return;
		if (current.id === "backgroundSessions") {
			this.#draft.tools.backgroundSessions = !this.#draft.tools.backgroundSessions;
		} else if (current.id === "status") {
			this.#draft.ui.status = !this.#draft.ui.status;
		} else {
			return;
		}
		this.#markDirty();
	}

	cycleFocused(): void {
		if (this.#disposed || this.#dialog.kind !== "none") return;
		const current = this.focusedRow();
		if (current === undefined || !current.enabled || current.kind !== "enum") return;
		let changed = true;
		if (current.id === "viewImage") {
			this.#draft.tools.optional.viewImage = flipAutoOff(this.#draft.tools.optional.viewImage);
		} else if (current.id === "imageGeneration") {
			this.#draft.tools.optional.imageGeneration = flipAutoOff(
				this.#draft.tools.optional.imageGeneration,
			);
		} else if (current.id === "serviceTier") {
			this.#draft.codex.serviceTier = cycle(this.#draft.codex.serviceTier, [
				"default",
				"priority",
				"flex",
			]);
		} else if (current.id === "verbosity") {
			this.#draft.codex.verbosity = cycle(this.#draft.codex.verbosity, ["low", "medium", "high"]);
		} else if (current.id === "transport") {
			this.#draft.codex.transport.mode = cycle(this.#draft.codex.transport.mode, ["auto", "sse"]);
		} else if (current.id === "webSearch") {
			this.#draft.codex.webSearch.mode = cycle(this.#draft.codex.webSearch.mode, [
				"disabled",
				"cached",
				"indexed",
				"live",
			] satisfies WebSearchMode[]);
		} else if (current.id === "compaction") {
			this.#draft.codex.compaction =
				this.#draft.codex.compaction.mode === "off"
					? { mode: "auto", autoCompactTokenLimit: "model" }
					: { mode: "off" };
		} else {
			changed = false;
		}
		if (changed) this.#markDirty();
	}

	beginSave(): CodexConfig {
		if (this.#disposed) throw new Error("Settings overlay is disposed");
		this.#state = "validating";
		this.#message = undefined;
		const validated = parseConfig(this.#draft);
		this.#state = "saving";
		return validated;
	}

	markSaved(config: CodexConfig): void {
		if (this.#disposed) return;
		this.#saved = structuredClone(config);
		this.#draft = structuredClone(config);
		this.#refreshActivationStatus(config);
		this.#state = "saved";
		this.#message = `${statusLabel("ok")} Saved`;
	}

	markError(message: string, state: "validation-error" | "write-error"): void {
		if (this.#disposed) return;
		// Failed saves keep the last persisted activation route; do not reflect the unsaved draft.
		this.#state = state;
		this.#message = `${statusLabel("error")} ${message}`;
	}

	setAutoCompactTokenLimit(value: "model" | number): void {
		if (this.#disposed) return;
		if (this.#draft.codex.compaction.mode !== "auto") return;
		this.#draft.codex.compaction.autoCompactTokenLimit = value;
		this.#markDirty();
	}

	setActivationProviders(providers: readonly string[]): void {
		if (this.#disposed) return;
		this.#draft.activation.providers = [...providers];
		this.#markDirty();
	}

	discard(): void {
		if (this.#disposed) return;
		this.#draft = structuredClone(this.#saved);
		this.#state = "pristine";
		this.#message = undefined;
		this.#dialog = { kind: "none" };
	}

	applyDefaultsToDraft(): void {
		if (this.#disposed) return;
		this.#draft = createDefaultConfig();
		this.#markDirty();
		this.#message = `${statusLabel("info")} Draft reset to defaults. Save to apply.`;
		this.#dialog = { kind: "none" };
		this.#focus = 0;
		this.#scroll = 0;
	}

	replaceWithSaved(config: CodexConfig): void {
		if (this.#disposed) return;
		this.#saved = structuredClone(config);
		this.#draft = structuredClone(config);
		this.#refreshActivationStatus(config);
		this.#state = "saved";
		this.#message = `${statusLabel("ok")} Defaults restored`;
		this.#dialog = { kind: "none" };
		this.#focus = 0;
		this.#scroll = 0;
	}

	openDirtyCloseDialog(): void {
		if (this.#disposed) return;
		this.#dialog = { kind: "dirty-close", focus: 0 };
	}

	openResetDialog(): void {
		if (this.#disposed) return;
		this.#dialog = { kind: "reset-confirm", focus: 0 };
	}

	openHelp(): void {
		if (this.#disposed) return;
		this.#dialog = { kind: "help" };
	}

	closeDialog(): void {
		if (this.#disposed) return;
		this.#dialog = { kind: "none" };
	}

	handleKey(data: string): SettingsEffect {
		if (this.#disposed) return { type: "none" };
		const key = parseKey(data);
		if (this.#dialog.kind !== "none") return this.#handleDialogKey(key);

		switch (key) {
			case "esc":
				if (this.layoutFor() === "narrow" && this.#narrowScreen === "settings") {
					this.#narrowScreen = "categories";
					return { type: "none" };
				}
				if (this.#state === "dirty") {
					this.openDirtyCloseDialog();
					return { type: "none" };
				}
				return { type: "close" };
			case "up":
			case "k":
				this.moveFocus(-1);
				return { type: "none" };
			case "down":
			case "j":
				this.moveFocus(1);
				return { type: "none" };
			case "left":
			case "[":
				if (this.layoutFor() === "narrow" && this.#narrowScreen === "settings") {
					return { type: "none" };
				}
				this.moveCategory(-1);
				return { type: "none" };
			case "right":
			case "]":
				if (this.layoutFor() === "narrow" && this.#narrowScreen === "settings") {
					return { type: "none" };
				}
				this.moveCategory(1);
				return { type: "none" };
			case "tab":
				if (this.layoutFor() === "wide") {
					this.#region = this.#region === "nav" ? "list" : "nav";
				}
				return { type: "none" };
			case "shift-tab":
				if (this.layoutFor() === "wide") {
					this.#region = this.#region === "list" ? "nav" : "list";
				}
				return { type: "none" };
			case "space":
				this.toggleFocused();
				return { type: "none" };
			case "enter":
				return this.#activateFocused();
			case "ctrl-s":
				return { type: "save" };
			case "?":
				this.openHelp();
				return { type: "none" };
			case "r":
				this.openResetDialog();
				return { type: "none" };
			case "c":
				if (this.category === "Codex") return { type: "compact" };
				return { type: "none" };
			case "e":
				if (this.category === "Diagnostics") return { type: "export" };
				return { type: "none" };
			default:
				return { type: "none" };
		}
	}

	lines(width: number): string[] {
		this.#width = Math.max(0, width);
		if (this.#disposed) return [fitLine("Settings closed", width)];
		if (this.#dialog.kind !== "none") return this.#dialogLines(width);

		const layout = this.layoutFor(width);
		const header = this.#headerLine(width);
		const footer = this.footer(width);
		const body =
			layout === "wide"
				? this.#wideBody(width)
				: layout === "medium"
					? this.#mediumBody(width)
					: this.#narrowBody(width);
		const lines = [header, ...body];
		if (this.#message !== undefined) {
			lines.push("", ...wrapText(this.#message, width));
		}
		lines.push("", footer);
		return lines.map((line) => fitLine(line, width));
	}

	footer(width = this.#width): string {
		const layout = this.layoutFor(width);
		if (layout === "narrow" && this.#narrowScreen === "categories") {
			return joinFooter(["Up/Down", "Enter open", "Esc close", "? help"], width);
		}
		const actions: string[] = [];
		actions.push("Up/Down");
		if (layout === "wide") actions.push("Tab region");
		if (layout !== "narrow") actions.push("[/] category");
		actions.push("Space", "Enter");
		actions.push("Ctrl+S");
		actions.push("R reset");
		if (this.category === "Codex") actions.push("C compact");
		if (this.category === "Diagnostics") actions.push("E export");
		actions.push(layout === "narrow" ? "Esc back" : "Esc close");
		actions.push("? help");
		return joinFooter(actions, width);
	}

	/** @deprecated Prefer row values through rows(). */
	value(key: string): string {
		return this.rows().find((row) => row.id === key)?.value ?? "n/a";
	}

	#activateFocused(): SettingsEffect {
		const layout = this.layoutFor();
		if (layout === "narrow" && this.#narrowScreen === "categories") {
			this.#narrowScreen = "settings";
			this.#focus = 0;
			this.#scroll = 0;
			this.#region = "list";
			return { type: "none" };
		}
		if (layout === "wide" && this.#region === "nav") {
			this.#region = "list";
			this.#focus = 0;
			return { type: "none" };
		}
		const current = this.focusedRow();
		if (current === undefined || !current.enabled) return { type: "none" };
		if (current.kind === "toggle") {
			this.toggleFocused();
			return { type: "none" };
		}
		if (current.kind === "enum") {
			this.cycleFocused();
			return { type: "none" };
		}
		if (current.id === "autoCompactTokenLimit") return { type: "edit-auto-compact" };
		if (current.id === "providers") return { type: "edit-providers" };
		if (current.id === "export") return { type: "export" };
		if (current.id === "compactNow") return { type: "compact" };
		if (current.id === "reset") {
			this.openResetDialog();
			return { type: "none" };
		}
		return { type: "none" };
	}

	#routeIsActive(): boolean {
		return this.#activationStatus === undefined || this.#activationStatus.startsWith("active");
	}

	#refreshActivationStatus(config: Pick<CodexConfig, "activation">): void {
		// Recompute only when the live model is known. Static activationStatus callers stay unchanged.
		if (this.#activationModel === undefined) return;
		this.#activationStatus = formatActivationStatus(this.#activationModel, config);
	}

	#handleDialogKey(key: string): SettingsEffect {
		const dialog = this.#dialog;
		if (dialog.kind === "help") {
			if (key === "esc" || key === "enter" || key === "?" || key === "space") {
				this.#dialog = { kind: "none" };
			}
			return { type: "none" };
		}
		if (dialog.kind === "dirty-close") {
			if (key === "esc") {
				this.#dialog = { kind: "none" };
				return { type: "none" };
			}
			if (key === "up" || key === "k") {
				this.#dialog = { kind: "dirty-close", focus: Math.max(0, dialog.focus - 1) };
				return { type: "none" };
			}
			if (key === "down" || key === "j") {
				this.#dialog = {
					kind: "dirty-close",
					focus: Math.min(DIRTY_CLOSE_OPTIONS.length - 1, dialog.focus + 1),
				};
				return { type: "none" };
			}
			if (key === "enter" || key === "space") {
				const selected = DIRTY_CLOSE_OPTIONS[dialog.focus] ?? DIRTY_CLOSE_OPTIONS[0];
				if (selected === "Continue editing") {
					this.#dialog = { kind: "none" };
					return { type: "none" };
				}
				if (selected === "Discard changes") {
					this.discard();
					return { type: "close" };
				}
				this.#dialog = { kind: "none" };
				return { type: "save-and-close" };
			}
			return { type: "none" };
		}
		if (dialog.kind === "reset-confirm") {
			if (key === "esc") {
				this.#dialog = { kind: "none" };
				return { type: "none" };
			}
			if (key === "up" || key === "k") {
				this.#dialog = { kind: "reset-confirm", focus: Math.max(0, dialog.focus - 1) };
				return { type: "none" };
			}
			if (key === "down" || key === "j") {
				this.#dialog = {
					kind: "reset-confirm",
					focus: Math.min(RESET_OPTIONS.length - 1, dialog.focus + 1),
				};
				return { type: "none" };
			}
			if (key === "enter" || key === "space") {
				const selected = RESET_OPTIONS[dialog.focus] ?? RESET_OPTIONS[0];
				if (selected === "Cancel") {
					this.#dialog = { kind: "none" };
					return { type: "none" };
				}
				this.#dialog = { kind: "none" };
				return { type: "reset-defaults" };
			}
		}
		return { type: "none" };
	}

	#headerLine(width: number): string {
		const modified =
			this.#state === "dirty" || this.#state === "validation-error" || this.#state === "write-error"
				? statusLabel("dirty")
				: this.#state === "saved"
					? statusLabel("ok")
					: this.#state;
		const prefix = `Codex adaptor · ${this.#options.baseline}`;
		const suffix = ` · ${modified}`;
		const provider = this.#options.provider;
		if (width <= 0) return "";
		if ((prefix + suffix).length >= width) {
			return fitLine(`${prefix}${suffix}`, width);
		}
		const available = width - prefix.length - suffix.length;
		const middle = fitLine(` · ${provider}`, available);
		return `${prefix}${middle}${suffix}`;
	}

	#wideBody(width: number): string[] {
		const navWidth = Math.min(22, Math.max(18, NAV_WIDTH));
		const gap = 2;
		const contentWidth = Math.max(20, width - navWidth - gap);
		const navLines = SETTINGS_CATEGORIES.map((category, index) => {
			const active = index === this.#categoryIndex;
			const focusMark = this.#region === "nav" && active ? ">" : " ";
			const label = active ? `[${category}]` : category;
			return padEndVisible(`${focusMark}${label}`, navWidth);
		});
		const contentLines = this.#settingsLines(contentWidth, this.#region === "list");
		const description = this.#descriptionLines(contentWidth);
		const right = [...contentLines, "", ...description];
		const height = Math.max(navLines.length, right.length);
		const lines: string[] = [];
		for (let index = 0; index < height; index += 1) {
			const left = padEndVisible(navLines[index] ?? "", navWidth);
			const body = fitLine(right[index] ?? "", contentWidth);
			lines.push(`${left}${" ".repeat(gap)}${body}`);
		}
		return lines;
	}

	#mediumBody(width: number): string[] {
		const tabs = SETTINGS_CATEGORIES.map((category) =>
			category === this.category ? `[${category}]` : category,
		).join("  ");
		return [
			fitLine(tabs, width),
			"",
			...this.#settingsLines(width, true),
			"",
			...this.#descriptionLines(width),
		];
	}

	#narrowBody(width: number): string[] {
		if (this.#narrowScreen === "categories") {
			return [
				fitLine("Select section", width),
				"",
				...SETTINGS_CATEGORIES.map((category, index) => {
					const prefix = index === this.#categoryIndex ? ">" : " ";
					return fitLine(`${prefix} ${category}`, width);
				}),
			];
		}
		return [
			fitLine(this.category, width),
			"",
			...this.#settingsLines(width, true),
			"",
			...this.#descriptionLines(width),
		];
	}

	#settingsLines(width: number, showFocus: boolean): string[] {
		const rows = this.rows();
		const visible = this.#visibleRows(rows);
		return visible.map((item) => {
			const prefix = showFocus && item.index === this.#focus ? ">" : " ";
			const disabled = item.row.enabled ? "" : ` ${statusLabel("disabled")}`;
			const label = padEndVisible(
				item.row.label,
				Math.min(22, Math.max(10, Math.floor(width * 0.4))),
			);
			const valueWidth = Math.max(4, width - 2 - label.length - disabled.length);
			return fitLine(`${prefix} ${label} ${fitLine(item.row.value, valueWidth)}${disabled}`, width);
		});
	}

	#descriptionLines(width: number): string[] {
		const current = this.focusedRow();
		if (current === undefined) return [];
		const reason =
			current.disabledReason === undefined
				? current.description
				: `${current.description} ${statusLabel("disabled")} ${current.disabledReason}`;
		return wrapText(reason, width).map((line) => fitLine(line, width));
	}

	#dialogLines(width: number): string[] {
		if (this.#dialog.kind === "help") {
			const help = [
				"Codex settings help",
				"",
				"Up/Down or j/k: move",
				"[/] or Left/Right: switch category",
				"Tab: switch wide layout region",
				"Space: toggle booleans",
				"Enter: activate enum, action, or narrow section",
				"Ctrl+S: validate and save draft",
				"R: reset draft to product defaults",
				"C: compact now on Codex section",
				"E: export diagnostics on Diagnostics section",
				"Esc: back, cancel dialog, or close",
				"",
				"Enter/Esc/? close help",
			];
			return help.map((line) => fitLine(line, width));
		}
		if (this.#dialog.kind === "dirty-close") {
			const lines = [
				fitLine("Unsaved Codex settings", width),
				"",
				...wrapText("Save, discard, or continue editing the draft.", width),
				"",
			];
			for (const [index, option] of DIRTY_CLOSE_OPTIONS.entries()) {
				const prefix = index === this.#dialog.focus ? ">" : " ";
				lines.push(fitLine(`${prefix} ${option}`, width));
			}
			lines.push("", fitLine("Default: Continue editing", width));
			return lines;
		}
		if (this.#dialog.kind === "reset-confirm") {
			const lines = [
				fitLine("Reset Codex settings", width),
				"",
				...wrapText("Replace the configuration with product defaults?", width),
				"",
			];
			for (const [index, option] of RESET_OPTIONS.entries()) {
				const prefix = index === this.#dialog.focus ? ">" : " ";
				lines.push(fitLine(`${prefix} ${option}`, width));
			}
			lines.push("", fitLine("Default: Cancel", width));
			return lines;
		}
		return [];
	}

	#visibleRows(rows: readonly SettingsRow[]): Array<{ row: SettingsRow; index: number }> {
		return rows.map((item, index) => ({ row: item, index }));
	}

	#ensureFocusVisible(): void {
		const count = this.rows().length;
		if (count === 0) {
			this.#focus = 0;
			this.#scroll = 0;
			return;
		}
		if (this.#focus < this.#scroll) this.#scroll = this.#focus;
	}

	#disabled(id: string): { enabled: boolean; reason: string } | undefined {
		const reason = this.#options.disabledReasons?.[id];
		return reason === undefined ? undefined : { enabled: false, reason };
	}

	#markDirty(): void {
		this.#state = "dirty";
		this.#message = undefined;
	}
}

function row(
	id: string,
	label: string,
	value: string,
	description: string,
	kind: SettingsRowKind,
	disabled?: { enabled: boolean; reason: string },
): SettingsRow {
	return {
		id,
		label,
		value,
		description,
		kind,
		enabled: disabled?.enabled ?? true,
		...(disabled?.reason === undefined ? {} : { disabledReason: disabled.reason }),
	};
}

function flipAutoOff(value: "auto" | "off"): "auto" | "off" {
	return value === "auto" ? "off" : "auto";
}

function cycle<T extends string>(value: T, values: readonly T[]): T {
	const index = values.indexOf(value);
	return values[(index + 1) % values.length] ?? values[0] ?? value;
}

export function parseKey(data: string): string {
	const key = parseTuiKey(data);
	if (key === "escape") return "esc";
	return (key ?? data).toLowerCase().replaceAll("+", "-");
}

/** Format the current activation route using the shared domain predicate. */
export function formatActivationStatus(
	model: ProviderActivationModel | undefined,
	config: Pick<CodexConfig, "activation">,
): string {
	const decision = resolveProviderActivation(model, config);
	if (decision.active) {
		return `active (${model?.provider ?? "unknown"} / ${model?.api ?? "unknown"})`;
	}
	switch (decision.reason) {
		case "no_model":
			return "inactive (no model)";
		case "provider_not_selected":
			return `inactive (provider not selected: ${model?.provider ?? "unknown"})`;
		case "unsupported_pi_api":
			return `inactive (unsupported API: ${model?.api ?? "unknown"})`;
	}
}

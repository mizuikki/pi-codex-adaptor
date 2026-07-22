import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { CodexRuntime } from "../../application/codex-runtime.ts";
import type { CodexCompactionCoordinator } from "../../application/compaction.ts";
import type { ConfigurationService } from "../../application/configuration.ts";
import {
	createDiagnosticsSnapshot,
	type DiagnosticsExporter,
	type DiagnosticsSnapshot,
	exportDiagnosticsConfirmed,
} from "../../application/diagnostics.ts";
import {
	capabilityContextFromSnapshot,
	type EffectiveCapabilitySnapshot,
	ResolveEffectiveCapabilities,
} from "../../application/resolve-effective-capabilities.ts";
import {
	type CodexConfig,
	type ConfigSettingEvaluation,
	ConfigurationError,
} from "../../domain/config.ts";
import { APPROVAL_BYPASS_WARNING, type SettingsEffect, SettingsModel } from "./settings-model.ts";

export async function openSettingsOverlay(
	ctx: ExtensionCommandContext,
	service: ConfigurationService,
	runtime?: CodexRuntime,
	exporter?: DiagnosticsExporter,
	coordinator?: CodexCompactionCoordinator,
	capabilityResolver?: ResolveEffectiveCapabilities,
): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("Codex settings require an interactive terminal", "warning");
		return;
	}
	let config: CodexConfig;
	try {
		config = await service.load();
	} catch (error) {
		ctx.ui.notify(
			error instanceof ConfigurationError
				? "Codex configuration is invalid"
				: "Codex configuration could not be loaded",
			"error",
		);
		return;
	}
	const nativeDiagnostics = await diagnostics(runtime);
	const resolver =
		capabilityResolver ??
		(runtime === undefined ? undefined : new ResolveEffectiveCapabilities(runtime));
	let effective: EffectiveCapabilitySnapshot | undefined;
	if (resolver !== undefined && ctx.model !== undefined) {
		try {
			effective = await resolver.resolve({
				modelId: ctx.model.id,
				providerId: ctx.model.provider,
				config,
				contextWindow: ctx.model.contextWindow,
			});
		} catch {
			ctx.ui.notify("Codex effective capabilities could not be resolved", "warning");
		}
	}
	const snapshot = createDiagnosticsSnapshot(config, nativeDiagnostics, {
		...(effective === undefined
			? {}
			: { effectiveCapabilities: diagnosticCapabilities(effective) }),
	});
	const capabilities = Array.isArray(snapshot.bridge.capabilities)
		? snapshot.bridge.capabilities.filter((value): value is string => typeof value === "string")
		: undefined;
	const model = new SettingsModel(config, {
		baseline: "0.144.3",
		provider: ctx.model?.provider ?? "unresolved",
		model: ctx.model?.id ?? "unresolved",
		bridge:
			typeof snapshot.bridge.bridgeProtocolVersion === "number"
				? `protocol v${snapshot.bridge.bridgeProtocolVersion}`
				: "unavailable",
		// Keep the live model so save/reset/restore can recompute the activation route.
		...(ctx.model === undefined
			? {}
			: { activationModel: { provider: ctx.model.provider, api: ctx.model.api } }),
		...(capabilities === undefined ? {} : { capabilities }),
		...(effective === undefined
			? {}
			: {
					disabledReasons: disabledReasons(
						service.evaluate(
							config,
							capabilityContextFromSnapshot(effective, ctx.model?.contextWindow),
						),
					),
					modelAutoCompactTokenLimit: effective.compaction.modelThreshold,
				}),
	});
	let overlay: SettingsOverlay | undefined;
	await ctx.ui.custom(
		(_tui, _theme, _keybindings, done) => {
			overlay = new SettingsOverlay(
				model,
				service,
				ctx,
				snapshot,
				exporter,
				done,
				coordinator,
				resolver,
			);
			return overlay;
		},
		{
			overlay: true,
			onHandle: (handle) => overlay?.attachOverlayHandle(handle),
		},
	);
}

async function diagnostics(runtime: CodexRuntime | undefined): Promise<unknown> {
	if (runtime?.readDiagnostics === undefined) return undefined;
	try {
		return await runtime.readDiagnostics();
	} catch {
		return undefined;
	}
}

function disabledReasons(
	evaluations: readonly ConfigSettingEvaluation[],
): Readonly<Record<string, string>> {
	const ids: Readonly<Record<string, string>> = {
		"tools.backgroundSessions": "backgroundSessions",
		"tools.optional.viewImage": "viewImage",
		"tools.optional.imageGeneration": "imageGeneration",
		"codex.transport.mode": "transport",
		"codex.webSearch.mode": "webSearch",
		"codex.compaction.mode": "compaction",
		"codex.compaction.autoCompactTokenLimit": "autoCompactTokenLimit",
	};
	const reasons: Record<string, string> = {};
	for (const evaluation of evaluations) {
		if (evaluation.availability.status !== "unsupported") continue;
		const id = ids[evaluation.path];
		if (id !== undefined) reasons[id] = evaluation.availability.reason;
	}
	const compaction = evaluations.find((item) => item.path === "codex.compaction.mode");
	if (compaction?.availability.status === "unsupported") {
		reasons.compactNow = compaction.availability.reason;
	}
	return reasons;
}

function diagnosticCapabilities(
	snapshot: EffectiveCapabilitySnapshot,
): Readonly<Record<string, unknown>> {
	return {
		modelId: snapshot.modelId,
		shellPrimary: snapshot.shell.primary,
		sessionSurface: snapshot.shell.sessionSurface,
		sessions: snapshot.shell.sessions.status,
		applyPatch: snapshot.applyPatch.status,
		viewImage: snapshot.viewImage.status,
		imageGeneration: snapshot.imageGeneration.status,
		webSearch: snapshot.webSearch.status,
		webSurface: snapshot.webSurface,
		manualCompaction: snapshot.compaction.manual.status,
		automaticCompaction: snapshot.compaction.automatic.status,
		autoCompactThreshold: snapshot.compaction.threshold,
		transport: snapshot.transport.status,
		localTools: snapshot.localTools,
		hostedTools: snapshot.hostedTools,
	};
}

export class SettingsOverlay {
	focused = true;
	readonly #model: SettingsModel;
	readonly #service: ConfigurationService;
	readonly #ctx: ExtensionCommandContext;
	readonly #diagnostics: DiagnosticsSnapshot;
	readonly #exporter: DiagnosticsExporter | undefined;
	readonly #done: (result: undefined) => void;
	readonly #coordinator: CodexCompactionCoordinator | undefined;
	readonly #capabilities: ResolveEffectiveCapabilities | undefined;
	#disposed = false;
	#taskGeneration = 0;
	readonly #abortControllers = new Set<AbortController>();
	#overlayHandle: OverlayHandle | undefined;

	constructor(
		model: SettingsModel,
		service: ConfigurationService,
		ctx: ExtensionCommandContext,
		diagnostics: DiagnosticsSnapshot,
		exporter: DiagnosticsExporter | undefined,
		done: (result: undefined) => void,
		coordinator?: CodexCompactionCoordinator,
		capabilities?: ResolveEffectiveCapabilities,
	) {
		this.#model = model;
		this.#service = service;
		this.#ctx = ctx;
		this.#diagnostics = diagnostics;
		this.#exporter = exporter;
		this.#done = done;
		this.#coordinator = coordinator;
		this.#capabilities = capabilities;
	}

	render(width: number): string[] {
		return this.#model.lines(width);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		const effect = this.#model.handleKey(data);
		void this.#applyEffect(effect).catch(() => {
			if (!this.#disposed) {
				this.#model.markError("Codex settings action could not be completed", "write-error");
			}
		});
	}

	invalidate(): void {}

	attachOverlayHandle(handle: OverlayHandle): void {
		if (!this.#disposed) this.#overlayHandle = handle;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#taskGeneration += 1;
		for (const controller of this.#abortControllers) controller.abort();
		this.#abortControllers.clear();
		this.#model.dispose();
	}

	async #applyEffect(effect: SettingsEffect): Promise<void> {
		switch (effect.type) {
			case "none":
				return;
			case "close":
				this.#closeNow();
				return;
			case "save":
				await this.#save(false);
				return;
			case "save-and-close":
				await this.#save(true);
				return;
			case "compact":
				await this.#compact();
				return;
			case "export":
				await this.#exportDiagnostics();
				return;
			case "edit-auto-compact":
				await this.#editAutoCompactTokenLimit();
				return;
			case "edit-providers":
				await this.#editProviders();
				return;
			case "reset-defaults":
				await this.#resetDefaults();
				return;
			case "approval-bypass-enabled":
				this.#ctx.ui.notify(APPROVAL_BYPASS_WARNING, "warning");
				return;
		}
	}

	async #save(closeOnSuccess: boolean): Promise<void> {
		await this.#runTask(async () => {
			try {
				const config = this.#model.beginSave();
				const selected = this.#ctx.model;
				const effective =
					this.#capabilities === undefined || selected === undefined
						? undefined
						: await this.#capabilities.resolve({
								modelId: selected.id,
								providerId: selected.provider,
								config,
								contextWindow: selected.contextWindow,
							});
				await this.#service.applyDraft(
					config,
					effective === undefined
						? {}
						: capabilityContextFromSnapshot(effective, selected?.contextWindow),
				);
				if (this.#disposed) return;
				this.#model.markSaved(config);
				this.#ctx.ui.notify("Codex settings saved", "info");
				if (closeOnSuccess) this.#closeNow();
			} catch (error) {
				if (this.#disposed) return;
				this.#model.markError(
					error instanceof ConfigurationError
						? "Fix the highlighted configuration fields before saving"
						: "Codex settings could not be saved",
					error instanceof ConfigurationError ? "validation-error" : "write-error",
				);
			}
		});
	}

	async #resetDefaults(): Promise<void> {
		await this.#runTask(async () => {
			try {
				const config = await this.#service.resetToDefaults();
				if (this.#disposed) return;
				this.#model.replaceWithSaved(config);
				this.#ctx.ui.notify("Codex settings restored to defaults", "info");
			} catch {
				if (this.#disposed) return;
				this.#model.markError("Codex settings could not be reset", "write-error");
			}
		});
	}

	async #compact(): Promise<void> {
		await this.#runTask(async (signal) => {
			const compactRow = this.#model.rows().find((row) => row.id === "compactNow");
			if (compactRow?.enabled === false) {
				this.#ctx.ui.notify(
					compactRow.disabledReason ?? "Codex compaction is unavailable",
					"warning",
				);
				return;
			}
			if (this.#model.state === "dirty") {
				this.#ctx.ui.notify("Save or discard Codex settings before compaction", "warning");
				return;
			}
			if (this.#model.draft.codex.compaction.mode === "off") {
				this.#ctx.ui.notify("OpenAI Codex compaction is disabled", "warning");
				return;
			}
			const confirmed = await this.#withOverlayHidden(() =>
				this.#ctx.ui.confirm(
					"Compact Codex context",
					"Compact the current session using the configured OpenAI Codex compaction path?",
					{ signal },
				),
			);
			if (this.#disposed || signal.aborted || !confirmed) return;
			const sessionId = this.#ctx.sessionManager.getSessionId();
			const coordinator = this.#coordinator;
			if (coordinator !== undefined && !coordinator.begin(sessionId)) {
				this.#ctx.ui.notify("OpenAI Codex compaction is already in progress", "warning");
				return;
			}
			this.#ctx.compact({
				onComplete: () => {
					coordinator?.end(sessionId, "success");
				},
				onError: () => {
					coordinator?.end(sessionId, "error");
				},
			});
			if (this.#disposed) return;
			this.#ctx.ui.notify("OpenAI Codex compaction requested", "info");
		});
	}

	async #editAutoCompactTokenLimit(): Promise<void> {
		await this.#runTask(async (signal) => {
			const compaction = this.#model.draft.codex.compaction;
			const current =
				compaction.mode === "auto" ? String(compaction.autoCompactTokenLimit) : "model";
			const value = await this.#withOverlayHidden(() =>
				this.#ctx.ui.input("Auto compact token limit", current, { signal }),
			);
			if (this.#disposed || signal.aborted || value === undefined) return;
			const trimmed = value.trim();
			if (trimmed === "model") {
				this.#model.setAutoCompactTokenLimit("model");
				return;
			}
			const numeric = Number(trimmed);
			if (!Number.isSafeInteger(numeric) || numeric <= 0) {
				this.#model.markError(
					"Auto compact token limit must be model or a positive integer",
					"validation-error",
				);
				return;
			}
			this.#model.setAutoCompactTokenLimit(numeric);
		});
	}

	async #editProviders(): Promise<void> {
		await this.#runTask(async (signal) => {
			const current = this.#model.draft.activation.providers.join(", ");
			const value = await this.#withOverlayHidden(() =>
				this.#ctx.ui.input("Active Pi provider ids", current, { signal }),
			);
			if (this.#disposed || signal.aborted || value === undefined) return;
			const providers = value.split(",").map((provider) => provider.trim());
			if (
				providers.length === 0 ||
				providers.some((provider) => provider.length === 0) ||
				new Set(providers).size !== providers.length
			) {
				this.#model.markError(
					"Active providers must be unique, non-empty Pi provider ids",
					"validation-error",
				);
				return;
			}
			this.#model.setActivationProviders(providers);
		});
	}

	async #exportDiagnostics(): Promise<void> {
		await this.#runTask(async (signal) => {
			if (this.#exporter === undefined) {
				this.#ctx.ui.notify("Diagnostics export is unavailable", "warning");
				return;
			}
			const confirmed = await this.#withOverlayHidden(() =>
				this.#ctx.ui.confirm(
					"Export Codex diagnostics",
					"Export adaptor and bridge metadata only. Messages, credentials, and compaction data are excluded.",
					{ signal },
				),
			);
			if (this.#disposed || signal.aborted || !confirmed) return;
			const path = await this.#withOverlayHidden(() =>
				this.#ctx.ui.input(
					"Diagnostics export path",
					resolve(this.#ctx.cwd, "pi-codex-adaptor-diagnostics.json"),
					{ signal },
				),
			);
			if (this.#disposed || signal.aborted || path === undefined || path.trim().length === 0) {
				return;
			}
			try {
				const result = await exportDiagnosticsConfirmed(
					this.#exporter,
					this.#diagnostics,
					path.trim(),
					{ confirmed: true },
				);
				if (this.#disposed || signal.aborted) return;
				this.#ctx.ui.notify(`Diagnostics exported: ${result.path} (${result.sha256})`, "info");
			} catch {
				if (this.#disposed || signal.aborted) return;
				this.#ctx.ui.notify("Codex diagnostics could not be exported", "error");
			}
		});
	}

	async #runTask(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.#disposed) return;
		const generation = this.#taskGeneration;
		const controller = new AbortController();
		this.#abortControllers.add(controller);
		try {
			await task(controller.signal);
		} finally {
			this.#abortControllers.delete(controller);
			if (generation !== this.#taskGeneration || this.#disposed) {
				// Drop late updates after disposal or a newer generation.
			}
		}
	}

	async #withOverlayHidden<T>(prompt: () => Promise<T>): Promise<T> {
		const handle = this.#overlayHandle;
		if (handle === undefined) return await prompt();
		handle.setHidden(true);
		try {
			return await prompt();
		} finally {
			if (!this.#disposed) {
				handle.setHidden(false);
				handle.focus();
			}
		}
	}

	#closeNow(): void {
		if (this.#disposed) return;
		this.dispose();
		this.#done(undefined);
	}
}

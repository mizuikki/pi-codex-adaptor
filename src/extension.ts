import { homedir } from "node:os";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import packageMetadata from "../package.json" with { type: "json" };
import { CodexCompactionCoordinator, CodexCompactionStore } from "./application/compaction.ts";
import { ConfigurationService } from "./application/configuration.ts";
import { ProviderActivationPolicy } from "./application/provider-activation.ts";
import { ResolveEffectiveCapabilities } from "./application/resolve-effective-capabilities.ts";
import { BundledCodexRuntime } from "./infrastructure/codex-bridge/runtime.ts";
import { FileConfigurationRepository } from "./infrastructure/configuration/file-config-repository.ts";
import { FileDiagnosticsExporter } from "./infrastructure/diagnostics/file-diagnostics-exporter.ts";
import { registerCodexCompaction } from "./integration/pi/codex-compaction.ts";
import { CodexProviderRequestGuard } from "./integration/pi/codex-provider-request-guard.ts";
import {
	createCodexToolProfile,
	createUnavailableCodexToolProfile,
} from "./integration/pi/codex-tool-profile.ts";
import { registerCodexTools } from "./integration/pi/codex-tools.ts";
import {
	createCodexProviderDispatchers,
	registerCodexProviderRoutes,
} from "./integration/pi/provider-dispatcher.ts";
import {
	getProcessProviderSessionRouter,
	type ProviderSessionLease,
} from "./integration/pi/provider-session-router.ts";
import { openSettingsOverlay } from "./ui/terminal/settings-overlay.ts";

/** Pi composition root for configuration and diagnostics surfaces. */
export default async function piCodexAdaptor(pi: ExtensionAPI): Promise<void> {
	if (typeof pi.registerCommand !== "function") return;
	const configFile = resolve(homedir(), ".pi", "agent", "pi-codex-adaptor.json");
	const service = new ConfigurationService(new FileConfigurationRepository(configFile));
	const activation = new ProviderActivationPolicy(service);
	// Load the persisted activation snapshot before Pi can dispatch the first prompt.
	await activation.refresh();
	const diagnostics = new FileDiagnosticsExporter();
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const extensionEntryPath = normalize(fileURLToPath(import.meta.url));
	const hasToolProfileApi =
		typeof pi.getActiveTools === "function" &&
		typeof pi.getAllTools === "function" &&
		typeof pi.setActiveTools === "function" &&
		typeof pi.registerTool === "function" &&
		typeof pi.on === "function";
	const toolProfile = hasToolProfileApi
		? createCodexToolProfile(pi, extensionEntryPath)
		: createUnavailableCodexToolProfile();
	const runtime = new BundledCodexRuntime({
		packageRoot,
		clientVersion: packageMetadata.version,
		allowDevelopmentBuild: packageMetadata.version === "0.0.0",
	});
	const compactions = new CodexCompactionStore();
	const compactionCoordinator = new CodexCompactionCoordinator();
	const capabilities = new ResolveEffectiveCapabilities(runtime);
	const requestGuard = new CodexProviderRequestGuard();
	let providerSessionLease: ProviderSessionLease | undefined;
	let registerSelectedProviderRoutes: (() => void) | undefined;
	let createProviderSessionLease: (() => ProviderSessionLease) | undefined;
	if (typeof pi.registerProvider === "function") {
		const dispatchers = createCodexProviderDispatchers(
			runtime,
			service,
			activation,
			compactions,
			capabilities,
			toolProfile,
			requestGuard,
		);
		const router = getProcessProviderSessionRouter();
		createProviderSessionLease = () => router.createLease(dispatchers);
		providerSessionLease = createProviderSessionLease();
		const registerProvider = pi.registerProvider;
		registerSelectedProviderRoutes = () => {
			registerCodexProviderRoutes(registerProvider, router, activation.providers());
		};
		registerSelectedProviderRoutes();
	}
	const unregisterProviderRouteListener = service.onChange(() =>
		registerSelectedProviderRoutes?.(),
	);
	if (typeof pi.on === "function") {
		pi.on("session_start", async (_event, ctx) => {
			providerSessionLease?.release();
			providerSessionLease = createProviderSessionLease?.();
			providerSessionLease?.bind(ctx.sessionManager.getSessionId());
			requestGuard.invalidateAll();
			await activation.refresh();
			registerSelectedProviderRoutes?.();
		});
		pi.on("session_shutdown", async () => {
			unregisterProviderRouteListener();
			providerSessionLease?.release();
			requestGuard.invalidateAll();
			requestGuard.dispose();
			toolProfile.restorePi();
			compactionCoordinator.disposeAll();
			capabilities.invalidate();
			activation.dispose();
			await runtime.shutdown();
		});
		if (
			typeof pi.getActiveTools === "function" &&
			typeof pi.getAllTools === "function" &&
			typeof pi.getThinkingLevel === "function"
		) {
			registerCodexCompaction(
				pi,
				runtime,
				service,
				compactions,
				activation,
				compactionCoordinator,
				capabilities,
				toolProfile,
				requestGuard,
			);
		}
	}
	if (
		typeof pi.registerTool === "function" &&
		typeof pi.getActiveTools === "function" &&
		typeof pi.getAllTools === "function" &&
		typeof pi.setActiveTools === "function" &&
		typeof pi.on === "function"
	) {
		registerCodexTools(pi, runtime, service, activation, capabilities, toolProfile);
	}
	pi.registerCommand("codex", {
		description: "Open Codex adaptor settings",
		handler: async (_args, ctx) =>
			openSettingsOverlay(ctx, service, runtime, diagnostics, compactionCoordinator, capabilities),
	});
}

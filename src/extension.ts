import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import packageMetadata from "../package.json" with { type: "json" };
import { CodexCompactionCoordinator, CodexCompactionStore } from "./application/compaction.ts";
import { ConfigurationService } from "./application/configuration.ts";
import { ProviderActivationPolicy } from "./application/provider-activation.ts";
import { BundledCodexRuntime } from "./infrastructure/codex-bridge/runtime.ts";
import { FileConfigurationRepository } from "./infrastructure/configuration/file-config-repository.ts";
import { FileDiagnosticsExporter } from "./infrastructure/diagnostics/file-diagnostics-exporter.ts";
import { registerCodexCompaction } from "./integration/pi/codex-compaction.ts";
import { registerCodexTools } from "./integration/pi/codex-tools.ts";
import { createCodexProviderDispatchers } from "./integration/pi/provider-dispatcher.ts";
import { openSettingsOverlay } from "./ui/terminal/settings-overlay.ts";

/** Pi composition root for configuration and diagnostics surfaces. */
export default function piCodexAdaptor(pi: ExtensionAPI): void {
	if (typeof pi.registerCommand !== "function") return;
	const configFile = resolve(homedir(), ".pi", "agent", "pi-codex-adaptor.json");
	const service = new ConfigurationService(new FileConfigurationRepository(configFile));
	const activation = new ProviderActivationPolicy(service);
	const diagnostics = new FileDiagnosticsExporter();
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const runtime = new BundledCodexRuntime({
		packageRoot,
		clientVersion: packageMetadata.version,
		allowDevelopmentBuild: packageMetadata.version === "0.0.0",
	});
	const compactions = new CodexCompactionStore();
	const compactionCoordinator = new CodexCompactionCoordinator();
	if (typeof pi.registerProvider === "function") {
		const dispatchers = createCodexProviderDispatchers(runtime, service, activation, compactions);
		pi.registerProvider("openai-codex", {
			api: "openai-codex-responses",
			streamSimple: dispatchers.codexResponses,
		});
		pi.registerProvider("pi-codex-adaptor-openai-responses", {
			api: "openai-responses",
			streamSimple: dispatchers.openAiResponses,
		});
	}
	if (typeof pi.on === "function") {
		pi.on("session_start", async () => {
			await activation.refresh();
		});
		pi.on("session_shutdown", async () => {
			compactionCoordinator.disposeAll();
			activation.dispose();
			await runtime.shutdown();
		});
		if (
			typeof pi.getActiveTools === "function" &&
			typeof pi.getAllTools === "function" &&
			typeof pi.getThinkingLevel === "function"
		) {
			registerCodexCompaction(pi, runtime, service, compactions, activation, compactionCoordinator);
		}
	}
	if (
		typeof pi.registerTool === "function" &&
		typeof pi.getActiveTools === "function" &&
		typeof pi.setActiveTools === "function" &&
		typeof pi.on === "function"
	) {
		registerCodexTools(pi, runtime, service, activation);
	}
	pi.registerCommand("codex", {
		description: "Open Codex adaptor settings",
		handler: async (_args, ctx) =>
			openSettingsOverlay(ctx, service, runtime, diagnostics, compactionCoordinator),
	});
}

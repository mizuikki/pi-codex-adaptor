import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import packageMetadata from "../package.json" with { type: "json" };
import { CodexCompactionCoordinator, CodexCompactionStore } from "./application/compaction.ts";
import { ConfigurationService } from "./application/configuration.ts";
import { BundledCodexRuntime } from "./infrastructure/codex-bridge/runtime.ts";
import { FileConfigurationRepository } from "./infrastructure/configuration/file-config-repository.ts";
import { FileDiagnosticsExporter } from "./infrastructure/diagnostics/file-diagnostics-exporter.ts";
import { registerCodexCompaction } from "./integration/pi/codex-compaction.ts";
import { createCodexStreamSimple } from "./integration/pi/codex-provider.ts";
import { registerCodexTools } from "./integration/pi/codex-tools.ts";
import { openSettingsOverlay } from "./ui/terminal/settings-overlay.ts";

/** Pi composition root for configuration and diagnostics surfaces. */
export default function piCodexAdaptor(pi: ExtensionAPI): void {
	if (typeof pi.registerCommand !== "function") return;
	const configFile = resolve(homedir(), ".pi", "agent", "pi-codex-adaptor.json");
	const service = new ConfigurationService(new FileConfigurationRepository(configFile));
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
		pi.registerProvider("openai-codex", {
			streamSimple: createCodexStreamSimple(runtime, service, compactions),
		});
	}
	if (typeof pi.on === "function") {
		pi.on("session_shutdown", async () => {
			compactionCoordinator.disposeAll();
			await runtime.shutdown();
		});
		if (
			typeof pi.getActiveTools === "function" &&
			typeof pi.getAllTools === "function" &&
			typeof pi.getThinkingLevel === "function"
		) {
			registerCodexCompaction(pi, runtime, service, compactions, compactionCoordinator);
		}
	}
	if (
		typeof pi.registerTool === "function" &&
		typeof pi.getActiveTools === "function" &&
		typeof pi.setActiveTools === "function" &&
		typeof pi.on === "function"
	) {
		registerCodexTools(pi, runtime, service);
	}
	pi.registerCommand("codex", {
		description: "Open Codex adaptor settings",
		handler: async (_args, ctx) =>
			openSettingsOverlay(ctx, service, runtime, diagnostics, compactionCoordinator),
	});
}

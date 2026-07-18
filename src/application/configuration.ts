import {
	type CodexConfig,
	type ConfigCapabilityContext,
	type ConfigSettingEvaluation,
	ConfigurationError,
	type ConfigurationIssue,
	createDefaultConfig,
	evaluateConfigSettings,
	validateConfigForSave,
} from "../domain/config.ts";

export type ConfigurationProbeResult =
	| { kind: "ready"; config: CodexConfig }
	| { kind: "missing" }
	| { kind: "invalid_json"; message: string }
	| { kind: "invalid_schema"; issues: readonly ConfigurationIssue[] }
	| { kind: "storage_failure"; message: string };

export type ConfigurationRecoveryAction = "reset_to_defaults" | "restore_backup";

export interface ConfigurationInspection {
	probe: ConfigurationProbeResult;
	recovery: readonly ConfigurationRecoveryAction[];
}

export interface ConfigurationRepository {
	probe(): Promise<ConfigurationProbeResult>;
	loadOrCreate(): Promise<CodexConfig>;
	save(config: CodexConfig): Promise<void>;
	restoreBackup(): Promise<CodexConfig>;
	backupAvailable(): Promise<boolean>;
}

export class ConfigurationService {
	readonly #repository: ConfigurationRepository;
	readonly #listeners = new Set<(config: CodexConfig) => void>();

	constructor(repository: ConfigurationRepository) {
		this.#repository = repository;
	}

	onChange(listener: (config: CodexConfig) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	load(): Promise<CodexConfig> {
		return this.#repository.loadOrCreate();
	}

	async inspect(): Promise<ConfigurationInspection> {
		const probe = await this.#repository.probe();
		const recovery: ConfigurationRecoveryAction[] = [];
		if (
			probe.kind === "invalid_json" ||
			probe.kind === "invalid_schema" ||
			probe.kind === "missing"
		) {
			recovery.push("reset_to_defaults");
		}
		if (
			(probe.kind === "invalid_json" || probe.kind === "invalid_schema") &&
			(await this.#repository.backupAvailable())
		) {
			recovery.push("restore_backup");
		}
		return { probe, recovery };
	}

	async applyDraft(draft: unknown, context: ConfigCapabilityContext = {}): Promise<CodexConfig> {
		const config = validateConfigForSave(draft, context);
		await this.#repository.save(config);
		this.#notify(config);
		return config;
	}

	evaluate(
		config: CodexConfig,
		context: ConfigCapabilityContext = {},
	): readonly ConfigSettingEvaluation[] {
		return evaluateConfigSettings(config, context);
	}

	async resetToDefaults(): Promise<CodexConfig> {
		const config = createDefaultConfig();
		await this.#repository.save(config);
		this.#notify(config);
		return config;
	}

	async restoreBackup(): Promise<CodexConfig> {
		const config = await this.#repository.restoreBackup();
		this.#notify(config);
		return config;
	}

	#notify(config: CodexConfig): void {
		for (const listener of this.#listeners) {
			try {
				listener(config);
			} catch {
				// A policy listener must not turn a successful configuration save into a failure.
			}
		}
	}
}

export { ConfigurationError };

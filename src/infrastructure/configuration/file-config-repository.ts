import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
	ConfigurationProbeResult,
	ConfigurationRepository,
} from "../../application/configuration.ts";
import {
	type CodexConfig,
	ConfigurationError,
	createDefaultConfig,
	parseConfig,
} from "../../domain/config.ts";

export class ConfigurationStorageError extends Error {
	readonly code: "backup_unavailable" | "invalid_json" | "storage_failure";

	constructor(code: ConfigurationStorageError["code"], message: string) {
		super(message);
		this.name = "ConfigurationStorageError";
		this.code = code;
	}
}

export class FileConfigurationRepository implements ConfigurationRepository {
	readonly #configFile: string;
	readonly #backupFile: string;

	constructor(configFile: string) {
		this.#configFile = configFile;
		this.#backupFile = `${configFile}.bak`;
	}

	async probe(): Promise<ConfigurationProbeResult> {
		try {
			const config = await this.#readConfig(this.#configFile);
			return { kind: "ready", config };
		} catch (error) {
			if (isMissingFile(error)) return { kind: "missing" };
			if (error instanceof ConfigurationError) {
				return { kind: "invalid_schema", issues: error.issues };
			}
			if (error instanceof ConfigurationStorageError && error.code === "invalid_json") {
				return { kind: "invalid_json", message: error.message };
			}
			if (error instanceof ConfigurationStorageError && error.code === "storage_failure") {
				return { kind: "storage_failure", message: error.message };
			}
			return {
				kind: "storage_failure",
				message: "The Codex adaptor configuration could not be read",
			};
		}
	}

	async loadOrCreate(): Promise<CodexConfig> {
		try {
			return await this.#readConfig(this.#configFile);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}

		const config = createDefaultConfig();
		await mkdir(dirname(this.#configFile), { recursive: true, mode: 0o700 });
		try {
			const handle = await open(this.#configFile, "wx", 0o600);
			try {
				await handle.writeFile(serialize(config), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return config;
		} catch (error) {
			if (isExistingFile(error)) return this.#readConfig(this.#configFile);
			throw storageFailure();
		}
	}

	async save(config: CodexConfig): Promise<void> {
		const validated = parseConfig(config);
		await mkdir(dirname(this.#configFile), { recursive: true, mode: 0o700 });
		const current = await this.#readValidCurrent();
		if (current !== undefined) {
			await this.#atomicWrite(this.#backupFile, serialize(current));
		}
		await this.#atomicWrite(this.#configFile, serialize(validated));
	}

	async restoreBackup(): Promise<CodexConfig> {
		let backup: CodexConfig;
		try {
			backup = await this.#readConfig(this.#backupFile);
		} catch (error) {
			if (isMissingFile(error)) {
				throw new ConfigurationStorageError(
					"backup_unavailable",
					"No valid configuration backup is available",
				);
			}
			if (
				error instanceof ConfigurationError ||
				(error instanceof ConfigurationStorageError && error.code === "invalid_json")
			) {
				throw new ConfigurationStorageError(
					"backup_unavailable",
					"No valid configuration backup is available",
				);
			}
			throw error;
		}
		await this.#atomicWrite(this.#configFile, serialize(backup));
		return backup;
	}

	async backupAvailable(): Promise<boolean> {
		try {
			await this.#readConfig(this.#backupFile);
			return true;
		} catch {
			return false;
		}
	}

	async #readValidCurrent(): Promise<CodexConfig | undefined> {
		try {
			return await this.#readConfig(this.#configFile);
		} catch (error) {
			if (
				isMissingFile(error) ||
				error instanceof ConfigurationError ||
				(error instanceof ConfigurationStorageError && error.code === "invalid_json")
			) {
				return undefined;
			}
			throw error;
		}
	}

	async #readConfig(path: string): Promise<CodexConfig> {
		let source: string;
		try {
			source = await readFile(path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) throw error;
			throw storageFailure();
		}
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch {
			throw new ConfigurationStorageError(
				"invalid_json",
				"The Codex adaptor configuration is not valid JSON",
			);
		}
		return parseConfig(value);
	}

	async #atomicWrite(path: string, contents: string): Promise<void> {
		const temporary = `${path}.tmp-${randomUUID()}`;
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(contents, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
		} catch {
			await rm(temporary, { force: true }).catch(() => {});
			throw storageFailure();
		}
	}
}

function serialize(config: CodexConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

function storageFailure(): ConfigurationStorageError {
	return new ConfigurationStorageError(
		"storage_failure",
		"The Codex adaptor configuration could not be stored",
	);
}

function isMissingFile(error: unknown): boolean {
	return isNodeError(error) && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
	return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

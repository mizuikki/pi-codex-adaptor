import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigurationService } from "../../src/application/configuration.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";
import {
	ConfigurationStorageError,
	FileConfigurationRepository,
} from "../../src/infrastructure/configuration/file-config-repository.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function repository(): Promise<{
	directory: string;
	configFile: string;
	repository: FileConfigurationRepository;
}> {
	const directory = await mkdtemp(join(tmpdir(), "adaptor-config-test-"));
	temporaryDirectories.push(directory);
	const configFile = join(directory, "nested", "config.json");
	return { directory, configFile, repository: new FileConfigurationRepository(configFile) };
}

describe("file configuration repository", () => {
	test("creates defaults once and reloads them", async () => {
		const fixture = await repository();
		const created = await fixture.repository.loadOrCreate();
		expect(created).toEqual(createDefaultConfig());
		expect(await fixture.repository.loadOrCreate()).toEqual(created);
	});

	test("backs up the last valid configuration and restores it", async () => {
		const fixture = await repository();
		const original = await fixture.repository.loadOrCreate();
		const changed = {
			...original,
			ui: { status: false },
		} as const;
		await fixture.repository.save(changed);
		await writeFile(fixture.configFile, "invalid", "utf8");

		const restored = await fixture.repository.restoreBackup();
		expect(restored).toEqual(original);
		expect(JSON.parse(await readFile(fixture.configFile, "utf8"))).toEqual(original);
	});

	test("preserves invalid existing files instead of replacing them", async () => {
		const fixture = await repository();
		await fixture.repository.loadOrCreate();
		await writeFile(fixture.configFile, "invalid", "utf8");

		await expect(fixture.repository.loadOrCreate()).rejects.toBeInstanceOf(
			ConfigurationStorageError,
		);
		expect(await readFile(fixture.configFile, "utf8")).toBe("invalid");
	});

	test("probes invalid schema and offers recovery actions", async () => {
		const fixture = await repository();
		const original = await fixture.repository.loadOrCreate();
		const first = { ...original, ui: { status: false } };
		const second = {
			...original,
			ui: { status: true },
			tools: { ...original.tools, backgroundSessions: false },
		};
		await fixture.repository.save(first);
		await fixture.repository.save(second);
		await writeFile(
			fixture.configFile,
			JSON.stringify({
				schemaVersion: 2,
				activation: { providers: [] },
				tools: {},
				codex: {},
				ui: {},
			}),
			"utf8",
		);

		const service = new ConfigurationService(fixture.repository);
		const inspection = await service.inspect();
		expect(inspection.probe.kind).toBe("invalid_schema");
		expect(inspection.recovery).toEqual(["reset_to_defaults", "restore_backup"]);

		const restored = await service.restoreBackup();
		expect(restored).toEqual(first);
	});

	test("resets invalid configuration to defaults without requiring a backup", async () => {
		const fixture = await repository();
		await fixture.repository.loadOrCreate();
		await writeFile(fixture.configFile, "not-json", "utf8");
		const service = new ConfigurationService(fixture.repository);
		const inspection = await service.inspect();
		expect(inspection.probe.kind).toBe("invalid_json");
		expect(inspection.recovery).toEqual(["reset_to_defaults"]);

		const defaults = await service.resetToDefaults();
		expect(defaults).toEqual(createDefaultConfig());
		expect(JSON.parse(await readFile(fixture.configFile, "utf8"))).toEqual(defaults);
	});

	test("reports missing backups as a storage failure path", async () => {
		const fixture = await repository();
		await expect(fixture.repository.restoreBackup()).rejects.toMatchObject({
			code: "backup_unavailable",
		});
		expect(await fixture.repository.backupAvailable()).toBe(false);
	});

	test("rejects invalid drafts on save and preserves the previous file", async () => {
		const fixture = await repository();
		const original = await fixture.repository.loadOrCreate();
		const service = new ConfigurationService(fixture.repository);
		await expect(
			service.applyDraft(
				{
					...original,
					codex: {
						...original.codex,
						compaction: { mode: "auto", autoCompactTokenLimit: 200_000 },
					},
				},
				{ contextWindow: 100_000 },
			),
		).rejects.toMatchObject({ code: "invalid_configuration" });
		expect(JSON.parse(await readFile(fixture.configFile, "utf8"))).toEqual(original);
	});
});

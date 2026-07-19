import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
	parseLocalNativeOptions,
	replaceArtifactDirectory,
	resolveLocalNativePaths,
} from "../../scripts/prepare-local-native.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("local native workflow", () => {
	test("defaults to a release build for the current host target", () => {
		expect(parseLocalNativeOptions([], "linux", "x64")).toEqual({
			target: "x86_64-unknown-linux-musl",
			profile: "release",
			checkOnly: false,
		});
		expect(parseLocalNativeOptions(["--debug"], "darwin", "arm64")).toEqual({
			target: "aarch64-apple-darwin",
			profile: "debug",
			checkOnly: false,
		});
		expect(parseLocalNativeOptions(["--check"], "darwin", "arm64").checkOnly).toBe(true);
		expect(() => parseLocalNativeOptions(["--debug", "--check"], "linux", "x64")).toThrow(
			/cannot be combined/,
		);
	});

	test("accepts only declared explicit targets and known options", () => {
		expect(
			parseLocalNativeOptions(["--target", "x86_64-pc-windows-msvc"], "linux", "x64"),
		).toMatchObject({ target: "x86_64-pc-windows-msvc" });
		expect(() => parseLocalNativeOptions(["--target", "unknown"], "linux", "x64")).toThrow(
			/Unsupported native build target/,
		);
		expect(() => parseLocalNativeOptions(["--future"], "linux", "x64")).toThrow(
			/Unknown local native option/,
		);
	});

	test("resolves profile and executable paths without shell-specific logic", () => {
		expect(
			resolveLocalNativePaths("/repo", {
				target: "x86_64-pc-windows-msvc",
				profile: "release",
			}),
		).toEqual({
			executable: resolve(
				"/repo",
				"native",
				"target",
				"x86_64-pc-windows-msvc",
				"release",
				"codex-bridge.exe",
			),
			assembledArtifact: resolve("/repo", "native", "artifacts", "x86_64-pc-windows-msvc"),
			installedArtifact: resolve("/repo", "native", "bin", "x86_64-pc-windows-msvc"),
		});
	});

	test("installs a verified artifact and removes the previous directory", async () => {
		const { source, destination } = await fixtureDirectories();
		await replaceArtifactDirectory(source, destination, async () => {
			expect(await readFile(resolve(destination, "artifact.txt"), "utf8")).toBe("new");
		});
		expect(await readFile(resolve(destination, "artifact.txt"), "utf8")).toBe("new");
	});

	test("restores the previous artifact when installed verification fails", async () => {
		const { source, destination } = await fixtureDirectories();
		await expect(
			replaceArtifactDirectory(source, destination, async () => {
				throw new Error("fixture verification failed");
			}),
		).rejects.toThrow(/fixture verification failed/);
		expect(await readFile(resolve(destination, "artifact.txt"), "utf8")).toBe("old");
	});
});

async function fixtureDirectories(): Promise<{ source: string; destination: string }> {
	const root = await mkdtemp(resolve(tmpdir(), "pi-codex-local-native-"));
	cleanups.push(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const source = resolve(root, "source");
	const destination = resolve(root, "installed", "target");
	await mkdir(source, { recursive: true });
	await mkdir(destination, { recursive: true });
	await writeFile(resolve(source, "artifact.txt"), "new");
	await writeFile(resolve(destination, "artifact.txt"), "old");
	return { source, destination };
}

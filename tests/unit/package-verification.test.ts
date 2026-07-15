import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { isSafeFileName } from "../../scripts/assemble-package.ts";
import {
	hasCompleteNativeArtifact,
	resolveDeclaredPackageExtension,
	resolvePackageExtension,
} from "../../scripts/verify-package.ts";

describe("package verification helpers", () => {
	test("accepts only plain native executable filenames", () => {
		expect(isSafeFileName("codex-bridge")).toBe(true);
		expect(isSafeFileName("codex-bridge.exe")).toBe(true);
		for (const value of [
			"",
			".",
			"..",
			"../codex-bridge",
			"bin/codex-bridge",
			"..\\bridge",
			"C:codex-bridge.exe",
		]) {
			expect(isSafeFileName(value)).toBe(false);
		}
	});

	test("requires a native executable and manifest for the same target", () => {
		expect(
			hasCompleteNativeArtifact([
				"native/bin/x86_64-unknown-linux-musl/codex-bridge",
				"native/bin/x86_64-unknown-linux-musl/native-artifact.json",
			]),
		).toBe(true);
		expect(hasCompleteNativeArtifact(["native/bin/target/native-artifact.json"])).toBe(false);
		expect(
			hasCompleteNativeArtifact([
				"native/bin/x86_64-pc-windows-msvc/codex-bridge.exe",
				"native/bin/x86_64-pc-windows-msvc/native-artifact.json",
			]),
		).toBe(true);
		expect(
			hasCompleteNativeArtifact([
				"native/bin/target-a/codex-bridge",
				"native/bin/target-b/native-artifact.json",
			]),
		).toBe(false);
		expect(
			hasCompleteNativeArtifact([
				"native/bin/unsupported-target/codex-bridge",
				"native/bin/unsupported-target/native-artifact.json",
			]),
		).toBe(false);
	});

	test("keeps Pi extension entries inside the installed package", () => {
		const packageRoot = resolve("/tmp", "installed-package");
		expect(resolvePackageExtension(packageRoot, "./src/extension.ts")).toBe(
			resolve(packageRoot, "src/extension.ts"),
		);
		for (const entry of [
			undefined,
			"",
			".",
			"../outside.ts",
			"/outside.ts",
			"..\\outside.ts",
			"C:\\outside.ts",
		]) {
			expect(() => resolvePackageExtension(packageRoot, entry)).toThrow();
		}
		expect(() => resolveDeclaredPackageExtension(packageRoot, [])).toThrow();
		expect(() =>
			resolveDeclaredPackageExtension(packageRoot, ["./src/extension.ts", "../outside.ts"]),
		).toThrow();
	});
});

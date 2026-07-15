import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveArtifactOutput } from "../../scripts/assemble-native-artifact.ts";

describe("native artifact output", () => {
	test("resolves a target below the artifacts directory", () => {
		const root = resolve("native", "artifacts");
		expect(resolveArtifactOutput("x86_64-unknown-linux-musl", root)).toBe(
			resolve(root, "x86_64-unknown-linux-musl"),
		);
	});

	test.each([
		"",
		".",
		"..",
		"../outside",
		"/tmp",
		"a/b",
		"a\\b",
		"C:\\Windows",
	])("rejects unsafe target %s", (target) => {
		expect(() => resolveArtifactOutput(target, resolve("native", "artifacts"))).toThrow();
	});
});

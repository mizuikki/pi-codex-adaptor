import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildNpmPublishArgs,
	buildReleaseManifest,
	tarballIntegrity,
} from "../../scripts/publish-package.ts";
import { PACKAGE_PATH_ALLOWLIST, unexpectedPackagePaths } from "../../scripts/verify-package.ts";
import {
	classifyPublicationState,
	commandFailureMeansMissing,
	isReleasePleaseCommit,
	npmDistTagForVersion,
	releaseArtifactName,
	validateReleaseAsLifecycle,
	verifyLocalReleaseTarball,
	verifyPublishedIntegrity,
	verifyReleaseDecision,
} from "../../scripts/verify-release.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface PublicationFixture {
	schemaVersion: number;
	cases: Array<{
		name: string;
		snapshot: {
			npmPublished: boolean;
			gitTagExists: boolean;
			githubReleaseExists: boolean;
		};
		expected: {
			action: "publish" | "finalize-only" | "complete" | "impossible";
			needsFinalize: boolean;
		};
	}>;
}

interface LifecycleFixture {
	schemaVersion: number;
	allowedBootstrapVersions: string[];
	configs: {
		rc: {
			path: string;
			required: Record<string, unknown>;
		};
		stable: {
			path: string;
			required: Record<string, unknown>;
			forbidden: string[];
		};
	};
	progression: Array<{
		name: string;
		channel: "rc" | "stable";
		from: string;
		releaseAs: string | null;
		to: string;
		npmDistTag: "rc" | "latest";
		clearReleaseAsAfterTag?: boolean;
		strategy?: string;
	}>;
	releaseAsLifecycle: Array<{
		name: string;
		bootstrapVersion: string;
		packageVersion: string;
		taggedVersions: string[];
		ok: boolean;
	}>;
}

const publicationFixture = JSON.parse(
	await readFile(resolve(repositoryRoot, "fixtures/release/publication-states.json"), "utf8"),
) as PublicationFixture;
const lifecycleFixture = JSON.parse(
	await readFile(resolve(repositoryRoot, "fixtures/release/release-please-lifecycle.json"), "utf8"),
) as LifecycleFixture;
const sampleManifest = JSON.parse(
	await readFile(resolve(repositoryRoot, "fixtures/release/sample-release-manifest.json"), "utf8"),
) as {
	package: string;
	version: string;
	projectSourceCommit: string;
	tarball: { filename: string; size: number; sha256: string; integrity: string };
	toolchain: {
		bun: string;
		node: string;
		npm: string;
		rust: string;
		typescript: string;
		typesNode: string;
		biome: string;
		pi: string;
		typebox: string;
	};
	conformance: {
		cli: { package: string; version: string; integrity: string };
		sdk: { package: string; version: string; integrity: string };
	};
};

describe("release publication state machine", () => {
	for (const testCase of publicationFixture.cases) {
		test(testCase.name, () => {
			const decision = classifyPublicationState(testCase.snapshot);
			expect(decision.action).toBe(testCase.expected.action);
			expect(decision.needsFinalize).toBe(testCase.expected.needsFinalize);
		});
	}
});

describe("npm dist-tag selection", () => {
	test("uses rc for prerelease versions and latest for stable versions", () => {
		expect(npmDistTagForVersion("0.1.0-rc.0")).toBe("rc");
		expect(npmDistTagForVersion("0.1.0-rc.1")).toBe("rc");
		expect(npmDistTagForVersion("0.1.0")).toBe("latest");
		expect(npmDistTagForVersion("1.0.0+build-1")).toBe("latest");
		expect(buildNpmPublishArgs({ tarballPath: "pkg.tgz", version: "0.1.0-rc.1" })).toEqual([
			"npm",
			"publish",
			"pkg.tgz",
			"--access",
			"public",
			"--tag",
			"rc",
			"--provenance",
		]);
		expect(buildNpmPublishArgs({ tarballPath: "pkg.tgz", version: "0.1.0" })).toEqual([
			"npm",
			"publish",
			"pkg.tgz",
			"--access",
			"public",
			"--tag",
			"latest",
			"--provenance",
		]);
	});
});

describe("release-as and Release Please lifecycle", () => {
	test("rc and stable configs match the pinned Release Please contract", async () => {
		for (const [channel, config] of Object.entries(lifecycleFixture.configs)) {
			const raw = JSON.parse(await readFile(resolve(repositoryRoot, config.path), "utf8")) as {
				packages: Record<string, Record<string, unknown>>;
			};
			const packageConfig = raw.packages["."];
			expect(packageConfig).toBeDefined();
			if (packageConfig === undefined) {
				throw new Error(`Missing package config in ${config.path}`);
			}
			for (const [key, value] of Object.entries(config.required)) {
				expect(packageConfig[key]).toEqual(value);
			}
			if (channel === "stable") {
				for (const key of lifecycleFixture.configs.stable.forbidden) {
					expect(packageConfig[key]).toBeUndefined();
				}
			}
		}
	});

	test("documents rc0 -> rc1 -> stable progression without network", () => {
		expect(lifecycleFixture.progression.map((step) => step.to)).toEqual([
			"0.1.0-rc.0",
			"0.1.0-rc.1",
			"0.1.0",
		]);
		for (const step of lifecycleFixture.progression) {
			expect(npmDistTagForVersion(step.to)).toBe(step.npmDistTag);
			if (step.releaseAs !== null) {
				expect(step.clearReleaseAsAfterTag).toBe(true);
			}
		}
	});

	for (const testCase of lifecycleFixture.releaseAsLifecycle) {
		test(testCase.name, () => {
			const result = validateReleaseAsLifecycle({
				bootstrapVersion: testCase.bootstrapVersion || undefined,
				packageVersion: testCase.packageVersion,
				taggedVersions: new Set(testCase.taggedVersions),
				allowedBootstrapVersions: lifecycleFixture.allowedBootstrapVersions,
			});
			expect(result.ok).toBe(testCase.ok);
		});
	}
});

describe("verify-release decision helpers", () => {
	const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

	test("accepts a release-please publish candidate on an RC branch", () => {
		const result = verifyReleaseDecision({
			packageName: "pi-codex-adaptor",
			version: "0.1.0-rc.1",
			manifestVersion: "0.1.0-rc.1",
			sourceCommit,
			parentPackageVersion: "0.1.0-rc.0",
			commitSubject: "chore(release-0.1): release pi-codex-adaptor v0.1.0-rc.1",
			changelog: "## 0.1.0-rc.1\n\n### Features\n\n* demo\n",
			branchName: "release/0.1",
			eventName: "push",
			publication: {
				npmPublished: false,
				gitTagExists: false,
				githubReleaseExists: false,
			},
		});
		expect(result.release).toBe(true);
		expect(result.alreadyPublished).toBe(false);
		expect(result.needsFinalize).toBe(true);
		expect(result.publicationAction).toBe("publish");
		expect(result.npmDistTag).toBe("rc");
	});

	test("routes already-published packages to finalize-only recovery", () => {
		const result = verifyReleaseDecision({
			packageName: "pi-codex-adaptor",
			version: "0.1.0-rc.1",
			manifestVersion: "0.1.0-rc.1",
			sourceCommit,
			parentPackageVersion: "0.1.0-rc.0",
			commitSubject: "chore(release-0.1): release pi-codex-adaptor v0.1.0-rc.1",
			changelog: "## 0.1.0-rc.1\n\n### Features\n\n* demo\n",
			branchName: "release/0.1",
			eventName: "workflow_dispatch",
			dispatchVersion: "0.1.0-rc.1",
			dispatchCommit: sourceCommit,
			publication: {
				npmPublished: true,
				gitTagExists: false,
				githubReleaseExists: false,
			},
		});
		expect(result.publicationAction).toBe("finalize-only");
		expect(result.alreadyPublished).toBe(true);
		expect(result.needsFinalize).toBe(true);
	});

	test("returns a non-release decision only for complete objects on the source commit", () => {
		const result = verifyReleaseDecision({
			packageName: "pi-codex-adaptor",
			version: "0.1.0",
			manifestVersion: "0.1.0",
			sourceCommit,
			parentPackageVersion: "0.1.0-rc.1",
			commitSubject: "chore(main): release pi-codex-adaptor v0.1.0",
			changelog: "## 0.1.0\n\n### Features\n\n* stable\n",
			branchName: "main",
			eventName: "push",
			publication: {
				npmPublished: true,
				gitTagExists: true,
				githubReleaseExists: true,
				gitTagTarget: sourceCommit,
				githubReleaseTarget: sourceCommit,
			},
		});
		expect(result.release).toBe(false);
		expect(result.publicationAction).toBe("complete");
	});

	test("rejects release objects that target another commit", () => {
		expect(
			classifyPublicationState(
				{
					npmPublished: true,
					gitTagExists: true,
					githubReleaseExists: true,
					gitTagTarget: "f".repeat(40),
					githubReleaseTarget: sourceCommit,
				},
				sourceCommit,
			).action,
		).toBe("impossible");
	});

	test("matches only the exact Release Please subject for the package version", () => {
		expect(isReleasePleaseCommit("chore(main): release pi-codex-adaptor v0.1.0", "0.1.0")).toBe(
			true,
		);
		expect(isReleasePleaseCommit("fix: release resource handles", "0.1.0")).toBe(false);
		expect(isReleasePleaseCommit("chore(main): release pi-codex-adaptor v0.1.1", "0.1.0")).toBe(
			false,
		);
		expect(isReleasePleaseCommit("anything", "0.1.0", true)).toBe(true);
	});

	test("rejects impossible tag-without-npm state", () => {
		expect(() =>
			verifyReleaseDecision({
				packageName: "pi-codex-adaptor",
				version: "0.1.0",
				manifestVersion: "0.1.0",
				sourceCommit,
				parentPackageVersion: "0.1.0-rc.1",
				commitSubject: "chore(main): release pi-codex-adaptor v0.1.0",
				changelog: "## 0.1.0\n\n### Features\n\n* stable\n",
				branchName: "main",
				eventName: "push",
				publication: {
					npmPublished: false,
					gitTagExists: true,
					githubReleaseExists: false,
				},
			}),
		).toThrow(/without a matching npm publication/i);
	});

	test("rejects channel mismatches", () => {
		expect(() =>
			verifyReleaseDecision({
				packageName: "pi-codex-adaptor",
				version: "0.1.0-rc.1",
				manifestVersion: "0.1.0-rc.1",
				sourceCommit,
				parentPackageVersion: "0.1.0-rc.0",
				commitSubject: "chore(main): release pi-codex-adaptor v0.1.0-rc.1",
				changelog: "## 0.1.0-rc.1\n\n### Features\n\n* demo\n",
				branchName: "main",
				eventName: "push",
				publication: {
					npmPublished: false,
					gitTagExists: false,
					githubReleaseExists: false,
				},
			}),
		).toThrow(/does not match release channel/i);
	});

	test("verifies registry integrity against the saved release manifest", () => {
		expect(() =>
			verifyPublishedIntegrity({
				packageName: sampleManifest.package,
				sourceCommit: sampleManifest.projectSourceCommit,
				registry: {
					version: sampleManifest.version,
					integrity: sampleManifest.tarball.integrity,
				},
				manifest: sampleManifest,
			}),
		).not.toThrow();

		expect(() =>
			verifyPublishedIntegrity({
				packageName: sampleManifest.package,
				sourceCommit: sampleManifest.projectSourceCommit,
				registry: {
					version: sampleManifest.version,
					integrity: "sha512-deadbeef",
				},
				manifest: sampleManifest,
			}),
		).toThrow(/integrity/i);

		expect(() =>
			verifyPublishedIntegrity({
				packageName: sampleManifest.package,
				sourceCommit: sampleManifest.projectSourceCommit,
				registry: { version: sampleManifest.version },
				manifest: sampleManifest,
			}),
		).toThrow(/unavailable/i);
	});

	test("verifies saved tarball bytes and rejects paths outside the bundle", async () => {
		const directory = await mkdtemp(resolve(tmpdir(), "pi-codex-release-"));
		try {
			const bytes = Buffer.from("saved-exact-tarball");
			const filename = "pi-codex-adaptor-0.1.0.tgz";
			const manifestPath = resolve(directory, "release-manifest.json");
			await writeFile(resolve(directory, filename), bytes);
			const manifest = {
				package: "pi-codex-adaptor",
				version: "0.1.0",
				projectSourceCommit: sourceCommit,
				tarball: {
					filename,
					size: bytes.byteLength,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
				},
			};
			await writeFile(manifestPath, JSON.stringify(manifest));
			await expect(verifyLocalReleaseTarball(manifestPath, manifest)).resolves.toBe(
				resolve(directory, filename),
			);
			await expect(
				verifyLocalReleaseTarball(manifestPath, {
					...manifest,
					tarball: { ...manifest.tarball, filename: "../outside.tgz" },
				}),
			).rejects.toThrow(/contained basename/i);
			await writeFile(resolve(directory, filename), "mutated");
			await expect(verifyLocalReleaseTarball(manifestPath, manifest)).rejects.toThrow(/size/i);
			await writeFile(resolve(directory, filename), Buffer.alloc(bytes.byteLength, 0x61));
			await expect(verifyLocalReleaseTarball(manifestPath, manifest)).rejects.toThrow(/SHA-256/i);
			await writeFile(resolve(directory, filename), bytes);
			await expect(
				verifyLocalReleaseTarball(manifestPath, {
					...manifest,
					tarball: { ...manifest.tarball, integrity: "sha512-invalid" },
				}),
			).rejects.toThrow(/integrity/i);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("distinguishes missing refs from generic Git failures", () => {
		expect(commandFailureMeansMissing(["git", "ls-remote", "--exit-code", "origin"], 2, "")).toBe(
			true,
		);
		expect(
			commandFailureMeansMissing(
				["git", "ls-remote", "--exit-code", "origin"],
				128,
				"repository not found",
			),
		).toBe(false);
		expect(commandFailureMeansMissing(["gh", "release", "view"], 1, "not found")).toBe(true);
	});
});

describe("release workflow hardening", () => {
	test("persists recovery artifacts before publishing with scoped credentials", async () => {
		const workflow = await readFile(
			resolve(repositoryRoot, ".github/workflows/release.yml"),
			"utf8",
		);
		expect(workflow.match(/no-cache: true/g)).toHaveLength(3);
		expect(workflow).toContain("persist-credentials: false");
		expect(workflow).toMatch(/gh api --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/git\/refs"/);
		expect(workflow.indexOf("Upload exact tarball and release manifest")).toBeLessThan(
			workflow.indexOf("Publish the saved exact tarball"),
		);
		expect(workflow).toMatch(/for run_id in "\$\{run_ids\[@\]\}"/);
		expect(workflow).toContain("needs.detect.outputs.publication_action == 'complete'");
	});

	test("scopes release-as bootstrap versions to the selected channel", async () => {
		const workflow = await readFile(
			resolve(repositoryRoot, ".github/workflows/release-pr.yml"),
			"utf8",
		);
		expect(workflow).toContain('expected="0.1.0-rc.0"');
		expect(workflow).toContain('expected="0.1.0"');
		expect(workflow).toContain('bootstrap}" != "${expected');
	});
});

describe("release manifest and package path helpers", () => {
	test("builds a richer release manifest with locked toolchain and conformance fields", () => {
		const bytes = Buffer.from("exact-tarball-bytes");
		const manifest = buildReleaseManifest({
			packageName: "pi-codex-adaptor",
			version: "0.1.0-rc.1",
			sourceCommit: sampleManifest.projectSourceCommit,
			toolchain: sampleManifest.toolchain,
			conformance: sampleManifest.conformance,
			tarball: {
				filename: "pi-codex-adaptor-0.1.0-rc.1.tgz",
				size: bytes.byteLength,
				sha256: "a".repeat(64),
				integrity: tarballIntegrity(bytes),
			},
			native: [],
		});
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.npmDistTag).toBe("rc");
		expect(manifest.toolchain.bun).toBe("1.3.14");
		expect(manifest.toolchain.rust).toBe("1.95.0");
		expect(manifest.conformance.sdk.version).toBe("0.144.3");
		expect(manifest.artifactRetentionDays).toBe(30);
		expect(releaseArtifactName(manifest.version, manifest.projectSourceCommit)).toBe(
			`pi-codex-adaptor-${manifest.version}-${manifest.projectSourceCommit}`,
		);
	});

	test("rejects unexpected package paths for exact-tarball verification", () => {
		expect(
			unexpectedPackagePaths(
				["LICENSE", "README.md", "package.json", "src/extension.ts", "secrets.env"],
				PACKAGE_PATH_ALLOWLIST,
			),
		).toEqual(["secrets.env"]);
	});
});

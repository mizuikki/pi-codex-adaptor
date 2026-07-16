import { createHash } from "node:crypto";
import { appendFile, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageMetadata {
	name: string;
	version: string;
}

export interface PublicationSnapshot {
	npmPublished: boolean;
	gitTagExists: boolean;
	githubReleaseExists: boolean;
	gitTagTarget?: string;
	githubReleaseTarget?: string;
}

export type PublicationDecision =
	| { action: "publish"; needsFinalize: true }
	| { action: "finalize-only"; needsFinalize: true }
	| { action: "complete"; needsFinalize: false }
	| {
			action: "impossible";
			needsFinalize: false;
			reason: string;
	  };

export interface ReleaseVerificationInput {
	packageName: string;
	version: string;
	manifestVersion: string;
	sourceCommit: string;
	parentPackageVersion?: string;
	commitSubject: string;
	changelog: string;
	branchName: string;
	eventName: string;
	dispatchVersion?: string;
	dispatchCommit?: string;
	publication: PublicationSnapshot;
	allowUnmerged?: boolean;
	bootstrapVersion?: string;
	allowedBootstrapVersions?: readonly string[];
	taggedVersions?: ReadonlySet<string>;
}

export interface ReleaseVerificationResult {
	release: boolean;
	reason?: string;
	version: string;
	sourceCommit: string;
	alreadyPublished: boolean;
	needsFinalize: boolean;
	prerelease: boolean;
	npmDistTag: "rc" | "latest";
	publicationAction: PublicationDecision["action"];
	gitTagExists: boolean;
	githubReleaseExists: boolean;
}

export interface ReleaseManifestTarball {
	filename: string;
	size: number;
	sha256: string;
	integrity: string;
}

export interface ReleaseManifestLike {
	package: string;
	version: string;
	projectSourceCommit: string;
	tarball: ReleaseManifestTarball;
}

export interface RegistryPackageVersion {
	version: string;
	integrity?: string;
	shasum?: string;
	tarball?: string;
}

export const DEFAULT_ALLOWED_BOOTSTRAP_VERSIONS = ["0.1.0-rc.0", "0.1.0"] as const;
export const RELEASE_ARTIFACT_RETENTION_DAYS = 30;

export function isPrereleaseVersion(version: string): boolean {
	return version.split("+", 1)[0]?.includes("-") ?? false;
}

export function npmDistTagForVersion(version: string): "rc" | "latest" {
	return isPrereleaseVersion(version) ? "rc" : "latest";
}

export function validVersion(version: string): boolean {
	return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
		version,
	);
}

export function classifyPublicationState(
	snapshot: PublicationSnapshot,
	sourceCommit?: string,
): PublicationDecision {
	const { npmPublished, gitTagExists, githubReleaseExists } = snapshot;

	if (!npmPublished && (gitTagExists || githubReleaseExists)) {
		return {
			action: "impossible",
			needsFinalize: false,
			reason:
				"Git tag or GitHub Release exists without a matching npm publication; manual investigation is required",
		};
	}

	if (!npmPublished) {
		return { action: "publish", needsFinalize: true };
	}

	if (
		sourceCommit !== undefined &&
		((gitTagExists && snapshot.gitTagTarget !== sourceCommit) ||
			(githubReleaseExists && snapshot.githubReleaseTarget !== sourceCommit))
	) {
		return {
			action: "impossible",
			needsFinalize: false,
			reason: "Existing release objects do not target the exact release source commit",
		};
	}

	if (gitTagExists && githubReleaseExists) {
		return { action: "complete", needsFinalize: false };
	}

	return { action: "finalize-only", needsFinalize: true };
}

export function validateReleaseAsLifecycle(options: {
	bootstrapVersion: string | undefined;
	packageVersion: string;
	taggedVersions: ReadonlySet<string>;
	allowedBootstrapVersions?: readonly string[];
}): { ok: true } | { ok: false; reason: string } {
	const bootstrapVersion = options.bootstrapVersion?.trim() || undefined;
	if (bootstrapVersion === undefined) return { ok: true };

	const allowed = options.allowedBootstrapVersions ?? DEFAULT_ALLOWED_BOOTSTRAP_VERSIONS;
	if (!(allowed as readonly string[]).includes(bootstrapVersion)) {
		return {
			ok: false,
			reason: `Unsupported release-as bootstrap version: ${bootstrapVersion}`,
		};
	}

	if (options.taggedVersions.has(bootstrapVersion)) {
		return {
			ok: false,
			reason: `release-as override ${bootstrapVersion} must be cleared after that version is tagged`,
		};
	}

	if (
		options.packageVersion === bootstrapVersion &&
		options.taggedVersions.has(options.packageVersion)
	) {
		return {
			ok: false,
			reason: `release-as override ${bootstrapVersion} is stale for package version ${options.packageVersion}`,
		};
	}

	return { ok: true };
}

export function changelogHasVersion(changelog: string, version: string): boolean {
	return new RegExp(`^##\\s+(?:\\[)?${escapeRegExp(version)}(?:\\])?(?:\\s|$)`, "m").test(
		changelog,
	);
}

export function versionMatchesChannel(
	version: string,
	branchName: string,
	eventName: string,
): boolean {
	if (eventName === "workflow_dispatch" || branchName.length === 0) return true;
	return isPrereleaseVersion(version) === branchName.startsWith("release/");
}

export function isReleasePleaseCommit(
	subject: string,
	version: string,
	allowUnmerged = false,
): boolean {
	if (allowUnmerged) return true;
	return new RegExp(`^chore\\([^)]+\\): release pi-codex-adaptor v${escapeRegExp(version)}$`).test(
		subject,
	);
}

export function verifyPublishedIntegrity(options: {
	packageName: string;
	sourceCommit: string;
	registry: RegistryPackageVersion;
	manifest: ReleaseManifestLike;
}): void {
	const { packageName, sourceCommit, registry, manifest } = options;
	if (manifest.package !== packageName) {
		throw new Error(`Release manifest package ${manifest.package} does not match ${packageName}`);
	}
	if (manifest.version !== registry.version) {
		throw new Error(
			`Release manifest version ${manifest.version} does not match registry version ${registry.version}`,
		);
	}
	if (manifest.projectSourceCommit !== sourceCommit) {
		throw new Error(
			`Release manifest source commit ${manifest.projectSourceCommit} does not match ${sourceCommit}`,
		);
	}
	if (registry.integrity === undefined) {
		throw new Error("Registry package integrity is unavailable");
	}
	if (registry.integrity !== manifest.tarball.integrity) {
		throw new Error("Registry package integrity does not match the saved release manifest");
	}
}

export async function verifyLocalReleaseTarball(
	manifestPath: string,
	manifest: ReleaseManifestLike,
): Promise<string> {
	const filename = manifest.tarball?.filename;
	if (
		typeof filename !== "string" ||
		filename.length === 0 ||
		filename === "." ||
		filename === ".." ||
		isAbsolute(filename) ||
		basename(filename) !== filename ||
		filename.includes("/") ||
		filename.includes("\\") ||
		filename !== `pi-codex-adaptor-${manifest.version}.tgz`
	) {
		throw new Error("Release manifest tarball filename must be a contained basename");
	}

	const bundleDirectory = await realpath(dirname(resolve(manifestPath)));
	const tarballPath = await realpath(resolve(bundleDirectory, filename));
	const containedPath = relative(bundleDirectory, tarballPath);
	if (containedPath.startsWith("..") || isAbsolute(containedPath)) {
		throw new Error("Release manifest tarball resolves outside the recovery bundle");
	}

	const bytes = await readFile(tarballPath);
	if (manifest.tarball.size !== bytes.byteLength) {
		throw new Error("Saved release tarball size does not match the release manifest");
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (manifest.tarball.sha256 !== sha256) {
		throw new Error("Saved release tarball SHA-256 does not match the release manifest");
	}
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (manifest.tarball.integrity !== integrity) {
		throw new Error("Saved release tarball integrity does not match the release manifest");
	}
	return tarballPath;
}

export function verifyReleaseDecision(input: ReleaseVerificationInput): ReleaseVerificationResult {
	if (input.packageName !== "pi-codex-adaptor") {
		throw new Error("Unexpected package name");
	}
	if (input.manifestVersion !== input.version) {
		throw new Error("package.json and .release-please-manifest.json versions do not match");
	}
	if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
		throw new Error("Unable to resolve source commit");
	}

	if (input.version === "0.0.0") {
		return {
			release: false,
			reason: "skeleton-version",
			version: input.version,
			sourceCommit: input.sourceCommit,
			alreadyPublished: false,
			needsFinalize: false,
			prerelease: false,
			npmDistTag: "latest",
			publicationAction: "complete",
			gitTagExists: false,
			githubReleaseExists: false,
		};
	}

	if (!validVersion(input.version)) {
		throw new Error(`Invalid package version: ${input.version}`);
	}
	if (input.parentPackageVersion === undefined) {
		throw new Error("Release verification requires a parent package.json version");
	}
	if (input.parentPackageVersion === input.version) {
		throw new Error("Release commit did not change package version");
	}
	if (!isReleasePleaseCommit(input.commitSubject, input.version, input.allowUnmerged)) {
		throw new Error("Release push is not a Release Please commit");
	}
	if (!changelogHasVersion(input.changelog, input.version)) {
		throw new Error(`CHANGELOG.md has no entry for ${input.version}`);
	}
	if (!versionMatchesChannel(input.version, input.branchName, input.eventName)) {
		throw new Error(`Version ${input.version} does not match release channel ${input.branchName}`);
	}
	if (input.dispatchVersion !== undefined && input.dispatchVersion !== input.version) {
		throw new Error("workflow_dispatch version does not match package.json");
	}
	if (input.dispatchCommit !== undefined && input.dispatchCommit !== input.sourceCommit) {
		throw new Error("workflow_dispatch source commit does not match the checked out commit");
	}

	const lifecycle = validateReleaseAsLifecycle({
		bootstrapVersion: input.bootstrapVersion,
		packageVersion: input.version,
		taggedVersions: input.taggedVersions ?? new Set<string>(),
		...(input.allowedBootstrapVersions === undefined
			? {}
			: { allowedBootstrapVersions: input.allowedBootstrapVersions }),
	});
	if (!lifecycle.ok) throw new Error(lifecycle.reason);

	const publication = classifyPublicationState(input.publication, input.sourceCommit);
	if (publication.action === "impossible") {
		throw new Error(publication.reason);
	}

	const alreadyPublished = input.publication.npmPublished;
	const needsFinalize = publication.needsFinalize;
	const release = publication.action !== "complete";

	return {
		release,
		version: input.version,
		sourceCommit: input.sourceCommit,
		alreadyPublished,
		needsFinalize,
		prerelease: isPrereleaseVersion(input.version),
		npmDistTag: npmDistTagForVersion(input.version),
		publicationAction: publication.action,
		gitTagExists: input.publication.gitTagExists,
		githubReleaseExists: input.publication.githubReleaseExists,
		...(publication.action === "complete" ? { reason: "already-complete" } : {}),
	};
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function releaseArtifactName(version: string, sourceCommit: string): string {
	return `pi-codex-adaptor-${version}-${sourceCommit}`;
}

async function main(): Promise<void> {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const packageJson = JSON.parse(
		await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
	) as PackageMetadata;
	const releaseManifest = JSON.parse(
		await readFile(resolve(repositoryRoot, ".release-please-manifest.json"), "utf8"),
	) as Record<string, unknown>;
	const changelog = await readFile(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
	const sourceCommit = (await run(["git", "rev-parse", "HEAD"])).trim();

	const integrityOnly = process.argv.includes("--verify-published-integrity");
	if (integrityOnly) {
		const manifestPath = argument("--manifest");
		if (manifestPath === undefined) {
			throw new Error("--manifest is required with --verify-published-integrity");
		}
		const manifest = JSON.parse(
			await readFile(resolve(manifestPath), "utf8"),
		) as ReleaseManifestLike;
		await verifyLocalReleaseTarball(manifestPath, manifest);
		const registry = await readRegistryPackage(packageJson.name, packageJson.version);
		if (registry === undefined) {
			throw new Error(`npm package ${packageJson.name}@${packageJson.version} is not published`);
		}
		verifyPublishedIntegrity({
			packageName: packageJson.name,
			sourceCommit,
			registry,
			manifest,
		});
		console.log(
			JSON.stringify(
				{
					verified: true,
					version: packageJson.version,
					sourceCommit,
					integrity: registry.integrity,
				},
				null,
				2,
			),
		);
		return;
	}

	if (packageJson.version === "0.0.0") {
		await writeOutput({
			release: false,
			reason: "skeleton-version",
			version: packageJson.version,
			sourceCommit,
			alreadyPublished: false,
			needsFinalize: false,
			prerelease: false,
			npmDistTag: "latest",
			publicationAction: "complete",
			gitTagExists: false,
			githubReleaseExists: false,
		});
		return;
	}

	const commitSubject = (await run(["git", "log", "-1", "--format=%s"])).trim();
	const parent = await runAllowFailure(["git", "rev-parse", "HEAD^"]);
	if (parent === undefined) throw new Error("Release verification requires a parent commit");
	const previous = await runAllowFailure(["git", "show", `${parent}:package.json`]);
	if (previous === undefined) throw new Error("Release parent does not contain package.json");
	const previousPackage = JSON.parse(previous) as { version?: unknown };
	const parentPackageVersion =
		typeof previousPackage.version === "string" ? previousPackage.version : undefined;

	const registry = await readRegistryPackage(packageJson.name, packageJson.version);
	const gitTagTarget = await gitTagTargetRemotely(packageJson.version, sourceCommit);
	const githubReleaseTarget = await githubReleaseTargetFor(
		packageJson.version,
		sourceCommit,
		gitTagTarget,
	);
	const result = verifyReleaseDecision({
		packageName: packageJson.name,
		version: packageJson.version,
		manifestVersion: typeof releaseManifest["."] === "string" ? releaseManifest["."] : "invalid",
		sourceCommit,
		...(parentPackageVersion === undefined ? {} : { parentPackageVersion }),
		commitSubject,
		changelog,
		branchName: process.env.GITHUB_REF_NAME ?? "",
		eventName: process.env.GITHUB_EVENT_NAME ?? "",
		...(process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.INPUT_VERSION
			? { dispatchVersion: process.env.INPUT_VERSION }
			: {}),
		...(process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.INPUT_SOURCE_COMMIT
			? { dispatchCommit: process.env.INPUT_SOURCE_COMMIT }
			: {}),
		publication: {
			npmPublished: registry !== undefined,
			gitTagExists: gitTagTarget !== undefined,
			githubReleaseExists: githubReleaseTarget !== undefined,
			...(gitTagTarget === undefined ? {} : { gitTagTarget }),
			...(githubReleaseTarget === undefined ? {} : { githubReleaseTarget }),
		},
		allowUnmerged: process.env.RELEASE_VERIFY_ALLOW_UNMERGED === "true",
		...(process.env.RELEASE_BOOTSTRAP_VERSION
			? { bootstrapVersion: process.env.RELEASE_BOOTSTRAP_VERSION }
			: {}),
	});

	if (result.publicationAction === "complete") {
		const manifestPath = argument("--manifest");
		if (manifestPath === undefined || registry === undefined) {
			throw new Error("A saved release manifest is required to verify a complete publication");
		}
		const manifest = JSON.parse(
			await readFile(resolve(manifestPath), "utf8"),
		) as ReleaseManifestLike;
		await verifyLocalReleaseTarball(manifestPath, manifest);
		verifyPublishedIntegrity({
			packageName: packageJson.name,
			sourceCommit,
			registry,
			manifest,
		});
		await writeOutput({
			release: false,
			reason: "already-complete",
			version: result.version,
			sourceCommit: result.sourceCommit,
			alreadyPublished: true,
			needsFinalize: false,
			prerelease: result.prerelease,
			npmDistTag: result.npmDistTag,
			publicationAction: "complete",
			gitTagExists: result.gitTagExists,
			githubReleaseExists: result.githubReleaseExists,
		});
		return;
	}

	await writeOutput({
		release: true,
		version: result.version,
		sourceCommit: result.sourceCommit,
		alreadyPublished: result.alreadyPublished,
		needsFinalize: result.needsFinalize,
		prerelease: result.prerelease,
		npmDistTag: result.npmDistTag,
		publicationAction: result.publicationAction,
		gitTagExists: result.gitTagExists,
		githubReleaseExists: result.githubReleaseExists,
	});
}

async function readRegistryPackage(
	name: string,
	version: string,
): Promise<RegistryPackageVersion | undefined> {
	const output = await runAllowFailure([
		"npm",
		"view",
		`${name}@${version}`,
		"version",
		"dist.integrity",
		"dist.shasum",
		"dist.tarball",
		"--json",
	]);
	if (output === undefined) return undefined;
	try {
		const parsed = JSON.parse(output.trim()) as
			| string
			| {
					version?: string;
					"dist.integrity"?: string;
					"dist.shasum"?: string;
					"dist.tarball"?: string;
					dist?: { integrity?: string; shasum?: string; tarball?: string };
			  };
		if (typeof parsed === "string") {
			return parsed === version ? { version } : undefined;
		}
		const resolvedVersion = parsed.version ?? version;
		if (resolvedVersion !== version) return undefined;
		const integrity = parsed.dist?.integrity ?? parsed["dist.integrity"];
		const shasum = parsed.dist?.shasum ?? parsed["dist.shasum"];
		const tarball = parsed.dist?.tarball ?? parsed["dist.tarball"];
		return {
			version: resolvedVersion,
			...(integrity === undefined ? {} : { integrity }),
			...(shasum === undefined ? {} : { shasum }),
			...(tarball === undefined ? {} : { tarball }),
		};
	} catch {
		throw new Error("npm registry returned an invalid version response");
	}
}

async function gitTagTargetRemotely(
	version: string,
	sourceCommit: string,
): Promise<string | undefined> {
	if (process.env.RELEASE_GIT_TAG_EXISTS !== undefined) {
		return process.env.RELEASE_GIT_TAG_EXISTS === "true" ? sourceCommit : undefined;
	}
	const remote = process.env.RELEASE_GIT_REMOTE ?? "origin";
	try {
		const output = await runAllowFailure([
			"git",
			"ls-remote",
			"--exit-code",
			"--tags",
			remote,
			`refs/tags/v${version}`,
			`refs/tags/v${version}^{}`,
		]);
		if (output === undefined) return undefined;
		const targets = output
			.trim()
			.split("\n")
			.map((line) => {
				const [target, reference] = line.split(/\s+/, 2);
				return { target, reference };
			})
			.filter(
				(value): value is { target: string; reference: string } =>
					value.target !== undefined &&
					value.reference !== undefined &&
					/^[0-9a-f]{40}$/.test(value.target),
			);
		return targets.find((value) => value.reference.endsWith("^{}"))?.target ?? targets[0]?.target;
	} catch (error) {
		if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") throw error;
		const local = await runAllowFailure([
			"git",
			"show-ref",
			"--tags",
			"--verify",
			`refs/tags/v${version}`,
		]);
		return local === undefined ? undefined : sourceCommit;
	}
}

async function githubReleaseTargetFor(
	version: string,
	sourceCommit: string,
	gitTagTarget: string | undefined,
): Promise<string | undefined> {
	if (process.env.RELEASE_GITHUB_RELEASE_EXISTS !== undefined) {
		return process.env.RELEASE_GITHUB_RELEASE_EXISTS === "true" ? sourceCommit : undefined;
	}
	if (process.env.GITHUB_REPOSITORY === undefined || process.env.GH_TOKEN === undefined) {
		return gitTagTarget;
	}
	const output = await runAllowFailure([
		"gh",
		"release",
		"view",
		`v${version}`,
		"--json",
		"tagName,targetCommitish",
	]);
	if (output === undefined) return undefined;
	const parsed = JSON.parse(output) as { tagName?: unknown; targetCommitish?: unknown };
	if (parsed.tagName !== `v${version}` || typeof parsed.targetCommitish !== "string") {
		throw new Error("GitHub Release returned an invalid release target");
	}
	if (gitTagTarget !== undefined) return gitTagTarget;
	return parsed.targetCommitish === `v${version}`
		? (gitTagTarget ?? parsed.targetCommitish)
		: parsed.targetCommitish;
}

async function writeOutput(value: Record<string, string | boolean>): Promise<void> {
	if (process.argv.includes("--github-output")) {
		const path = process.env.GITHUB_OUTPUT;
		if (path === undefined) throw new Error("GITHUB_OUTPUT is required with --github-output");
		await appendFile(
			path,
			Object.entries(value)
				.map(([key, item]) => `${key}=${typeof item === "boolean" ? String(item) : item}\n`)
				.join(""),
		);
		return;
	}
	console.log(JSON.stringify(value, null, 2));
}

async function run(command: string[]): Promise<string> {
	const output = await runAllowFailure(command);
	if (output === undefined) throw new Error(`${command[0]} failed`);
	return output;
}

async function runAllowFailure(command: string[]): Promise<string | undefined> {
	const child = Bun.spawn(command, {
		cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		if (commandFailureMeansMissing(command, exitCode, `${stderr}\n${stdout}`)) {
			return undefined;
		}
		throw new Error(`${command[0] ?? "command"} failed with exit status ${exitCode}`);
	}
	return stdout;
}

export function commandFailureMeansMissing(
	command: readonly string[],
	exitCode: number,
	output: string,
): boolean {
	if (command[0] === "git" && command[1] === "ls-remote" && command.includes("--exit-code")) {
		return exitCode === 2;
	}
	return (
		(command[0] === "npm" || command[0] === "gh") &&
		/E404|not found|404|exit code 2|does not exist/i.test(output)
	);
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

if (import.meta.main) {
	await main();
}

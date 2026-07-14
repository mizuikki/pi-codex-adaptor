import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as {
	version: string;
};
const releaseManifest = JSON.parse(
	await readFile(resolve(repositoryRoot, ".release-please-manifest.json"), "utf8"),
) as Record<string, string>;

if (releaseManifest["."] !== packageJson.version) {
	throw new Error("package.json and .release-please-manifest.json versions do not match");
}

if (packageJson.version !== "0.0.0") {
	throw new Error(
		"Release verification beyond the skeleton version requires the Stage 5 registry, tag, changelog, and branch checks",
	);
}

const output = {
	reason: "skeleton-version",
	release: false,
	version: packageJson.version,
};

if (process.argv.includes("--github-output")) {
	const githubOutput = process.env.GITHUB_OUTPUT;
	if (githubOutput === undefined) {
		throw new Error("GITHUB_OUTPUT is required with --github-output");
	}
	await appendFile(githubOutput, "release=false\nreason=skeleton-version\n");
} else {
	console.log(JSON.stringify(output));
}

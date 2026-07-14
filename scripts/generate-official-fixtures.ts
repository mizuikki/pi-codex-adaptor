import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.argv.includes("--check")) {
	throw new Error(
		"Fixture generation is intentionally disabled until the Stage 0 schema and tool allowlists are recorded",
	);
}

const fixtureDirectories = [
	"fixtures/app-server-schema",
	"fixtures/bridge-protocol",
	"fixtures/official-conformance",
	"fixtures/responses",
];

await Promise.all(fixtureDirectories.map((directory) => stat(resolve(repositoryRoot, directory))));
console.log("Official fixture directories are present; fixture generation remains pending.");

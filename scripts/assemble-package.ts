import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = resolve(repositoryRoot, "dist/package");

async function copyIfPresent(source: string, destination: string): Promise<void> {
	try {
		await stat(source);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}

	await cp(source, destination, { recursive: true });
}

await rm(stagingDirectory, { force: true, recursive: true });
await mkdir(stagingDirectory, { recursive: true });

await Promise.all([
	cp(resolve(repositoryRoot, "LICENSE"), resolve(stagingDirectory, "LICENSE")),
	cp(resolve(repositoryRoot, "README.md"), resolve(stagingDirectory, "README.md")),
	cp(resolve(repositoryRoot, "src"), resolve(stagingDirectory, "src"), { recursive: true }),
	copyIfPresent(resolve(repositoryRoot, "native/bin"), resolve(stagingDirectory, "native/bin")),
]);

const packageJson = JSON.parse(
	await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
) as Record<string, unknown>;

delete packageJson.devDependencies;
delete packageJson.files;
delete packageJson.scripts;

await writeFile(
	resolve(stagingDirectory, "package.json"),
	`${JSON.stringify(packageJson, null, 2)}\n`,
);

console.log(stagingDirectory);

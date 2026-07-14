import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackFile {
	path: string;
	size: number;
}

interface PackResult {
	files: PackFile[];
	size: number;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function run(command: string[]): Promise<string> {
	const child = Bun.spawn(command, {
		cwd: repositoryRoot,
		stderr: "inherit",
		stdout: "pipe",
	});
	const output = await new Response(child.stdout).text();
	const exitCode = await child.exited;

	if (exitCode !== 0) {
		throw new Error(`${command[0]} exited with status ${exitCode}`);
	}

	return output;
}

await run(["bun", "scripts/assemble-package.ts"]);
const packOutput = await run(["npm", "pack", "./dist/package", "--dry-run", "--json"]);
const parsedResult = JSON.parse(packOutput) as PackResult[] | Record<string, PackResult>;
const result = Array.isArray(parsedResult) ? parsedResult[0] : Object.values(parsedResult)[0];

if (result === undefined) {
	throw new Error("npm pack returned no package result");
}

const allowedPaths = [
	/^LICENSE$/,
	/^README\.md$/,
	/^package\.json$/,
	/^src\/.+\.(?:md|ts)$/,
	/^native\/bin\/[a-zA-Z0-9._/-]+$/,
];

const unexpected = result.files
	.map((file) => file.path)
	.filter((path) => !allowedPaths.some((pattern) => pattern.test(path)));

if (unexpected.length > 0) {
	throw new Error(`Unexpected npm package files: ${unexpected.join(", ")}`);
}

for (const requiredFile of ["LICENSE", "README.md", "package.json", "src/extension.ts"]) {
	if (!result.files.some((file) => file.path === requiredFile)) {
		throw new Error(`Required npm package file is missing: ${requiredFile}`);
	}
}

const maximumSkeletonSize = 5 * 1024 * 1024;
if (result.size > maximumSkeletonSize) {
	throw new Error(`Skeleton package is too large: ${result.size} bytes`);
}

console.log(`Verified ${result.files.length} npm package files (${result.size} bytes).`);

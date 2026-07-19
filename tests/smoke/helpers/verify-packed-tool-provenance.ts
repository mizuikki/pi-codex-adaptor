import { realpathSync } from "node:fs";
import { discoverAndLoadExtensions, type ToolInfo } from "@earendil-works/pi-coding-agent";

const extensionPath = process.argv[2];
if (extensionPath === undefined) throw new Error("Packed extension path is required");

const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), process.env.HOME);
if (result.errors.length > 0 || result.extensions.length !== 1) {
	throw new Error("Packed extension provenance fixture failed to load");
}

const extension = result.extensions[0];
if (
	extension === undefined ||
	realpathSync(extension.resolvedPath) !== realpathSync(extensionPath)
) {
	throw new Error("Packed extension provenance resolved an unexpected entry");
}

const tools: ToolInfo[] = [...extension.tools.values()].map(({ definition, sourceInfo }) => ({
	name: definition.name,
	description: definition.description,
	parameters: definition.parameters,
	...(definition.promptGuidelines === undefined
		? {}
		: { promptGuidelines: definition.promptGuidelines }),
	sourceInfo,
}));
const managedNames = tools.map((tool) => tool.name);
const profileModulePath = new URL(
	"./integration/pi/codex-tool-profile.ts",
	import.meta.resolve(extensionPath),
);
const { validateManagedToolOwnership } = (await import(profileModulePath.href)) as {
	validateManagedToolOwnership(
		tools: readonly ToolInfo[],
		activeManaged: readonly string[],
		expectedEntryPath: string,
	): { ok: boolean };
};
if (!validateManagedToolOwnership(tools, managedNames, extensionPath).ok) {
	throw new Error("Packed extension managed-tool provenance did not match its entry");
}

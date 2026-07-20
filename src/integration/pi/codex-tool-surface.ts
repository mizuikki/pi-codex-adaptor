import { MANAGED_TOOL_NAMES } from "../../domain/capability.ts";
import { isPiCoreAgentToolName } from "./codex-tool-profile.ts";

export interface PiResponsesToolDefinition {
	name: string;
	description: string;
	parameters: unknown;
}

export function officialToolNames(tools: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const value of tools) {
		const tool = record(value);
		if (typeof tool?.name !== "string") continue;
		names.add(tool.name);
		if (tool.type !== "namespace" || !Array.isArray(tool.tools)) continue;
		for (const nestedValue of tool.tools) {
			const nested = record(nestedValue);
			if (typeof nested?.name === "string") names.add(`${tool.name}.${nested.name}`);
		}
	}
	return names;
}

export function isOfficialToolName(name: string, officialNames: ReadonlySet<string>): boolean {
	return officialNames.has(name);
}

export function isAdditiveToolName(name: string, officialNames: ReadonlySet<string>): boolean {
	return (
		!isPiCoreAgentToolName(name) &&
		!(MANAGED_TOOL_NAMES as readonly string[]).includes(name) &&
		!isOfficialToolName(name, officialNames)
	);
}

export function toResponsesFunctionTool(
	tool: PiResponsesToolDefinition,
): Record<string, unknown> | undefined {
	const parameters = projectToolParameters(tool.parameters);
	if (
		typeof tool.name !== "string" ||
		tool.name.length === 0 ||
		typeof tool.description !== "string" ||
		parameters === undefined
	) {
		return undefined;
	}
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters,
		strict: false,
	};
}

/** Copy the JSON Schema wire surface while ignoring TypeBox symbol metadata. */
function projectToolParameters(value: unknown): Record<string, unknown> | undefined {
	const projected = projectJsonValue(value, new Set<object>());
	return isRecord(projected) ? projected : undefined;
}

function projectJsonValue(value: unknown, ancestors: Set<object>): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object" || ancestors.has(value)) return undefined;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || !("value" in descriptor)) return undefined;
				const projected = projectJsonValue(descriptor.value, ancestors);
				if (projected === undefined) return undefined;
				result.push(projected);
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !("value" in descriptor)) return undefined;
			const projected = projectJsonValue(descriptor.value, ancestors);
			if (projected === undefined) return undefined;
			result[key] = projected;
		}
		return result;
	} catch {
		return undefined;
	} finally {
		ancestors.delete(value);
	}
}

/** Build the model-visible Codex list shared by Responses and compaction. */
export function selectCodexToolSurface(
	officialTools: readonly unknown[],
	activeNames: readonly string[],
	activeDefinitions: readonly PiResponsesToolDefinition[],
): unknown[] {
	const officialNames = officialToolNames(officialTools);
	const active = new Set(activeNames);
	const additions: unknown[] = [];
	const seen = new Set<string>();
	for (const definition of activeDefinitions) {
		if (!active.has(definition.name) || !isAdditiveToolName(definition.name, officialNames))
			continue;
		if (seen.has(definition.name)) continue;
		const converted = toResponsesFunctionTool(definition);
		if (converted === undefined) continue;
		seen.add(definition.name);
		additions.push(converted);
	}
	return [...officialTools, ...additions];
}

export function orderedToolNames(tools: readonly PiResponsesToolDefinition[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		names.push(tool.name);
	}
	return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

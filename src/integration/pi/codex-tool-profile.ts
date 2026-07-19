import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import { MANAGED_TOOL_NAMES, type ManagedToolName } from "../../domain/capability.ts";

/** Pi's built-in coding slots are one reversible host profile. */
export const PI_CORE_AGENT_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

export type PiCoreAgentToolName = (typeof PI_CORE_AGENT_TOOL_NAMES)[number];

export type CodexToolProfileReadiness =
	| { kind: "inactive" }
	| { kind: "pending"; capabilityKey: string | undefined }
	| { kind: "healthy"; capabilityKey: string }
	| { kind: "unavailable"; capabilityKey: string | undefined };

export interface CodexToolProfileCoordinator {
	readonly readiness: CodexToolProfileReadiness;
	readonly skillLoader: "exec_command" | "shell_command" | undefined;
	enterPending(capabilityKey?: string): void;
	installHealthy(
		capabilityKey: string,
		activeManaged: readonly ManagedToolName[],
		skillLoader: "exec_command" | "shell_command" | undefined,
		notify?: (message: string) => void,
	): boolean;
	installUnavailable(
		capabilityKey?: string,
		conflictingTool?: string,
		notify?: (message: string) => void,
	): void;
	revalidateHealthyOwnership(notify?: (message: string) => void): boolean;
	isHealthy(capabilityKey: string): boolean;
	restorePi(): void;
	dispose(): void;
}

export function isPiCoreAgentToolName(name: string): name is PiCoreAgentToolName {
	return (PI_CORE_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

export function isManagedToolName(name: string): name is ManagedToolName {
	return (MANAGED_TOOL_NAMES as readonly string[]).includes(name);
}

export function orderedUnique(names: readonly string[]): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}

/** Apply an activated Codex profile without changing the order of retained additive tools. */
export function reconcileCodexActiveToolNames(
	currentNames: readonly string[],
	availableNames: ReadonlySet<string>,
	activeManaged: readonly string[],
): string[] {
	const result = orderedUnique(
		currentNames.filter(
			(name) =>
				availableNames.has(name) && !isPiCoreAgentToolName(name) && !isManagedToolName(name),
		),
	);
	for (const name of orderedUnique(activeManaged)) {
		if (!availableNames.has(name) || !isManagedToolName(name) || result.includes(name)) continue;
		result.push(name);
	}
	return result;
}

/** Restore the captured Pi core subset while reflecting current additive activation changes. */
export function restorePiActiveToolNames(
	currentNames: readonly string[],
	availableNames: ReadonlySet<string>,
	baselineOrder: readonly string[] | undefined,
	capturedPiCore: readonly string[] = [],
): string[] {
	const current = orderedUnique(currentNames);
	const available = (name: string): boolean => availableNames.has(name);
	if (baselineOrder === undefined) {
		return current.filter((name) => available(name) && !isManagedToolName(name));
	}

	const captured = new Set(capturedPiCore.filter(isPiCoreAgentToolName));
	const currentAdditives = current.filter(
		(name) => available(name) && !isPiCoreAgentToolName(name) && !isManagedToolName(name),
	);
	const currentAdditiveSet = new Set(currentAdditives);
	const restored: string[] = [];
	const append = (name: string): void => {
		if (!available(name) || restored.includes(name)) return;
		restored.push(name);
	};

	for (const name of orderedUnique(baselineOrder)) {
		if (isManagedToolName(name)) continue;
		if (isPiCoreAgentToolName(name)) {
			if (captured.has(name)) append(name);
			continue;
		}
		if (currentAdditiveSet.has(name)) append(name);
	}
	for (const name of currentAdditives) append(name);
	return restored;
}

export interface ManagedToolOwnership {
	ok: boolean;
	conflictingTool?: string;
}

export function normalizedEntryPath(path: string): string {
	const resolved = normalize(resolve(path));
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export function validateManagedToolOwnership(
	tools: readonly ToolInfo[] | undefined,
	activeManaged: readonly string[],
	expectedEntryPath: string | undefined,
): ManagedToolOwnership {
	if (tools === undefined) return { ok: false };
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	for (const name of orderedUnique(activeManaged)) {
		if (!isManagedToolName(name)) return { ok: false, conflictingTool: name };
		const tool = byName.get(name);
		if (tool === undefined) return { ok: false, conflictingTool: name };
		if (
			expectedEntryPath !== undefined &&
			(typeof tool.sourceInfo?.path !== "string" ||
				normalizedEntryPath(tool.sourceInfo.path) !== normalizedEntryPath(expectedEntryPath))
		) {
			return { ok: false, conflictingTool: name };
		}
	}
	return { ok: true };
}

export function createCodexToolProfile(
	pi: ExtensionAPI,
	expectedEntryPath?: string,
): CodexToolProfileCoordinator {
	return new CodexToolProfile(pi, expectedEntryPath);
}

/** Readiness used when the host cannot provide the registry API required for safe ownership proof. */
export function createUnavailableCodexToolProfile(): CodexToolProfileCoordinator {
	return new UnavailableCodexToolProfile();
}

class CodexToolProfile implements CodexToolProfileCoordinator {
	readonly #pi: ExtensionAPI;
	readonly #expectedEntryPath: string | undefined;
	#state: ProfileState = { kind: "pi" };
	#readiness: CodexToolProfileReadiness = { kind: "inactive" };
	#profileGeneration = 0;
	#conflictNotificationGeneration = -1;

	constructor(pi: ExtensionAPI, expectedEntryPath: string | undefined) {
		this.#pi = pi;
		this.#expectedEntryPath =
			expectedEntryPath === undefined ? undefined : normalizedEntryPath(expectedEntryPath);
	}

	get readiness(): CodexToolProfileReadiness {
		return this.#readiness;
	}

	get skillLoader(): "exec_command" | "shell_command" | undefined {
		return this.#state.kind === "codex" ? this.#state.skillLoader : undefined;
	}

	enterPending(capabilityKey?: string): void {
		this.#ensureCodexState();
		this.#profileGeneration += 1;
		this.#conflictNotificationGeneration = -1;
		const state = this.#state;
		if (state.kind !== "codex") return;
		const tools = this.#readTools();
		const availableNames =
			tools === undefined ? this.#fallbackAvailableNames(state) : toolNames(tools);
		this.#applyActiveNames(
			reconcileCodexActiveToolNames(this.#pi.getActiveTools(), availableNames, []),
		);
		this.#state = { ...state, phase: "pending", activeManaged: [], skillLoader: undefined };
		this.#readiness = { kind: "pending", capabilityKey };
	}

	installHealthy(
		capabilityKey: string,
		activeManaged: readonly ManagedToolName[],
		skillLoader: "exec_command" | "shell_command" | undefined,
		notify?: (message: string) => void,
	): boolean {
		this.#ensureCodexState();
		const state = this.#state;
		if (state.kind !== "codex") return false;
		const tools = this.#readTools();
		const ownership = validateManagedToolOwnership(tools, activeManaged, this.#expectedEntryPath);
		if (!ownership.ok) {
			this.installUnavailable(capabilityKey, ownership.conflictingTool, notify);
			return false;
		}
		const availableNames =
			tools === undefined ? this.#fallbackAvailableNames(state) : toolNames(tools);
		this.#applyActiveNames(
			reconcileCodexActiveToolNames(this.#pi.getActiveTools(), availableNames, activeManaged),
		);
		this.#state = {
			...state,
			phase: "healthy",
			activeManaged: orderedManaged(activeManaged),
			skillLoader,
		};
		this.#readiness = { kind: "healthy", capabilityKey };
		return true;
	}

	installUnavailable(
		capabilityKey?: string,
		conflictingTool?: string,
		notify?: (message: string) => void,
	): void {
		this.#ensureCodexState();
		const state = this.#state;
		if (state.kind !== "codex") return;
		const tools = this.#readTools();
		const availableNames =
			tools === undefined ? this.#fallbackAvailableNames(state) : toolNames(tools);
		this.#applyActiveNames(
			reconcileCodexActiveToolNames(this.#pi.getActiveTools(), availableNames, []),
		);
		this.#state = { ...state, phase: "unavailable", activeManaged: [], skillLoader: undefined };
		this.#readiness = { kind: "unavailable", capabilityKey };
		if (
			conflictingTool !== undefined &&
			notify !== undefined &&
			this.#conflictNotificationGeneration !== this.#profileGeneration
		) {
			this.#conflictNotificationGeneration = this.#profileGeneration;
			notify(`Codex unavailable: managed tool ownership conflict for ${conflictingTool}`);
		}
	}

	revalidateHealthyOwnership(notify?: (message: string) => void): boolean {
		if (this.#state.kind !== "codex" || this.#state.phase !== "healthy") return false;
		const state = this.#state;
		const tools = this.#readTools();
		const ownership = validateManagedToolOwnership(
			tools,
			state.activeManaged,
			this.#expectedEntryPath,
		);
		if (!ownership.ok) {
			this.installUnavailable(
				this.#readiness.kind === "healthy" ? this.#readiness.capabilityKey : undefined,
				ownership.conflictingTool,
				notify,
			);
			return false;
		}
		const availableNames =
			tools === undefined ? this.#fallbackAvailableNames(state) : toolNames(tools);
		this.#applyActiveNames(
			reconcileCodexActiveToolNames(this.#pi.getActiveTools(), availableNames, state.activeManaged),
		);
		return true;
	}

	isHealthy(capabilityKey: string): boolean {
		return this.#readiness.kind === "healthy" && this.#readiness.capabilityKey === capabilityKey;
	}

	restorePi(): void {
		const current = this.#pi.getActiveTools();
		const tools = this.#readTools();
		const state = this.#state;
		const availableNames =
			tools === undefined
				? state.kind === "codex"
					? this.#fallbackAvailableNames(state)
					: new Set(current)
				: toolNames(tools);
		const restored =
			state.kind === "codex"
				? restorePiActiveToolNames(
						current,
						availableNames,
						state.baselineOrder,
						state.suppressedPiCore,
					)
				: restorePiActiveToolNames(current, availableNames, undefined);
		this.#applyActiveNames(restored);
		this.#state = { kind: "pi" };
		this.#readiness = { kind: "inactive" };
	}

	dispose(): void {
		this.restorePi();
	}

	#ensureCodexState(): void {
		if (this.#state.kind === "codex") return;
		const current = orderedUnique(this.#pi.getActiveTools());
		const tools = this.#readTools();
		const availableNames = tools === undefined ? new Set(current) : toolNames(tools);
		this.#state = {
			kind: "codex",
			phase: "pending",
			baselineOrder: current,
			suppressedPiCore: current.filter(
				(name): name is PiCoreAgentToolName =>
					isPiCoreAgentToolName(name) && availableNames.has(name),
			),
			activeManaged: [],
			skillLoader: undefined,
		};
	}

	#readTools(): ToolInfo[] | undefined {
		try {
			return this.#pi.getAllTools();
		} catch {
			return undefined;
		}
	}

	#fallbackAvailableNames(state: CodexProfileState): Set<string> {
		return new Set([
			...this.#pi.getActiveTools(),
			...state.baselineOrder,
			...state.suppressedPiCore,
			...state.activeManaged,
		]);
	}

	#applyActiveNames(next: readonly string[]): void {
		const current = orderedUnique(this.#pi.getActiveTools());
		const ordered = orderedUnique(next);
		if (sameNames(current, ordered)) return;
		this.#pi.setActiveTools(ordered);
	}
}

class UnavailableCodexToolProfile implements CodexToolProfileCoordinator {
	readonly readiness: CodexToolProfileReadiness = { kind: "inactive" };
	readonly skillLoader = undefined;

	enterPending(): void {}
	installHealthy(): boolean {
		return false;
	}
	installUnavailable(): void {}
	revalidateHealthyOwnership(): boolean {
		return false;
	}
	isHealthy(): boolean {
		return false;
	}
	restorePi(): void {}
	dispose(): void {}
}

type ProfileState = { kind: "pi" } | CodexProfileState;

interface CodexProfileState {
	kind: "codex";
	phase: "pending" | "healthy" | "unavailable";
	baselineOrder: readonly string[];
	suppressedPiCore: readonly PiCoreAgentToolName[];
	activeManaged: readonly ManagedToolName[];
	skillLoader: "exec_command" | "shell_command" | undefined;
}

function toolNames(tools: readonly ToolInfo[]): Set<string> {
	return new Set(tools.map((tool) => tool.name));
}

function orderedManaged(names: readonly ManagedToolName[]): ManagedToolName[] {
	return orderedUnique(names).filter(isManagedToolName) as ManagedToolName[];
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

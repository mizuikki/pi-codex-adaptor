import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveNativeTarget } from "../../../src/infrastructure/codex-bridge/binary.ts";
import {
	BridgeClient,
	spawnBridgeTransport,
} from "../../../src/infrastructure/codex-bridge/client.ts";
import { BundledCodexRuntime } from "../../../src/infrastructure/codex-bridge/runtime.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");

export async function resolveIntegrationBridgeExecutable(): Promise<{
	executable: string;
	buildTarget: string;
	repositoryRoot: string;
}> {
	const buildTarget = resolveNativeTarget();
	const executableName = process.platform === "win32" ? "codex-bridge.exe" : "codex-bridge";
	const candidates = [
		resolve(repositoryRoot, "native", "target", buildTarget, "debug", executableName),
		resolve(repositoryRoot, "native", "target", "debug", executableName),
		resolve(repositoryRoot, "native", "bin", buildTarget, executableName),
	];
	for (const executable of candidates) {
		try {
			await access(executable);
			return { executable, buildTarget, repositoryRoot };
		} catch {
			// try next candidate
		}
	}
	throw new Error(
		"codex-bridge binary is unavailable; run bun run build:native or bun run check:native first",
	);
}

export async function connectIntegrationBridge(options?: {
	token?: string;
	accountId?: string;
	apiKey?: string;
	authentication?:
		| { kind: "oauth_bearer"; token: string; accountId: string }
		| { kind: "openai_api_key"; apiKey: string };
}): Promise<{
	client: BridgeClient;
	executable: string;
	buildTarget: string;
	repositoryRoot: string;
}> {
	const {
		executable,
		buildTarget,
		repositoryRoot: root,
	} = await resolveIntegrationBridgeExecutable();
	const authentication =
		options?.authentication !== undefined
			? options.authentication
			: options?.apiKey !== undefined
				? {
						kind: "openai_api_key" as const,
						apiKey: options.apiKey,
					}
				: options?.token === undefined
					? undefined
					: {
							kind: "oauth_bearer" as const,
							token: options.token,
							accountId: options.accountId ?? "account-fixture",
						};
	const client = await BridgeClient.connect({
		buildTarget,
		clientVersion: "integration-test",
		allowDevelopmentBuild: true,
		transport: spawnBridgeTransport(executable),
		...(authentication === undefined ? {} : { authentication }),
	});
	return { client, executable, buildTarget, repositoryRoot: root };
}

export async function createIntegrationRuntime(options?: {
	testBaseUrl?: string;
	token?: string;
}): Promise<{
	runtime: BundledCodexRuntime;
	executable: string;
	buildTarget: string;
	repositoryRoot: string;
}> {
	const {
		executable,
		buildTarget,
		repositoryRoot: root,
	} = await resolveIntegrationBridgeExecutable();
	const runtime = new BundledCodexRuntime({
		packageRoot: root,
		clientVersion: "0.0.0",
		allowDevelopmentBuild: true,
		executable,
		buildTarget,
		...(options?.testBaseUrl === undefined ? {} : { testBaseUrl: options.testBaseUrl }),
	});
	return { runtime, executable, buildTarget, repositoryRoot: root };
}

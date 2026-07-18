import type { CodexConfig } from "./config.ts";

export const CODEX_PI_APIS = ["openai-responses", "openai-codex-responses"] as const;
export type CodexPiApi = (typeof CODEX_PI_APIS)[number];

export type ProviderActivationReason = "no_model" | "provider_not_selected" | "unsupported_pi_api";

export type ProviderActivationDecision =
	| { active: true }
	| { active: false; reason: ProviderActivationReason };

export interface ProviderActivationModel {
	provider: string;
	api: string;
}

export function resolveProviderActivation(
	model: ProviderActivationModel | undefined,
	config: Pick<CodexConfig, "activation">,
): ProviderActivationDecision {
	if (model === undefined) return { active: false, reason: "no_model" };
	if (!config.activation.providers.includes(model.provider)) {
		return { active: false, reason: "provider_not_selected" };
	}
	if (!isCodexPiApi(model.api)) return { active: false, reason: "unsupported_pi_api" };
	return { active: true };
}

export function isCodexPiApi(api: string): api is CodexPiApi {
	return (CODEX_PI_APIS as readonly string[]).includes(api);
}

export function isProviderSelected(
	provider: string,
	config: Pick<CodexConfig, "activation">,
): boolean {
	return config.activation.providers.includes(provider);
}

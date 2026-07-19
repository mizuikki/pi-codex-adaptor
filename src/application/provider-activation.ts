import { type CodexConfig, createDefaultConfig } from "../domain/config.ts";
import {
	type ProviderActivationDecision,
	type ProviderActivationModel,
	resolveProviderActivation,
} from "../domain/provider-activation.ts";
import type { ConfigurationService } from "./configuration.ts";

export class ProviderActivationPolicy {
	readonly #configuration: Pick<ConfigurationService, "load">;
	readonly #unsubscribe: () => void;
	#providers: readonly string[] = createDefaultConfig().activation.providers;

	constructor(
		configuration: Pick<ConfigurationService, "load"> &
			Partial<Pick<ConfigurationService, "onChange">>,
	) {
		this.#configuration = configuration;
		this.#unsubscribe = configuration.onChange?.((config) => this.#replace(config)) ?? (() => {});
	}

	dispose(): void {
		this.#unsubscribe();
	}

	async refresh(): Promise<void> {
		try {
			const config = await this.#configuration.load();
			this.#replace(config);
		} catch {
			// Keep the last known valid activation snapshot when storage is invalid or unavailable.
		}
	}

	decision(model: ProviderActivationModel | undefined): ProviderActivationDecision {
		return resolveProviderActivation(model, this.#configView());
	}

	isActive(model: ProviderActivationModel | undefined): boolean {
		return this.decision(model).active;
	}

	providers(): readonly string[] {
		return this.#providers;
	}

	#replace(config: Pick<CodexConfig, "activation">): void {
		this.#providers = [...config.activation.providers];
	}

	#configView(): Pick<CodexConfig, "activation"> {
		return { activation: { providers: [...this.#providers] } };
	}
}

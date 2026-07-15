import { type PlanUpdate, parsePlanUpdate } from "../domain/plan.ts";

export interface PlanViewPort {
	publish(update: PlanUpdate): void | Promise<void>;
}

export class PlanModeError extends Error {
	readonly code: "update_plan_not_allowed";

	constructor() {
		super("update_plan is a TODO/checklist tool and is not allowed in Plan mode");
		this.name = "PlanModeError";
		this.code = "update_plan_not_allowed";
	}
}

export class UpdatePlanUseCase {
	readonly #view: PlanViewPort;

	constructor(view: PlanViewPort) {
		this.#view = view;
	}

	async execute(argumentsValue: unknown, mode: "default" | "plan"): Promise<string> {
		if (mode === "plan") throw new PlanModeError();
		const update = parsePlanUpdate(argumentsValue);
		await this.#view.publish(update);
		return "Plan updated";
	}
}

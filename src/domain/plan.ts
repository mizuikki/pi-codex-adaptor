export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
	step: string;
	status: PlanItemStatus;
}

export interface PlanUpdate {
	explanation?: string;
	plan: PlanItem[];
}

export class PlanArgumentsError extends Error {
	readonly code: "invalid_plan_arguments";

	constructor() {
		super("The update_plan arguments are invalid");
		this.name = "PlanArgumentsError";
		this.code = "invalid_plan_arguments";
	}
}

export function parsePlanUpdate(value: unknown): PlanUpdate {
	if (!isRecord(value) || hasUnknownKeys(value, ["explanation", "plan"])) {
		throw new PlanArgumentsError();
	}
	if (value.explanation !== undefined && typeof value.explanation !== "string") {
		throw new PlanArgumentsError();
	}
	if (!Array.isArray(value.plan)) {
		throw new PlanArgumentsError();
	}
	const plan = value.plan.map((item) => {
		if (
			!isRecord(item) ||
			hasUnknownKeys(item, ["step", "status"]) ||
			typeof item.step !== "string" ||
			!isPlanItemStatus(item.status)
		) {
			throw new PlanArgumentsError();
		}
		return { step: item.step, status: item.status };
	});
	return value.explanation === undefined ? { plan } : { explanation: value.explanation, plan };
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).some((key) => !allowedSet.has(key));
}

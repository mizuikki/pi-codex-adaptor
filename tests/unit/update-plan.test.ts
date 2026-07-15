import { describe, expect, test } from "bun:test";
import { PlanModeError, UpdatePlanUseCase } from "../../src/application/update-plan.ts";
import { PlanArgumentsError } from "../../src/domain/plan.ts";

describe("official update_plan behavior", () => {
	test("publishes validated plan updates and returns the fixed success output", async () => {
		const updates: unknown[] = [];
		const useCase = new UpdatePlanUseCase({
			publish: (update) => {
				updates.push(update);
			},
		});
		const input = {
			explanation: "Fixture explanation",
			plan: [
				{ step: "First", status: "in_progress" },
				{ step: "Second", status: "pending" },
			],
		};

		expect(await useCase.execute(input, "default")).toBe("Plan updated");
		expect(updates).toEqual([input]);
	});

	test("does not add a stricter multiple-in-progress rejection", async () => {
		const useCase = new UpdatePlanUseCase({ publish: () => {} });
		await expect(
			useCase.execute(
				{
					plan: [
						{ step: "First", status: "in_progress" },
						{ step: "Second", status: "in_progress" },
					],
				},
				"default",
			),
		).resolves.toBe("Plan updated");
	});

	test("rejects malformed arguments and Plan mode", async () => {
		const useCase = new UpdatePlanUseCase({ publish: () => {} });
		await expect(
			useCase.execute({ plan: [{ step: "Missing status" }] }, "default"),
		).rejects.toBeInstanceOf(PlanArgumentsError);
		await expect(useCase.execute({ plan: [] }, "plan")).rejects.toBeInstanceOf(PlanModeError);
	});
});

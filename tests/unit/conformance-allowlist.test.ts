import { expect, test } from "bun:test";

import { normalizeToolContract, type ResponsesAllowlist } from "../conformance/allowlist.ts";

const allowlist = {
	toolContractFields: ["name", "description", "parameters"],
} as ResponsesAllowlist;

test("tool contract normalization removes platform-specific exec descriptions", () => {
	const contract = (yieldDescription: string) => ({
		name: "exec_command",
		description: "platform shell description",
		parameters: {
			properties: {
				yield_time_ms: {
					description: yieldDescription,
					type: "number",
				},
			},
		},
	});

	const unix = normalizeToolContract(contract("Unix timing description"), allowlist);
	const windows = normalizeToolContract(contract("Windows timing description"), allowlist);

	expect(windows).toEqual(unix);
	expect(windows).toMatchObject({
		description: "<official platform-specific shell description>",
		parameters: {
			properties: {
				yield_time_ms: {
					description: "<official platform-specific exec yield description>",
				},
			},
		},
	});
});

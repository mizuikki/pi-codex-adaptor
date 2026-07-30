import { describe, expect, test } from "bun:test";

import { securityPolicyWarning } from "../../src/application/security-policy.ts";
import { createDefaultConfig } from "../../src/domain/config.ts";

describe("security policy warnings", () => {
	test.each([
		["on-request", "workspace", undefined],
		["never", "workspace", "approval policy is never"],
		["on-request", "unrestricted", "filesystem access is unrestricted"],
		["never", "unrestricted", "dangerous full access is enabled"],
	] as const)("selects one warning for %s + %s", (approvalPolicy, filesystemAccessPolicy, expected) => {
		const config = createDefaultConfig();
		config.security = { approvalPolicy, filesystemAccessPolicy };
		const warning = securityPolicyWarning(config);
		if (expected === undefined) {
			expect(warning).toBeUndefined();
		} else {
			expect(warning).toContain(expected);
		}
	});
});

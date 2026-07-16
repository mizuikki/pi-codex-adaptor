import { describe, expect, test } from "bun:test";

import { verifyPullRequest } from "../../scripts/verify-pr.ts";

describe("pull request contract", () => {
	test("accepts human conventional titles with matching release labels", () => {
		expect(() =>
			verifyPullRequest({
				authorType: "User",
				labels: ["release:none"],
				title: "chore(deps): refresh development tooling",
			}),
		).not.toThrow();

		expect(() =>
			verifyPullRequest({
				authorType: "User",
				labels: ["release:minor"],
				title: "feat(bridge): expose a new capability",
			}),
		).not.toThrow();
	});

	test("rejects human pull requests without exactly one release intent label", () => {
		expect(() =>
			verifyPullRequest({
				authorType: "User",
				labels: ["dependencies"],
				title: "chore(deps): bump actions/setup-node from 6.4.0 to 7.0.0",
			}),
		).toThrow("Human pull requests require exactly one release intent label");
	});

	test("allows bot pull requests without release intent labels", () => {
		expect(() =>
			verifyPullRequest({
				authorType: "Bot",
				labels: ["dependencies", "javascript"],
				title:
					"chore(deps-dev): bump @types/node from 24.13.3 to 24.14.0 in the project-tooling group across 1 directory",
			}),
		).not.toThrow();

		expect(() =>
			verifyPullRequest({
				authorType: "Bot",
				labels: ["autorelease: pending"],
				title: "chore(release-0.1): release pi-codex-adaptor v0.1.0-rc.1",
			}),
		).not.toThrow();
	});

	test("still requires conventional commit titles for bots", () => {
		expect(() =>
			verifyPullRequest({
				authorType: "Bot",
				labels: ["dependencies"],
				title: "Bump @types/node from 24.13.3 to 26.1.1",
			}),
		).toThrow("Pull request title must follow Conventional Commits");
	});
});

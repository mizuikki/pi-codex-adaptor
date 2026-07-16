const releaseLabels = new Set(["release:major", "release:minor", "release:patch", "release:none"]);

export interface PullRequestContractInput {
	authorType: string;
	labels: string[];
	title: string;
}

export function verifyPullRequest(input: PullRequestContractInput): void {
	// Release Please and dependency bots are not human release proposals. They still need a
	// Conventional Commits title, but they do not carry human release intent labels.
	if (input.authorType === "Bot") {
		assertConventionalCommitTitle(input.title);
		return;
	}

	const match = assertConventionalCommitTitle(input.title);
	const selectedLabels = input.labels.filter((label) => releaseLabels.has(label));
	if (selectedLabels.length !== 1) {
		throw new Error("Human pull requests require exactly one release intent label");
	}

	const type = match.groups.type;
	const expectedLabel = match.groups.breaking
		? "release:major"
		: type === "feat"
			? "release:minor"
			: type === "fix" || type === "perf"
				? "release:patch"
				: "release:none";

	if (selectedLabels[0] !== expectedLabel) {
		throw new Error(`Pull request title requires ${expectedLabel}, received ${selectedLabels[0]}`);
	}
}

function assertConventionalCommitTitle(title: string): RegExpExecArray & {
	groups: { breaking?: string; type: string };
} {
	const match = /^(?<type>[a-z]+)(?<breaking>!)?(?:\([a-z0-9][a-z0-9._/-]*\))?: .+$/u.exec(title);
	if (match?.groups === undefined) {
		throw new Error("Pull request title must follow Conventional Commits");
	}
	return match as RegExpExecArray & { groups: { breaking?: string; type: string } };
}

if (import.meta.main) {
	verifyPullRequest({
		authorType: process.env.PR_AUTHOR_TYPE ?? "User",
		labels: JSON.parse(process.env.PR_LABELS ?? "[]") as string[],
		title: process.env.PR_TITLE ?? "",
	});
}

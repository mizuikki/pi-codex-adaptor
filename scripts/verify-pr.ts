const releaseLabels = new Set(["release:major", "release:minor", "release:patch", "release:none"]);

const title = process.env.PR_TITLE ?? "";
const labels = JSON.parse(process.env.PR_LABELS ?? "[]") as string[];
const authorType = process.env.PR_AUTHOR_TYPE ?? "User";

if (authorType === "Bot" && labels.includes("autorelease: pending")) {
	process.exit(0);
}

const match = /^(?<type>[a-z]+)(?<breaking>!)?(?:\([a-z0-9][a-z0-9._/-]*\))?: .+$/u.exec(title);
if (match?.groups === undefined) {
	throw new Error("Pull request title must follow Conventional Commits");
}

const selectedLabels = labels.filter((label) => releaseLabels.has(label));
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

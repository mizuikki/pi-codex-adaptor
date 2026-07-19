import type { Skill } from "@earendil-works/pi-coding-agent";

export function codexSkillsPrompt(
	skills: readonly Skill[] | undefined,
	loader: "exec_command" | "shell_command" | undefined,
	existingPrompt: string,
): string {
	if (loader === undefined || existingPrompt.includes("<available_skills>")) return "";
	const visibleSkills = (skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		`Use ${loader} to load a matching skill file when the task matches its description.`,
		"When a skill file references a relative path, resolve it against the skill directory.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

import { describe, expect, test } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";

import { codexSkillsPrompt } from "../../src/integration/pi/codex-system-prompt.ts";

function skill(
	name: string,
	description: string,
	filePath: string,
	disableModelInvocation = false,
): Skill {
	return {
		name,
		description,
		filePath,
		baseDir: "<synthetic>/skills",
		sourceInfo: {
			path: filePath,
			source: "synthetic",
			scope: "temporary",
			origin: "top-level",
		},
		disableModelInvocation,
	};
}

describe("Codex skill prompt continuity", () => {
	test("formats active skills with the resolved shell loader and escapes XML", () => {
		const existingPrompt = "Pi prompt\nAppend prompt";
		const prompt = codexSkillsPrompt(
			[
				skill(
					"review-skill",
					'Review <files> & preserve "context"',
					"<synthetic>/skills/review/SKILL.md",
				),
				skill(
					"explicit-only",
					"Only available from an explicit command",
					"<synthetic>/skills/explicit/SKILL.md",
					true,
				),
			],
			"exec_command",
			"Pi prompt\nAppend prompt",
		);

		const augmentedPrompt = `${existingPrompt}${prompt}`;
		expect(augmentedPrompt).toContain("Pi prompt\nAppend prompt");
		expect(augmentedPrompt.startsWith(existingPrompt)).toBe(true);
		expect(prompt).toContain("Use exec_command to load a matching skill file");
		expect(prompt).toContain("Review &lt;files&gt; &amp; preserve &quot;context&quot;");
		expect(prompt).toContain("<location>&lt;synthetic&gt;/skills/review/SKILL.md</location>");
		expect(prompt).not.toContain("explicit-only");
		expect(prompt).not.toContain("read");
		expect(prompt.match(/<available_skills>/g)?.length).toBe(1);
	});

	test("omits discovery when no file-capable loader exists or Pi already formatted skills", () => {
		const skills = [skill("review-skill", "Review files", "<synthetic>/skills/review/SKILL.md")];
		expect(codexSkillsPrompt(skills, undefined, "Pi prompt")).toBe("");
		expect(
			codexSkillsPrompt(
				skills,
				"shell_command",
				"Pi prompt\n<available_skills>\nPi\n</available_skills>",
			),
		).toBe("");
		expect(codexSkillsPrompt([], "exec_command", "Pi prompt")).toBe("");
	});
});

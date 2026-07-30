import type { CodexConfig } from "../domain/config.ts";

export function securityPolicyWarning(config: CodexConfig): string | undefined {
	const { approvalPolicy, filesystemAccessPolicy } = config.security;
	if (approvalPolicy === "never" && filesystemAccessPolicy === "unrestricted") {
		return "Codex dangerous full access is enabled: operations do not prompt, structured tools may use external paths, and native commands run with the user's permissions.";
	}
	if (approvalPolicy === "never") {
		return "Codex approval policy is never: operations do not prompt, explicit structured-tool paths remain workspace constrained, and native commands run with the user's permissions.";
	}
	if (filesystemAccessPolicy === "unrestricted") {
		return "Codex filesystem access is unrestricted: structured tools may use external paths after operation approval; this is not an OS sandbox.";
	}
	return undefined;
}

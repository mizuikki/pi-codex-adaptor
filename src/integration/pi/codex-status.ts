import type { EffectiveCapabilitySnapshot } from "../../application/resolve-effective-capabilities.ts";
import type { ApprovalPolicy } from "../../domain/config.ts";

type CodexStatusSnapshot = Pick<EffectiveCapabilitySnapshot, "webSurface"> & {
	shell: Pick<EffectiveCapabilitySnapshot["shell"], "primary" | "sessionSurface">;
	webSearch: Pick<EffectiveCapabilitySnapshot["webSearch"], "status">;
};

export function formatCodexStatus(
	snapshot: CodexStatusSnapshot,
	approvalPolicy: ApprovalPolicy,
): string {
	return [
		"Codex",
		shellToken(snapshot.shell.primary),
		sessionToken(snapshot.shell.sessionSurface),
		webToken(snapshot),
		approvalPolicy === "bypass" ? "!bypass" : undefined,
	]
		.filter((token): token is string => token !== undefined)
		.join(" ");
}

function shellToken(surface: CodexStatusSnapshot["shell"]["primary"]): string | undefined {
	switch (surface) {
		case "unified-exec":
			return "exec";
		case "shell-command":
			return "sh";
		case "disabled":
			return undefined;
	}
}

function sessionToken(surface: CodexStatusSnapshot["shell"]["sessionSurface"]): string | undefined {
	switch (surface) {
		case "official":
			return "bg";
		case "supplemental":
			return "bg+";
		case "disabled":
		case "unavailable":
			return undefined;
	}
}

function webToken(snapshot: CodexStatusSnapshot): string | undefined {
	if (snapshot.webSearch.status !== "available") return undefined;
	switch (snapshot.webSurface) {
		case "standalone":
		case "hosted":
			return "web";
		case "disabled":
		case "unsupported":
			return undefined;
	}
}

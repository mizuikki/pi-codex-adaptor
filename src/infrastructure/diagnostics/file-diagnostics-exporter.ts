import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
	DiagnosticExport,
	DiagnosticsExporter,
	DiagnosticsSnapshot,
} from "../../application/diagnostics.ts";
import { sanitizeSnapshot } from "../../application/diagnostics.ts";

export class DiagnosticsStorageError extends Error {
	readonly code: "export_failure";

	constructor(message: string) {
		super(message);
		this.name = "DiagnosticsStorageError";
		this.code = "export_failure";
	}
}

export class FileDiagnosticsExporter implements DiagnosticsExporter {
	async export(snapshot: DiagnosticsSnapshot, path: string): Promise<DiagnosticExport> {
		const sanitized = sanitizeSnapshot(snapshot);
		const contents = `${JSON.stringify(sanitized, null, 2)}\n`;
		const temporary = `${path}.tmp-${randomUUID()}`;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(contents, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
		} catch {
			await rm(temporary, { force: true }).catch(() => {});
			throw new DiagnosticsStorageError("Codex diagnostics could not be exported");
		}
		return { path, sha256: createHash("sha256").update(contents).digest("hex") };
	}
}

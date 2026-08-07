import { describe, expect, test } from "bun:test";
import type {
	CustomEntry,
	EntryRenderer,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { CODEX_REMOTE_COMPACTION_KIND } from "../../src/application/compaction.ts";
import {
	beginInline,
	CODEX_INLINE_COMPACTION_PHASE_LABELS,
	CODEX_REMOTE_COMPACTION_LABEL,
	CODEX_REMOTE_COMPACTION_STATUS_KEY,
	completeInline,
	failInline,
	registerEntryRenderer,
	renderRemoteCompactionEntry,
} from "../../src/integration/pi/codex-compaction-ui.ts";

type FakeUI = {
	statuses: Map<string, string | undefined>;
	notifications: Array<{ message: string; type: string | undefined }>;
};

function fakeContext(
	ui: Partial<FakeUI> & { statuses: Map<string, string | undefined> },
): ExtensionContext {
	return {
		ui: {
			setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text),
			notify: (message: string, type?: string) => {
				ui.notifications?.push({ message, type });
			},
		},
	} as unknown as ExtensionContext;
}

function fakeEntry(
	navigation: unknown,
	data: unknown = {
		output: [{ type: "reasoning", encrypted_content: "opaque-fixture-output" }],
	},
): CustomEntry<unknown> {
	return {
		type: "custom",
		id: "checkpoint-entry",
		parentId: "covered-entry",
		timestamp: "2026-08-07T00:00:00.000Z",
		customType: CODEX_REMOTE_COMPACTION_KIND,
		data,
		navigation,
	} as CustomEntry<unknown>;
}

function renderedText(component: Component | undefined): string {
	return (
		component
			?.render(120)
			.map((line) => line.trimEnd())
			.join("\n") ?? ""
	);
}

describe("Codex compaction UI projection", () => {
	test("uses distinct bounded statuses for threshold and re-compaction phases", () => {
		const statuses = new Map<string, string | undefined>();
		const notifications: FakeUI["notifications"] = [];
		const ctx = fakeContext({ statuses, notifications });

		beginInline(ctx, "threshold");
		expect(statuses.get(CODEX_REMOTE_COMPACTION_STATUS_KEY)).toBe(
			`${CODEX_INLINE_COMPACTION_PHASE_LABELS.threshold}: creating checkpoint`,
		);
		beginInline(ctx, "recompact");
		expect(statuses.get(CODEX_REMOTE_COMPACTION_STATUS_KEY)).toBe(
			`${CODEX_INLINE_COMPACTION_PHASE_LABELS.recompact}: creating checkpoint`,
		);
		expect(notifications).toEqual([]);
	});

	test("clears inline status and emits one safe success notification at commit completion", () => {
		const statuses = new Map<string, string | undefined>();
		const notifications: FakeUI["notifications"] = [];
		const ctx = fakeContext({ statuses, notifications });

		beginInline(ctx, "threshold");
		completeInline(ctx, 12_345);

		expect(statuses.get(CODEX_REMOTE_COMPACTION_STATUS_KEY)).toBeUndefined();
		expect(notifications).toEqual([
			{
				message: `${CODEX_REMOTE_COMPACTION_LABEL} saved (12,345 tokens before compaction)`,
				type: "info",
			},
		]);
	});

	test("clears status and gives bounded outcome-only feedback for failure states", () => {
		const outcomes = [
			["error", "Codex checkpoint failed", "error"],
			["cancel", "Codex compaction cancelled", "warning"],
			["indeterminate", "Codex checkpoint outcome could not be verified", "warning"],
		] as const;

		for (const [outcome, message, type] of outcomes) {
			const statuses = new Map<string, string | undefined>();
			const notifications: FakeUI["notifications"] = [];
			const ctx = fakeContext({ statuses, notifications });
			beginInline(ctx, "recompact");
			failInline(ctx, outcome);

			expect(statuses.get(CODEX_REMOTE_COMPACTION_STATUS_KEY)).toBeUndefined();
			expect(notifications).toEqual([{ message, type }]);
			expect(message).not.toContain("opaque");
			expect(message).not.toContain("prompt");
			expect(message).not.toContain("https://");
		}
	});

	test("does not duplicate native manual or overflow completion feedback", () => {
		const statuses = new Map<string, string | undefined>();
		const notifications: FakeUI["notifications"] = [];
		const ctx = fakeContext({ statuses, notifications });

		for (const trigger of ["manual", "overflow"] as const) {
			beginInline(ctx, "threshold");
			completeInline(ctx, 100, trigger);
		}

		expect(statuses.get(CODEX_REMOTE_COMPACTION_STATUS_KEY)).toBeUndefined();
		expect(notifications).toEqual([]);
	});

	test("renders only the safe Codex marker and pre-compaction token count", () => {
		const component = renderRemoteCompactionEntry(
			fakeEntry({
				role: "provider_checkpoint",
				tokensBefore: 98_765,
			}),
			{ expanded: false },
			{ fg: (_color: string, text: string) => text } as never,
		);
		const text = renderedText(component);

		expect(text).toBe("Codex checkpoint (98,765 tokens before compaction)");
		expect(text).not.toContain("opaque-fixture-output");
		expect(text).not.toContain("encrypted_content");
	});

	test("does not inspect opaque data while rejecting malformed projections", () => {
		let dataRead = false;
		const entry = {
			...fakeEntry({ role: "provider_checkpoint", tokensBefore: 10 }),
			get data() {
				dataRead = true;
				return { output: "opaque-fixture-output" };
			},
		} as unknown as CustomEntry<unknown>;

		expect(
			renderedText(
				renderRemoteCompactionEntry(entry, { expanded: false }, {
					fg: (_c: string, text: string) => text,
				} as never),
			),
		).toBe("Codex checkpoint (10 tokens before compaction)");
		expect(dataRead).toBe(false);

		const malformed = [
			fakeEntry(undefined),
			fakeEntry({ role: "custom", tokensBefore: 10 }),
			fakeEntry({ role: "provider_checkpoint", tokensBefore: -1 }),
			fakeEntry({ role: "provider_checkpoint", tokensBefore: Number.NaN }),
			fakeEntry({ role: "provider_checkpoint", tokensBefore: Number.POSITIVE_INFINITY }),
			{ ...fakeEntry({ role: "provider_checkpoint", tokensBefore: 10 }), customType: "other" },
		] as const;
		for (const candidate of malformed) {
			expect(
				renderRemoteCompactionEntry(candidate as CustomEntry<unknown>, { expanded: false }, {
					fg: (_c: string, text: string) => text,
				} as never),
			).toBeUndefined();
		}
	});

	test("treats renderer registration and status methods as optional", () => {
		expect(() => {
			const ctx = {
				ui: {},
			} as unknown as ExtensionContext;
			beginInline(ctx, "threshold");
			completeInline(ctx, 10);
			failInline(ctx, "error");
			registerEntryRenderer({} as ExtensionAPI);
		}).not.toThrow();
	});

	test("registers the existing checkpoint kind without changing the renderer contract", () => {
		let registeredType: string | undefined;
		let registeredRenderer: EntryRenderer<unknown> | undefined;
		const pi = {
			registerEntryRenderer(type: string, renderer: EntryRenderer<unknown>) {
				registeredType = type;
				registeredRenderer = renderer;
			},
		} as unknown as ExtensionAPI;

		registerEntryRenderer(pi);

		expect(registeredType).toBe(CODEX_REMOTE_COMPACTION_KIND);
		expect(registeredRenderer).toBe(renderRemoteCompactionEntry);
	});
});

import { describe, expect, test } from "bun:test";

import piCodexAdaptor from "../../src/extension.ts";

describe("extension entry point", () => {
	test("loads without registering unfinished runtime behavior", () => {
		const pi = Object.freeze({});

		expect(() => piCodexAdaptor(pi as never)).not.toThrow();
	});
});

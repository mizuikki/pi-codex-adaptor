/**
 * Return true only for a finite, acyclic JSON value made from plain data
 * properties. Accessors, symbols, sparse arrays, and custom properties are
 * rejected before any value is read.
 */
export function isStrictJsonValue(value: unknown): boolean {
	return visit(value, new Set<object>());
}

export function isStrictPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return (prototype === Object.prototype || prototype === null) && strictRecordProperties(value);
	} catch {
		return false;
	}
}

export function isStrictJsonArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value)) return false;
	try {
		if (Object.getPrototypeOf(value) !== Array.prototype || !strictArrayProperties(value)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function visit(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (!isStrictJsonArray(value)) return false;
			for (let index = 0; index < value.length; index += 1) {
				if (!visit(value[index], ancestors)) return false;
			}
			return true;
		}
		if (!isStrictPlainRecord(value)) return false;
		for (const key of Object.keys(value)) {
			if (!visit(value[key], ancestors)) return false;
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}

function strictRecordProperties(value: object): boolean {
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) return false;
	const names = ownKeys as string[];
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
			return false;
		}
	}
	return true;
}

function strictArrayProperties(value: readonly unknown[]): boolean {
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) return false;
	const names = ownKeys as string[];
	if (!names.includes("length")) return false;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		lengthDescriptor === undefined ||
		!("value" in lengthDescriptor) ||
		lengthDescriptor.value !== value.length
	) {
		return false;
	}
	for (let index = 0; index < value.length; index += 1) {
		const name = String(index);
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
			return false;
		}
	}
	return names.every((name) => name === "length" || isArrayIndex(name, value.length));
}

function isArrayIndex(name: string, length: number): boolean {
	if (name === "") return false;
	const index = Number(name);
	return Number.isInteger(index) && index >= 0 && index < length && String(index) === name;
}

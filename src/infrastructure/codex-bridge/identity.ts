export const BRIDGE_PROTOCOL_VERSION = 3;
export const OFFICIAL_CODEX_VERSION = "0.144.3";
export const OFFICIAL_CODEX_TAG = "rust-v0.144.3";
export const OFFICIAL_SOURCE_COMMIT = "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c";
export const VENDOR_TREE_SHA256 =
	"4e73a4c8efdc818b085b4abea1660b3a6d84b0fdbb6d687bda5c55dc0f07caad";

export const SUPPORTED_NATIVE_TARGETS = [
	"x86_64-unknown-linux-musl",
	"aarch64-unknown-linux-musl",
	"x86_64-apple-darwin",
	"aarch64-apple-darwin",
	"x86_64-pc-windows-msvc",
] as const;

export type SupportedNativeTarget = (typeof SUPPORTED_NATIVE_TARGETS)[number];

export function nativeTargetFor(
	platform: NodeJS.Platform,
	architecture: string,
): SupportedNativeTarget | undefined {
	return targetByPlatform.get(`${platform}/${architecture}`);
}

const targetByPlatform = new Map<string, SupportedNativeTarget>([
	["linux/x64", "x86_64-unknown-linux-musl"],
	["linux/arm64", "aarch64-unknown-linux-musl"],
	["darwin/x64", "x86_64-apple-darwin"],
	["darwin/arm64", "aarch64-apple-darwin"],
	["win32/x64", "x86_64-pc-windows-msvc"],
]);

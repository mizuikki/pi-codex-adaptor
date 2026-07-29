export const BRIDGE_PROTOCOL_VERSION = 6;
export const OFFICIAL_CODEX_VERSION = "0.146.0";
export const OFFICIAL_CODEX_TAG = "rust-v0.146.0";
export const OFFICIAL_SOURCE_COMMIT = "e363b08c9175ac1cbe5893615dd2cb9ddf95043b";
export const VENDOR_TREE_SHA256 =
	"f61c3b46698213bba6b025f12debd46cd5e2608433dd7903fa7b79fecdb4c9bb";

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

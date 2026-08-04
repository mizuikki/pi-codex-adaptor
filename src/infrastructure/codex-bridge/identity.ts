export const BRIDGE_PROTOCOL_VERSION = 8;
export const OFFICIAL_CODEX_VERSION = "0.146.0";
export const OFFICIAL_CODEX_TAG = "rust-v0.146.0";
export const OFFICIAL_SOURCE_COMMIT = "e363b08c9175ac1cbe5893615dd2cb9ddf95043b";
export const VENDOR_TREE_SHA256 =
	"4480020e4ec987e750247807b040a0402f391baa7c268242c0019eaac6da6574";

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

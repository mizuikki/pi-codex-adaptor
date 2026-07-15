/**
 * Child-process environment policy for codex-bridge.
 *
 * Credentials must enter the bridge only through bounded stdin initialize and
 * authentication_update frames. The spawn environment is therefore narrowed to
 * runtime variables required for process startup, locale, temporary files,
 * proxy routing, and TLS trust roots.
 */

const UNIX_CORE_VARIABLES = [
	"PATH",
	"SHELL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOGNAME",
	"USER",
	"TZ",
	"TERM",
	"NO_COLOR",
	"COLORTERM",
	"FORCE_COLOR",
] as const;

const WINDOWS_CORE_VARIABLES = [
	"PATH",
	"PATHEXT",
	"SHELL",
	"COMSPEC",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"USERNAME",
	"USERDOMAIN",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"PROGRAMDATA",
	"LOCALAPPDATA",
	"APPDATA",
	"TEMP",
	"TMP",
	"TMPDIR",
	"POWERSHELL",
	"PWSH",
	"TZ",
	"TERM",
	"NO_COLOR",
	"COLORTERM",
	"FORCE_COLOR",
] as const;

const NETWORK_VARIABLES = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
] as const;

const CREDENTIAL_NAME =
	/(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|ID[_-]?TOKEN|SESSION[_-]?TOKEN|AUTH(?:ORIZATION)?|PASSWORD|SECRET|CREDENTIAL|TOKEN)(?:_|$)|(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

export function createBridgeChildEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const allowlist = new Set<string>([
		...(platform === "win32" ? WINDOWS_CORE_VARIABLES : UNIX_CORE_VARIABLES),
		...NETWORK_VARIABLES,
	]);

	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) {
			continue;
		}
		if (!isAllowlisted(name, allowlist)) {
			continue;
		}
		if (isCredentialVariable(name)) {
			continue;
		}
		if (isProxyVariable(name) && hasProxyCredentials(value)) {
			throw new Error("Credential-bearing proxy URLs are not allowed");
		}
		environment[name] = value;
	}
	return environment;
}

export function isCredentialEnvironmentVariable(name: string): boolean {
	return isCredentialVariable(name);
}

function isAllowlisted(name: string, allowlist: Set<string>): boolean {
	if (allowlist.has(name)) {
		return true;
	}
	const upper = name.toUpperCase();
	for (const allowed of allowlist) {
		if (allowed.toUpperCase() === upper) {
			return true;
		}
	}
	return false;
}

function isCredentialVariable(name: string): boolean {
	const upper = name.toUpperCase();
	if (
		upper === "SSL_CERT_FILE" ||
		upper === "SSL_CERT_DIR" ||
		upper === "CURL_CA_BUNDLE" ||
		upper === "REQUESTS_CA_BUNDLE" ||
		upper === "NODE_EXTRA_CA_CERTS" ||
		upper === "PATHEXT" ||
		upper === "PATH" ||
		upper === "TERM" ||
		upper === "TMPDIR" ||
		upper === "TEMP" ||
		upper === "TMP"
	) {
		return false;
	}
	return CREDENTIAL_NAME.test(name);
}

function isProxyVariable(name: string): boolean {
	return /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name);
}

function hasProxyCredentials(value: string): boolean {
	if (proxyAuthority(value).includes("@")) {
		return true;
	}
	try {
		const proxy = new URL(value);
		return proxy.username.length > 0 || proxy.password.length > 0;
	} catch {
		return value.includes("@");
	}
}

function proxyAuthority(value: string): string {
	const authorityStart = value.indexOf("://");
	const start = authorityStart < 0 ? 0 : authorityStart + 3;
	const end = value.slice(start).search(/[/?#]/);
	return end < 0 ? value.slice(start) : value.slice(start, start + end);
}

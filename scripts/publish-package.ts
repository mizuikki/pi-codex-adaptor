if (!process.argv.includes("--prepare-only")) {
	throw new Error(
		"Publishing is disabled in the 0.0.0 skeleton. Use --prepare-only after the release verifier and native artifact pipeline are implemented.",
	);
}

throw new Error(
	"Release preparation is not available until the native artifact manifest and exact-tarball verifier are implemented.",
);

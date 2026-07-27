# pi-codex-adaptor

`pi-codex-adaptor` is a private Pi extension for the pinned OpenAI Codex `0.144.3` runtime. Pi
remains the agent and session owner; the Rust bridge owns Responses transport, native retries, tools,
and Remote Compaction.

The adaptor has one compaction operation: `responses.compact`. It selects `remote_v2` when the
provider advertises it and otherwise selects the official `/responses/compact` client before the
request starts. A completed result is validated and persisted as an extension-owned Pi `CustomEntry`
with type `pi-codex-adaptor.remote-compaction`. The entry is invisible to Pi's generic context
projection. Exact Codex identity can replay the opaque output plus the canonical uncovered suffix;
identity changes use canonical Pi history, emit one bounded warning, and require a new session when
that history does not fit. The adaptor never creates a portable summary or retries compaction in
TypeScript.

Pi session format remains version 3, the common extension ABI remains version 1, and the fork-only
provider checkpoint capability is independently versioned at `1`. Old adaptor checkpoint formats are
inert and unsupported for adaptor continuity. Start a new session when installing this clean-slate
implementation.

## Development

The pinned toolchain is Bun `1.3.14`, Node.js `24.18.0`, TypeScript `7.0.2`, and Rust `1.95.0`.

```sh
bun ci
bun run check
```

The check pipeline validates the protocol identity, native source and artifact provenance, official
fixtures, clean-slate identifiers, Pi fork consumer, SBOM, and package file allowlist.

## Local installation

This package is private and is installed from a local checkout. The sibling `../pi` fork is a
development dependency only; all four Pi SDK packages remain wildcard runtime peers.

```sh
bun ci
bun run native:local
pi install -l /absolute/path/to/pi-codex-adaptor
```

Use `pi remove /absolute/path/to/pi-codex-adaptor -l` to remove it. Verify the paired fork from an
immutable commit or protected capability tag:

```sh
bun run test:pi-fork -- --pi-dir /absolute/path/to/pi --pi-ref <commit-or-tag>
```

The verifier creates an isolated `<temp>/pi` and `<temp>/project`, reads the Pi SDK manifest, checks
the SHA-256 digest of each of the four SDK tarballs, installs them directly into positive consumers,
and exercises the real Pi loader with poison packages. It does not publish the package or restore
registry installation.

`bun run native:local -- --check` verifies an already installed native artifact. The development
bridge accepts `0.0.0`; packaged launches require a verified `native/bin/<target>/native-artifact.json`.

## Configuration and security

The only supported configuration file is `~/.pi/agent/pi-codex-adaptor.json`. Its safe default is
prompt approval. The explicit bypass setting is Pi-owned per-request preauthorization, not an OS
sandbox; native commands still run with the user's permissions.

Credentials, prompts, opaque output, account data, and absolute user paths are excluded from logs,
diagnostics, fixtures, and errors. The package does not implement account usage, rate-limit windows,
reset-credit handling, or Codex app-server lifecycle features.

The product contract, architecture, protocol, and verification evidence are documented in
[`PRODUCT_CONTRACT.md`](./PRODUCT_CONTRACT.md), [`docs/architecture.md`](./docs/architecture.md),
[`docs/bridge-protocol.md`](./docs/bridge-protocol.md), and
[`docs/automatic-compaction-verification.md`](./docs/automatic-compaction-verification.md).

## License

Project-owned source is licensed under Apache-2.0. Vendored OpenAI Codex source retains its upstream
notices and provenance.

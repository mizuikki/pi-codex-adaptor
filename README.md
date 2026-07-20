# pi-codex-adaptor

`pi-codex-adaptor` is a Pi extension that will adapt the public OpenAI Codex `0.144.3`
protocol and selected runtime modules without running a second agent inside Pi.

The repository is under active implementation. Protocol v3, the native baseline handshake, official
Responses SSE/WebSocket transport with connect fallback, compact endpoint, and exact model metadata
resolution are implemented. The versioned configuration store, prompt-approved or preauthorized Unified Exec sessions,
and `/codex` settings overlay are available. The extension registers the native bridge stream for
`openai-codex` and every configured activated provider id through Pi's public provider API, dispatches
both supported Responses APIs by exact provider-id activation, and delegates unselected providers directly
to Pi's public native streams. An activated
provider uses an isolated Codex core tool profile: Pi's seven core tools are suppressed while
orthogonal additive external tools remain available, and an unavailable Codex profile fails closed without
restoring Pi core tools. Deactivation restores the Pi core selection captured at entry. The adaptor
executes prompt-approved or explicitly preauthorized patches through the official parser, supports workspace image inspection, and
restores process ownership on session shutdown. The two process-stable stream handlers route by Pi's
session identity to isolated main or nested-session state. An unrelated extension that replaces
either supported Responses API remains an explicit registry conflict.
Inline automatic compaction runs inside the already-planned provider request when the active context is
known to be over threshold; it does not abort the run, call Pi's `ctx.compact()`, add a turn, or send a
continuation message. Manual Pi compaction remains Pi-owned. Both paths use the official
RemoteCompactionV2 stream when available and otherwise the typed Compact endpoint. Their canonical
output is retained as versioned opaque checkpoints for provider-bound replay, including the encrypted
string exactly as returned. The adaptor never decrypts that content or displays it as prose. The
generated `image_gen.imagegen` namespace uses the official Images client for generation
and workspace-scoped edits, and standalone `web.run` uses the typed Search client. `/codex` offers
the four settings categories, a manual compact action, compact inline tool rendering, and redacted
diagnostics export. The package has not been published to npm.

## Development

The pinned development toolchain is Bun `1.3.14`, Node.js `24.18.0`, TypeScript `7.0.2`, and Rust
`1.95.0`.

```sh
bun ci
bun run check
```

The check pipeline rebuilds the native sidecar and verifies its protocol identity, typed transport,
official tool fixtures, app-server schema snapshot, source replay, SBOM, and npm file whitelist.

## Installation

The package has not been published to npm yet. Install from a local source checkout, or use the
planned npm source after the first release.

### From source (local path)

Pi installs local paths by reference (no copy). Prefer an absolute path. Use `-l` to write project
settings (`.pi/settings.json`) instead of user settings (`~/.pi/agent/settings.json`).

1. Install dependencies, then build, install, and verify the release bridge for the current host:

```sh
bun ci
bun run native:local
```

The command infers the host target, embeds the current Git commit, assembles the executable and
`native-artifact.json`, transactionally replaces `native/bin/<target>/`, and verifies the checksum
and executable identity. A failed verification restores the previous installed artifact.

```sh
bun run native:local -- --debug
bun run native:local -- --target aarch64-unknown-linux-musl
bun run native:local -- --check
```

Cross-target builds verify the manifest and checksum but skip executing the foreign binary.

2. Install into Pi:

```sh
pi install /absolute/path/to/pi-codex-adaptor
# project-local:
# pi install /absolute/path/to/pi-codex-adaptor -l
# one-shot without writing settings:
# pi -e /absolute/path/to/pi-codex-adaptor
```

3. Confirm with `pi list`. After install, `/codex` opens the settings overlay. TypeScript changes in
this checkout apply on Pi restart or `/reload`; native changes require rerunning
`bun run native:local`.

`package.json` version `0.0.0` enables development bridge handshakes. Packaged launches still require
a verified `native/bin/<target>/` artifact for the host triple above. `native/artifacts/` alone is not
enough unless it is copied into `native/bin/`.

Remove with:

```sh
pi remove /absolute/path/to/pi-codex-adaptor
```

### Planned npm install

```sh
pi install npm:pi-codex-adaptor
```

The product contract, security boundary, and upstream source pin are documented in
[`PRODUCT_CONTRACT.md`](./PRODUCT_CONTRACT.md) and
[`docs/official-baseline.md`](./docs/official-baseline.md).
Capabilities outside the first release are tracked in
[`docs/remaining-gaps.md`](./docs/remaining-gaps.md).

## Configuration and security

The exact schema v2 configuration includes `security.approvalPolicy`, which defaults to `prompt`:

```json
{ "security": { "approvalPolicy": "prompt" } }
```

The `/codex` Tools settings can explicitly enable `bypass`. This is Pi-owned per-request
preauthorization for the supported native allowlist, not an OS sandbox: native commands run with the
user's permissions, and workspace roots do not sandbox shell behavior. Native validation and
cancellation still apply. Invalid or incomplete configuration is rejected rather than defaulting to
bypass.

## License

Project-owned source is licensed under Apache-2.0. Vendored OpenAI Codex source will retain its
upstream notices and provenance.

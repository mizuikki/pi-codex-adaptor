# pi-codex-adaptor

`pi-codex-adaptor` is a Pi extension that will adapt the public OpenAI Codex `0.144.3`
protocol and selected runtime modules without running a second agent inside Pi.

The repository is under active implementation. Protocol v3, the native baseline handshake, official
Responses SSE/WebSocket transport with connect fallback, compact endpoint, and exact model metadata
resolution are implemented. The versioned configuration store, prompt-approved or preauthorized Unified Exec sessions,
and `/codex` settings overlay are available. The extension replaces only Pi's `openai-codex` stream
handler with the native bridge adapter, dispatches both supported Responses APIs by exact provider-id
activation, and delegates unselected providers directly to Pi's public native streams. It activates
the generated update-plan and model-resolved shell surface without removing third-party tools,
executes prompt-approved or explicitly preauthorized patches through the official parser, supports workspace image inspection, and
restores process ownership on session shutdown. Because Pi owns one stream handler per API id, the
adaptor cannot safely compose with another extension that replaces either supported Responses API.
Pi compaction selects the official RemoteCompactionV2 stream when available and otherwise uses the
typed Compact endpoint; canonical output is retained as versioned opaque session details for exact
replay. The generated `image_gen.imagegen` namespace uses the official Images client for generation
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

1. Install dependencies and build the native bridge for your host target:

```sh
bun ci

# Linux x64
TARGET=x86_64-unknown-linux-musl
# Linux arm64: aarch64-unknown-linux-musl
# macOS arm64: aarch64-apple-darwin
# macOS x64: x86_64-apple-darwin
# Windows x64: x86_64-pc-windows-msvc

bun run build:native -- --target "$TARGET"
```

2. Assemble the packaged layout under `native/bin/<target>/` (executable plus
   `native-artifact.json`). The extension loads that tree from the package root:

```sh
bun scripts/assemble-native-artifact.ts \
  --target "$TARGET" \
  --executable "native/target/$TARGET/debug/codex-bridge" \
  --source-commit "$(git rev-parse HEAD)"

mkdir -p native/bin
cp -a "native/artifacts/$TARGET" native/bin/
```

On Windows, use `codex-bridge.exe` as the executable name.

3. Install into Pi:

```sh
pi install /absolute/path/to/pi-codex-adaptor
# project-local:
# pi install /absolute/path/to/pi-codex-adaptor -l
# one-shot without writing settings:
# pi -e /absolute/path/to/pi-codex-adaptor
```

4. Confirm with `pi list`. After install, `/codex` opens the settings overlay. TypeScript changes in
   this checkout apply on Pi restart or `/reload`; native changes require rebuilding and re-copying
   into `native/bin`.

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

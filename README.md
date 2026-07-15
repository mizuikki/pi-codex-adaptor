# pi-codex-adaptor

`pi-codex-adaptor` is a Pi extension that will adapt the public OpenAI Codex `0.144.3`
protocol and selected runtime modules without running a second agent inside Pi.

The repository is under active implementation. Protocol v1, the native baseline handshake, official
Responses SSE/WebSocket transport with connect fallback, compact endpoint, and exact model metadata
resolution are implemented. The versioned configuration store, approval-gated Unified Exec sessions,
and `/codex` settings overlay are available. The extension replaces only Pi's `openai-codex` stream
handler with the native bridge adapter, activates the generated update-plan and model-resolved shell
surface without removing third-party tools, executes approval-gated patches through the official
parser, supports workspace image inspection, and restores process ownership on session shutdown.
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

## Planned installation

```sh
pi install npm:pi-codex-adaptor
```

The product contract, security boundary, and upstream source pin are documented in
[`PRODUCT_CONTRACT.md`](./PRODUCT_CONTRACT.md) and
[`docs/official-baseline.md`](./docs/official-baseline.md).
Capabilities outside the first release are tracked in
[`docs/remaining-gaps.md`](./docs/remaining-gaps.md).

## License

Project-owned source is licensed under Apache-2.0. Vendored OpenAI Codex source will retain its
upstream notices and provenance.

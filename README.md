# pi-codex-adaptor

`pi-codex-adaptor` is a Pi extension that will adapt the public OpenAI Codex `0.144.3`
protocol and selected runtime modules without running a second agent inside Pi.

The repository is currently an implementation skeleton. It does not yet provide a working Codex
transport or tool runtime and has not been published to npm.

## Development

The pinned development toolchain is Bun `1.3.14`, Node.js `24.18.0`, TypeScript `7.0.2`, and Rust
`1.95.0`.

```sh
bun ci
bun run check
```

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

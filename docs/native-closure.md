# Native Official Closure

## Selected source

The production wire boundary is built from 18 official package surfaces at OpenAI Codex `0.144.3`:

| Package | Role |
| --- | --- |
| `codex-api` | Responses, Compact, Models, Images, and Search typed clients |
| `codex-client` | Retry policy, telemetry contract, and request transport |
| `codex-http-client` | Proxy-aware HTTP and streaming transport |
| `codex-websocket-client` | Proxy-aware WebSocket transport |
| `codex-protocol` | `ResponseItem`, model metadata, configuration, and event types |
| `codex-tools` P0 modules | Function, namespace, freeform, hosted web, and JSON Schema builders |
| selected core P0 specs | Exact update-plan, apply-patch, shell, hosted-web, and view-image tool builders without core runtime |
| selected apply-patch modules | Official parser, streaming parser, and fuzzy context matcher behind a workspace-scoped filesystem adapter |
| selected image-generation contract | Official namespace description paired with the typed Images client and a narrow executor |
| 12 internal support crates | Exact path dependencies required by the official wire and PTY crates |

The source tree differs only by the replayable patch recorded below. Generated wrapper manifests under `native/official` compile the
allowlisted source using its original crate names and dependency declarations while excluding
upstream test-only workspace dependencies. The project-owned `codex-tools` wrapper selects only the
official P0 builder modules and dependency-light core spec modules; it does not compile code
mode, connectors, plugin installation, tool discovery, PTY execution, or complete core runtime
modules. This selection changes no official tool name, schema, serializer, or wire type.

## Exclusions

Complete core, app-server, login, and exec-server crates are not selected. No account lifecycle,
subscription usage, rate-limit UI, or reset-credit handler is reachable from the bridge. Rate-limit
events present in official API response types are consumed and discarded at the native boundary;
they have no bridge envelope or TypeScript domain type.

## Reproducibility

`UPSTREAM_CODEX.toml` records the annotated tag object, peeled commit, vendor tree hash, allowlist
manifest hash, license inventory hash, SBOM hash, and patch list. Every one of the 257 allowlisted
files records both its upstream and vendored SHA-256. The single replayable adapter patch adds
`Deserialize` to official Responses request types so the bridge can validate the same typed request
for SSE and WebSocket transports; it changes no field or serialization behavior.

`scripts/sync-codex-upstream.ts --sync` fetches only the pinned annotated tag into an isolated
temporary repository and reconstructs the vendor tree without reading a developer checkout.
`scripts/generate-official-workspace.ts --check` proves that wrapper manifests still match the
official crate dependency tables. `scripts/generate-native-sbom.ts --check` proves that the committed
SBOM matches the locked bridge dependency graph. `scripts/generate-official-fixtures.ts --check`
starts the real bridge and verifies the committed official core-tool contracts.

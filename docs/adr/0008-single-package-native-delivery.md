# ADR 0008: Single-package Native Delivery

- Status: Accepted
- Date: 2026-07-14

## Context

The extension must work after installation without a first-run compiler or binary download. Native
artifacts must also remain traceable to one source revision and official Codex baseline.

## Decision

Ship one npm package containing one `codex-bridge` executable for every declared supported target.
Build all executables in the current release workflow run, attest them, and assemble them in a staging
directory. Do not commit generated binaries to source branches.

Only targets with native build, handshake, transport, tool, and installation smoke coverage enter the
package's supported target manifest.

## Consequences

- Installation is offline after npm retrieves the package.
- Release jobs cannot reuse an artifact from another workflow run or guess a latest successful build.
- Platform-specific npm packages remain a future optimization requiring measured size or duration
  evidence and a new ADR.

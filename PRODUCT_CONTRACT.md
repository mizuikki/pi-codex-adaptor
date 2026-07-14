# Product Contract

## Baseline

The production baseline is OpenAI Codex `0.144.3`, tag `rust-v0.144.3`, peeled source commit
`78ad6e6bfd1d3b6a209acd3ef82172a96b25179c`, and Rust `1.95.0`. A native bridge handshake must
report these values together with bridge protocol version `1`, its build target, build source commit,
and capabilities. A mismatch is fatal.

## Product boundary

Pi owns sessions, model selection, tool dispatch, approvals, persistence, and the terminal UI. This
package adapts supported OpenAI Codex provider models to selected public Codex runtime contracts. Its
single production child process is `codex-bridge`; it never starts Codex CLI, Codex SDK, or app-server
as a second agent.

The first stable release will provide:

- official Responses SSE and WebSocket transport, retry behavior, replay, and compaction through the
  vendored native modules;
- `update_plan` on every supported activation;
- the official shell resolver and its `exec_command`/`write_stdin` or `shell_command` surface;
- `apply_patch`, `view_image`, and `image_gen.imagegen` when their official capabilities resolve;
- standalone `web.run` or hosted `web_search`, selected by provider capability;
- Pi approvals before native command, patch, filesystem, or network execution;
- one `/codex` settings and diagnostics entry point.

This contract does not promise complete Codex CLI parity. P1 and P2 capabilities are tracked in
[`docs/remaining-gaps.md`](./docs/remaining-gaps.md) and require explicit contract additions.

## Non-goals

- Compatibility with arbitrary Responses-compatible providers.
- Subscription usage, rate-limit windows, reset credit, account management, or Codex agent lifecycle.

## Protocol and errors

Bridge protocol v1 is newline-delimited JSON with bounded frames and request IDs. It will define
handshake, request, stream event, cancellation, session write/resize/terminate, result, error, and
backpressure envelopes. Unknown events are retained for safe diagnostics and never imply successful
termination.

Terminal states are `completed`, `incomplete`, `failed`, `aborted`, and `timed_out`. Public error
categories are `ConfigurationError`, `AuthenticationError`, `ProtocolError`, `CapabilityError`, and
`NativeToolError`. Safe diagnostics retain causes without exposing secrets or user content.

## Privacy and authorization

Credentials enter the bridge only through bounded stdin initialization or authentication update
frames. They must not appear in argv, configuration files, logs, snapshots, errors, or diagnostics.
Prompts, messages, headers, opaque compaction items, and absolute user paths are excluded from default
diagnostics. Native operations wait for an explicit Pi approval decision and workspace policy result.

## Configuration

The only supported configuration location is `~/.pi/agent/pi-codex-adaptor.json`. It accepts this
project's `schemaVersion: 1` model only and does not read Codex `config.toml`. Invalid existing files
are preserved rather than guessed or overwritten.

The new-install default is:

```json
{
  "schemaVersion": 1,
  "tools": {
    "backgroundSessions": true,
    "optional": {
      "viewImage": "auto",
      "imageGeneration": "auto"
    }
  },
  "openai": {
    "serviceTier": "default",
    "verbosity": "low",
    "transport": { "mode": "auto" },
    "webSearch": { "mode": "cached" },
    "compaction": {
      "mode": "auto",
      "autoCompactTokenLimit": "model"
    }
  },
  "ui": {
    "status": true
  }
}
```

Shell and web tool surfaces are resolver outputs, not user-forced configuration. Optional image tools
accept only `auto | off`; transport accepts `auto | sse`; compaction accepts `off` or `auto` with a
model threshold or a positive integer below the model context window.

## Current implementation status

The `0.0.0` repository skeleton establishes boundaries, toolchains, packaging, and verification. It
does not yet claim the runtime capabilities listed above. The first prerelease is `0.1.0-rc.0`.

# Product Contract

## Baseline

The production baseline is OpenAI Codex `0.144.3`, tag `rust-v0.144.3`, peeled source commit
`78ad6e6bfd1d3b6a209acd3ef82172a96b25179c`, and Rust `1.95.0`. A native bridge handshake must
report these values together with bridge protocol version `3`, its build target, build source commit,
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
- the official primary shell resolver plus native managed sessions: shell-command models retain
  `shell_command` and receive the pinned `exec_command`/`write_stdin` contracts as a supplemental
  surface when background sessions are enabled;
- `apply_patch`, `view_image`, and `image_gen.imagegen` when their official capabilities resolve;
- standalone `web.run` or hosted `web_search`, selected by provider capability;
- Pi interactive approval before native command, patch, filesystem, image, network, or non-empty
  session stdin execution in prompt mode, with an explicit Pi-owned per-request bypass option;
- one `/codex` settings and diagnostics entry point.

## Interrupted tool-call continuation

When an active Pi branch contains a completed assistant tool call without its matching persisted
result, the adaptor adds one request-local error output before the next provider turn:

```text
Tool result was not recorded. The tool may have partially executed; inspect state before retrying.
```

The result is rebuilt only for provider projection. Pi remains the sole owner of session persistence,
and the adaptor never writes this result to the session, re-executes the interrupted tool, or assumes
that the tool had no side effects. Complete call/result histories retain their existing structured
provider input without an additional output.

## Compaction ownership

Automatic compaction is inline automatic compaction owned by the adaptor's
`before_provider_request` hook. When the active request is known to be over the configured threshold,
the hook performs one native compact operation, appends an opaque checkpoint as a Pi `CustomEntry`,
and returns the rewritten provider payload to the same run. It does not abort the run, call
`ctx.compact()`, add a turn, or send a continuation message. A repeated request with the same active
branch reuses the checkpoint instead of compacting the same input again.

Manual Pi compaction remains Pi-owned. The adaptor supplies a fixed shim summary and provider-bound
version `2` details to Pi's real `CompactionEntry`; recognized legacy version `1` details are retained
for safe recognition but never replayed. Automatic and manual checkpoints retain the complete opaque
typed `ResponseItem` projection returned by protocol `3`, including the exact non-empty encrypted
string. The adaptor never decrypts or converts that content to prose.

Replay requires the active branch, session, provider, base URL, API, model, and authentication binding
to match. Only an official JWT account claim is refresh-stable; other bearer credentials bind to their
exact credential fingerprint. Unsupported or ambiguous state fails closed rather than sending a
reconstructed plaintext request.

This contract does not promise complete Codex CLI parity. P1 and P2 capabilities are tracked in
[`docs/remaining-gaps.md`](./docs/remaining-gaps.md) and require explicit contract additions.

## Non-goals

- Compatibility with arbitrary Responses-compatible providers.
- Subscription usage, rate-limit windows, reset credit, account management, or Codex agent lifecycle.

## Protocol and errors

Bridge protocol v3 is newline-delimited JSON with bounded frames and request IDs. It defines
handshake, request, stream event, cancellation, session write/resize/terminate, result, error, and
backpressure envelopes. Unknown events are retained for safe diagnostics and never imply successful
termination. The normative envelope contract and limits are documented in
[`docs/bridge-protocol.md`](./docs/bridge-protocol.md).

Terminal states are `completed`, `incomplete`, `failed`, `aborted`, and `timed_out`. Public error
categories are `ConfigurationError`, `AuthenticationError`, `ProtocolError`, `CapabilityError`, and
`NativeToolError`. Safe diagnostics retain causes without exposing secrets or user content.

## Privacy and authorization

Credentials enter the bridge only through bounded, request-scoped provider connections. They must not
appear in argv, configuration files, logs, snapshots, errors, or diagnostics.
Prompts, messages, headers, opaque compaction items, and absolute user paths are excluded from default
diagnostics. `prompt` is the safe default: native operations wait for an explicit Pi approval decision
and workspace policy result. `bypass` is explicit Pi-owned per-request preauthorization for the fixed
native allowlist; it is not an OS sandbox. Native commands run with the user's permissions, and
workspace roots do not sandbox shell behavior. Validation, workspace containment, cancellation, and
side-effect ordering remain native responsibilities in both modes.

## Configuration

The only supported configuration location is `~/.pi/agent/pi-codex-adaptor.json`. It accepts this
project's `schemaVersion: 2` model only and does not read Codex `config.toml`. Invalid existing files
are preserved rather than guessed or overwritten.

The new-install default is:

```json
{
  "schemaVersion": 2,
  "activation": {
    "providers": ["openai-codex"]
  },
  "tools": {
    "backgroundSessions": true,
    "optional": {
      "viewImage": "auto",
      "imageGeneration": "auto"
    }
  },
  "security": {
    "approvalPolicy": "prompt"
  },
  "codex": {
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
model threshold or a positive integer below the model context window. `backgroundSessions` enables
managed retention for Unified Exec and supplements shell-command models with the pinned
`exec_command` and `write_stdin` contracts. Disabling it removes the supplemental tools and causes a
Unified Exec process still running after its initial yield to terminate instead of being retained.

## Current implementation status

The package version is `0.0.0` and has not been published. The worktree defines and tests protocol v3
envelopes, the baseline handshake, concurrent request correlation, cancellation, bounded event
backpressure, and safe process shutdown. The bridge compiles and links the pinned official wire
modules and advertises Responses SSE/WebSocket, the Compact endpoint, RemoteCompactionV2, model
metadata, update-plan, hosted and standalone web, Unified Exec, shell-command, apply-patch,
view-image, and image generation capabilities. It resolves the official tool contracts, including
hidden unified-exec fallback dispatch, and supports either prompt approval or explicit per-request
preauthorization for command, patch, filesystem, image, and network work. Separately, canonical workspace roots constrain command working
directories, patch targets, viewed images, and referenced image-generation inputs. Unified Exec
pipe/PTY sessions support bounded polling, prompt-approved or preauthorized non-empty stdin writes, resize,
termination, cancellation, and shutdown cleanup. Pi activation is reversible, preserves additive
external tools, and suppresses Pi core tools while the Codex provider is active. A pending or unavailable
activated Codex profile fails closed without restoring Pi core tools; deactivation restores only the
Pi core selection captured before activation. It implements inline automatic compaction, manual Pi
compaction, opaque checkpoints, and provider-bound replay without client-side decryption, and renders
compact tool state inline. Both Responses API registrations use process-stable functions that route by Pi's
session identifier to exactly one session-local activation, profile, compaction, capability, fallback,
and runtime owner. Nested adaptor loads cannot replace another session's dispatcher; missing or
ambiguous attribution fails locally without a provider call.
`/codex` exposes settings, manual compaction, and a confirmed, redacted diagnostics export. Remaining
release gates, including Trusted Publishing and a published prerelease, are not complete. The planned
first prerelease version is `0.1.0-rc.0`.

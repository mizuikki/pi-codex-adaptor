# Remote Compaction Conformance

Date: 2026-07-29

Normative source: OpenAI Codex `0.146.0`, peeled commit
`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`.

Source files:

- [`compact_remote.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/compact_remote.rs)
- [`compact_remote_request.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/compact_remote_request.rs)
- [`responses_retry.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/responses_retry.rs)
- [`util.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/util.rs)
- [`turn_context.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/core/src/session/turn_context.rs)
- [`compact.rs`](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/codex-api/src/endpoint/compact.rs)

The source was inspected with `git show` at the peeled commit. The bridge adapter preserves the
official endpoint selection and response contract while owning the bridge-specific request envelope.

| Contract | Pinned source | Adaptor/native evidence |
| --- | --- | --- |
| Remote V2 is selected before the operation and is not replaced by the classic endpoint after a failure. | `compact_remote.rs:112-160`; `compact.rs:39-69` | `src/application/resolve-effective-capabilities.ts` selects `remote_v2` or `compact_endpoint` once; `native/crates/codex-bridge/src/runtime.rs:3982-4012` dispatches the selected implementation. |
| Remote V2 allows the initial stream plus at most two stream retries. | `compact_remote.rs:181-213`; `responses_retry.rs:48-73` | `native/crates/codex-bridge/src/runtime.rs:4088-4131`; `remote_v2_caps_stream_retries_at_two_even_when_provider_allows_more` at `runtime.rs:5260-5296`. |
| Retryable open and mid-stream failures retry; non-retryable failures do not. | `compact_remote_request.rs:30-101`; `responses_retry.rs:20-73` | `runtime.rs:4088-4131` classifies and retries only retryable failures. |
| Server retry delay wins; otherwise backoff starts at 200 ms, doubles, and uses 0.9-1.1 jitter. | `responses_retry.rs:48-52`; `util.rs:86-90` | `runtime.rs:4212-4248`; `remote_v2_backoff_uses_the_official_jitter_window` at `runtime.rs:5299-5305`. |
| Cancellation interrupts retry backoff. | `responses_retry.rs:48-70` delegates the delay to the native request loop; the pinned backoff is native-owned. | `runtime.rs:4218-4226`; `remote_v2_cancellation_interrupts_retry_backoff` at `runtime.rs:5307-5333`. |
| Transport fallback is one-way from WebSocket to SSE. | `responses_retry.rs:31-46` switches transport after the retry budget. | `runtime.rs:4227-4238`; `remote_v2_falls_back_to_sse_after_websocket_connect_failure` at `runtime.rs:5190-5230`. |
| Each retry rebuilds the stream from the same request snapshot. | `compact_remote_request.rs:77-96` reuses the typed prompt for each attempt. | `runtime.rs:4092-4101` retains an owned typed request and sends `request.clone()` for each attempt. |
| The effective request context is the resolved context window multiplied by the model's effective percentage. | `turn_context.rs:220-226` | `native/crates/codex-bridge/src/compaction_context_fit.rs:49-62` derives the same limit from bundled model metadata; the native test covers 272,000 x 95% = 258,400 and the 90% auto threshold. |
| Trailing function/custom tool outputs are replaced with the bounded context-exceeded message, while tool-search outputs clear their tools and preserve metadata. | `compact_remote.rs:365-466` | `native/crates/codex-bridge/src/compaction_context_fit.rs:64-168`; focused helper tests cover identity, success state, and metadata preservation. |
| A completed response is required and unrelated output items are tolerated. | `compact_remote.rs:200-284` ignores unrelated output, requires `response.completed`, and counts compaction items. | `runtime.rs:4134-4209`; `remote_v2_retries_midstream_with_server_delay_and_accepts_unrelated_output` at `runtime.rs:5225-5270`. |
| Exactly one compaction item is required. | `compact_remote.rs:260-284` | `runtime.rs:4186-4200`; the native test asserts one retained compaction item. TypeScript also validates the returned structured output in `src/application/compaction.ts:198-212`. |
| Remote V2 retains only the official message shape before the compaction item and applies the bounded retained-message budget. | `compact_remote.rs:500-565` | `native/crates/codex-bridge/src/remote_compaction_v2.rs:7-21` and its unit tests. |
| Classic compaction uses the official `CompactClient` endpoint and provider retry configuration. | `compact.rs:18-80` | `runtime.rs:4013-4043` constructs `CompactClient`; `native/crates/codex-bridge/src/api.rs:87-123` sets the provider retry configuration. |

Focused native verification passed:

```sh
cargo test --manifest-path native/Cargo.toml -p codex-bridge
cargo fmt --manifest-path native/Cargo.toml --all -- --check
```

The test suite completed 119 tests. The bridge protocol and adaptor tests additionally verify that
mixed v5/v6 startup is rejected before provider registration, while the clean-slate search check
rejects removed portable-summary identifiers in production source.

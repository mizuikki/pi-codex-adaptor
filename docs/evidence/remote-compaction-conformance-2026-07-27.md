# Remote Compaction Conformance

Date: 2026-07-27

Normative source: OpenAI Codex `0.144.3`, peeled commit
`78ad6e6bfd1d3b6a209acd3ef82172a96b25179c`.

Source files:

- [`compact_remote_v2.rs`](https://github.com/openai/codex/blob/78ad6e6bfd1d3b6a209acd3ef82172a96b25179c/codex-rs/core/src/compact_remote_v2.rs)
- [`responses_retry.rs`](https://github.com/openai/codex/blob/78ad6e6bfd1d3b6a209acd3ef82172a96b25179c/codex-rs/core/src/responses_retry.rs)
- [`util.rs`](https://github.com/openai/codex/blob/78ad6e6bfd1d3b6a209acd3ef82172a96b25179c/codex-rs/core/src/util.rs)
- [`compact.rs`](https://github.com/openai/codex/blob/78ad6e6bfd1d3b6a209acd3ef82172a96b25179c/codex-rs/codex-api/src/endpoint/compact.rs)

The source was inspected with `git show` at the peeled commit. The bridge adapter preserves the
official endpoint selection and response contract while owning the bridge-specific request envelope.

| Contract | Pinned source | Adaptor/native evidence |
| --- | --- | --- |
| Remote V2 is selected before the operation and is not replaced by the classic endpoint after a failure. | `compact_remote_v2.rs:330-378`; `compact.rs:39-69` | `src/application/resolve-effective-capabilities.ts` selects `remote_v2` or `compact_endpoint` once; `native/crates/codex-bridge/src/runtime.rs:3900-3924` dispatches the selected implementation. |
| Remote V2 allows the initial stream plus at most two stream retries. | `compact_remote_v2.rs:337-342` | `native/crates/codex-bridge/src/runtime.rs:3999-4001`; `remote_v2_caps_stream_retries_at_two_even_when_provider_allows_more` at `runtime.rs:5055-5091`. |
| Retryable open and mid-stream failures retry; non-retryable failures do not. | `compact_remote_v2.rs:343-377`; `responses_retry.rs:22-78` | `runtime.rs:4001-4058` and `runtime.rs:4139-4170` classify and retry only retryable failures. |
| Server retry delay wins; otherwise backoff starts at 200 ms, doubles, and uses 0.9-1.1 jitter. | `responses_retry.rs:48-55`; `util.rs:85-90` | `runtime.rs:4149-4157` and `runtime.rs:4172-4177`; `remote_v2_backoff_uses_the_official_jitter_window` at `runtime.rs:5094-5100`. |
| Cancellation interrupts retry backoff. | `responses_retry.rs:48-75` delegates the delay to the native request loop; the pinned backoff is native-owned. | `runtime.rs:4154-4157`; `remote_v2_cancellation_interrupts_retry_backoff` at `runtime.rs:5102-5128`. |
| Transport fallback is one-way from WebSocket to SSE. | `responses_retry.rs:31-46` switches transport after the retry budget. | `runtime.rs:3755-3780` and `runtime.rs:4158-4166`; `remote_v2_falls_back_to_sse_after_websocket_connect_failure` at `runtime.rs:5011-5053`. |
| Each retry rebuilds the stream from the same request snapshot. | `compact_remote_v2.rs:343-357` re-enters `client_session.stream` with the same typed prompt. | `runtime.rs:3970-4012` retains an owned typed request and sends `request.clone()` for each attempt. |
| A completed response is required and unrelated output items are tolerated. | `compact_remote_v2.rs:380-428` ignores unrelated output, requires `response.completed`, and counts compaction items. | `runtime.rs:4061-4136`; `remote_v2_retries_midstream_with_server_delay_and_accepts_unrelated_output` at `runtime.rs:4955-5009`. |
| Exactly one compaction item is required. | `compact_remote_v2.rs:415-427` | `runtime.rs:4113-4122`; the native test asserts one retained compaction item. TypeScript also validates the returned structured output in `src/application/compaction.ts:198-212`. |
| Remote V2 retains only the official message shape before the compaction item and applies the bounded retained-message budget. | `compact_remote_v2.rs:430-493` | `native/crates/codex-bridge/src/remote_compaction_v2.rs:7-21` and its unit tests. |
| Classic compaction uses the official `CompactClient` endpoint and provider retry configuration. | `compact.rs:18-80` | `runtime.rs:3925-3958` constructs `CompactClient`; `native/crates/codex-bridge/src/api.rs:87-123` sets the provider retry configuration. |

Focused native verification passed:

```sh
cargo test --manifest-path native/Cargo.toml -p codex-bridge
cargo fmt --manifest-path native/Cargo.toml --all -- --check
```

The test suite completed 108 tests. The bridge protocol and adaptor tests additionally verify that
mixed v5/v6 startup is rejected before provider registration, while the clean-slate search check
rejects removed portable-summary identifiers in production source.

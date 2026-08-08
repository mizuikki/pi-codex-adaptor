use bridge_protocol::BridgeError;
use bridge_protocol::ErrorCategory;
use codex_api::Reasoning;
use codex_api::ResponsesApiTools;
use codex_api::TextControls;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelInfo;
use codex_utils_output_truncation::approx_tokens_from_byte_count;
use serde::Deserialize;

const CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE: &str =
    "Output exceeded the available model context and was truncated";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CompactionTokenEstimates {
    utf8_bytes: u64,
    utf16_code_units: u64,
}

impl CompactionTokenEstimates {
    fn fits(self, limit: u64) -> bool {
        self.utf8_bytes <= limit || self.utf16_code_units <= limit
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OwnedCompactionInput {
    pub(crate) model: String,
    pub(crate) input: Vec<ResponseItem>,
    #[serde(default)]
    pub(crate) instructions: String,
    pub(crate) tools: Option<ResponsesApiTools>,
    pub(crate) parallel_tool_calls: bool,
    pub(crate) reasoning: Option<Reasoning>,
    pub(crate) service_tier: Option<String>,
    pub(crate) prompt_cache_key: Option<String>,
    pub(crate) text: Option<TextControls>,
}

/// Remote compaction is a standalone request boundary. Its history is fitted against the
/// model's full context window, independently of the effective inference percentage used by
/// ordinary turns.
pub(crate) fn compaction_context_window_limit(model: &ModelInfo) -> Option<u64> {
    u64::try_from(model.resolved_context_window()?).ok()
}

pub(crate) fn fit_compaction_input(
    request: &mut OwnedCompactionInput,
    model: &ModelInfo,
) -> Result<(), BridgeError> {
    let Some(limit) = compaction_context_window_limit(model) else {
        return Ok(());
    };
    let mut estimates = estimate_compaction_request_tokens(request);
    if estimates.fits(limit) {
        return Ok(());
    }

    for index in (0..request.input.len()).rev() {
        if estimates.fits(limit) {
            break;
        }
        let Some(rewritten) = rewritten_output_for_context_window(&request.input[index]) else {
            break;
        };
        request.input[index] = rewritten;
        estimates = estimate_compaction_request_tokens(request);
    }

    if !estimates.fits(limit) {
        return Err(compaction_context_limit_exceeded());
    }
    Ok(())
}

fn estimate_compaction_request_tokens(request: &OwnedCompactionInput) -> CompactionTokenEstimates {
    // Match upstream's compaction preflight: count only model-visible history and base
    // instructions. Request envelope fields (model, tools, stream flags, etc.) are not part of
    // the history window and must not consume the standalone compaction input budget. Keep both
    // UTF-8 and UTF-16 estimates because the provider accepts either representation's limit.
    let serialized = serde_json::to_vec(&(&request.instructions, &request.input));
    serialized.map_or(
        CompactionTokenEstimates {
            utf8_bytes: u64::MAX,
            utf16_code_units: u64::MAX,
        },
        |bytes| {
            let utf8_bytes = u64::try_from(
                crate::context_estimator::estimate_items(&request.input).saturating_add(
                    crate::context_estimator::estimate_instructions(&request.instructions),
                ),
            )
            .unwrap_or(u64::MAX);
            let utf16_code_units = std::str::from_utf8(&bytes).map_or(u64::MAX, |value| {
                approx_tokens_from_byte_count(value.encode_utf16().count())
            });
            CompactionTokenEstimates {
                utf8_bytes,
                utf16_code_units,
            }
        },
    )
}

fn rewritten_output_for_context_window(item: &ResponseItem) -> Option<ResponseItem> {
    Some(match item {
        ResponseItem::FunctionCallOutput {
            id,
            call_id,
            output,
            internal_chat_message_metadata_passthrough: metadata,
        } => ResponseItem::FunctionCallOutput {
            id: id.clone(),
            call_id: call_id.clone(),
            output: truncated_output_payload(output),
            internal_chat_message_metadata_passthrough: metadata.clone(),
        },
        ResponseItem::CustomToolCallOutput {
            id,
            call_id,
            name,
            output,
            internal_chat_message_metadata_passthrough: metadata,
        } => ResponseItem::CustomToolCallOutput {
            id: id.clone(),
            call_id: call_id.clone(),
            name: name.clone(),
            output: truncated_output_payload(output),
            internal_chat_message_metadata_passthrough: metadata.clone(),
        },
        ResponseItem::ToolSearchOutput {
            id,
            call_id,
            status,
            execution,
            internal_chat_message_metadata_passthrough: metadata,
            ..
        } => ResponseItem::ToolSearchOutput {
            id: id.clone(),
            call_id: call_id.clone(),
            status: status.clone(),
            execution: execution.clone(),
            tools: Vec::new(),
            internal_chat_message_metadata_passthrough: metadata.clone(),
        },
        _ => return None,
    })
}

fn truncated_output_payload(output: &FunctionCallOutputPayload) -> FunctionCallOutputPayload {
    FunctionCallOutputPayload {
        body: FunctionCallOutputBody::Text(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE.to_owned()),
        success: output.success,
    }
}

fn compaction_context_limit_exceeded() -> BridgeError {
    BridgeError {
        category: ErrorCategory::CapabilityError,
        code: "compaction_context_limit_exceeded".to_owned(),
        message: "the compaction request exceeded the local model context limit".to_owned(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::ResponseItemId;
    use codex_protocol::models::InternalChatMessageMetadataPassthrough;

    fn fixture_model(context_window: i64, effective_percent: i64) -> ModelInfo {
        let mut model = crate::models::resolve_model("gpt-5.6-sol");
        model.context_window = Some(context_window);
        model.max_context_window = Some(context_window);
        model.effective_context_window_percent = effective_percent;
        model
    }

    fn request(input: Vec<ResponseItem>) -> OwnedCompactionInput {
        OwnedCompactionInput {
            model: "gpt-5.6-sol".to_owned(),
            input,
            instructions: String::new(),
            tools: None,
            parallel_tool_calls: true,
            reasoning: None,
            service_tier: None,
            prompt_cache_key: None,
            text: None,
        }
    }

    fn function_output(text: String) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: Some(ResponseItemId::from_server("output-id".to_owned())),
            call_id: "call-id".to_owned(),
            output: FunctionCallOutputPayload {
                body: FunctionCallOutputBody::Text(text),
                success: Some(false),
            },
            internal_chat_message_metadata_passthrough: Some(
                InternalChatMessageMetadataPassthrough {
                    turn_id: Some("turn-id".to_owned()),
                },
            ),
        }
    }

    #[test]
    fn derives_full_compaction_limit_independently_from_inference_threshold() {
        let model = fixture_model(272_000, 95);

        assert_eq!(compaction_context_window_limit(&model), Some(272_000));
        assert_eq!(model.auto_compact_token_limit(), Some(244_800));
    }

    #[test]
    fn leaves_an_already_fitting_request_unchanged() {
        let model = fixture_model(1_000, 95);
        let mut request = request(vec![ResponseItem::Message {
            id: None,
            role: "user".to_owned(),
            content: vec![codex_protocol::models::ContentItem::InputText {
                text: "small".to_owned(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }]);
        let original = serde_json::to_value(&request.input).expect("fixture input should encode");

        fit_compaction_input(&mut request, &model).expect("fitting input should succeed");

        assert_eq!(
            serde_json::to_value(request.input).expect("input should encode"),
            original
        );
    }

    #[test]
    fn allows_history_between_effective_and_full_context_limits() {
        let model = fixture_model(1_300, 50);
        let mut request = request(vec![function_output("x".repeat(3_000))]);
        let original = request.input.clone();
        let estimates = estimate_compaction_request_tokens(&request);

        assert!(estimates.utf8_bytes > 650);
        assert!(estimates.utf8_bytes <= 1_300);

        fit_compaction_input(&mut request, &model).expect("ambiguous input should reach upstream");

        assert_eq!(request.input, original);
    }

    #[test]
    fn rewrites_eligible_trailing_outputs_and_preserves_metadata() {
        let model = fixture_model(1_000, 50);
        let mut request = request(vec![function_output("x".repeat(6_000))]);

        fit_compaction_input(&mut request, &model).expect("eligible output should be rewritten");

        let ResponseItem::FunctionCallOutput {
            id,
            call_id,
            output,
            internal_chat_message_metadata_passthrough,
        } = &request.input[0]
        else {
            panic!("expected function output");
        };
        assert_eq!(id.as_deref(), Some("output-id"));
        assert_eq!(call_id, "call-id");
        assert_eq!(output.success, Some(false));
        assert_eq!(
            output.body,
            FunctionCallOutputBody::Text(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE.to_owned())
        );
        assert_eq!(
            internal_chat_message_metadata_passthrough
                .as_ref()
                .and_then(|metadata| metadata.turn_id.as_deref()),
            Some("turn-id")
        );
        assert!(estimate_compaction_request_tokens(&request).fits(500));
    }

    #[test]
    fn rewrites_custom_and_tool_search_outputs_with_their_contract_fields() {
        let model = fixture_model(1_000, 50);
        let mut request = request(vec![
            ResponseItem::CustomToolCallOutput {
                id: Some(ResponseItemId::from_server("custom-output-id".to_owned())),
                call_id: "custom-call-id".to_owned(),
                name: Some("fixture-tool".to_owned()),
                output: FunctionCallOutputPayload::from_text("x".repeat(6_000)),
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::ToolSearchOutput {
                id: Some(ResponseItemId::from_server("search-output-id".to_owned())),
                call_id: Some("search-call-id".to_owned()),
                status: "completed".to_owned(),
                execution: "server".to_owned(),
                tools: vec![serde_json::json!({"name": "fixture-tool"})],
                internal_chat_message_metadata_passthrough: None,
            },
        ]);

        fit_compaction_input(&mut request, &model).expect("eligible outputs should be rewritten");

        let ResponseItem::CustomToolCallOutput { output, .. } = &request.input[0] else {
            panic!("expected custom output");
        };
        assert_eq!(
            output.body,
            FunctionCallOutputBody::Text(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE.to_owned())
        );
        let ResponseItem::ToolSearchOutput {
            id,
            call_id,
            status,
            execution,
            tools,
            ..
        } = &request.input[1]
        else {
            panic!("expected tool search output");
        };
        assert_eq!(id.as_deref(), Some("search-output-id"));
        assert_eq!(call_id.as_deref(), Some("search-call-id"));
        assert_eq!(status, "completed");
        assert_eq!(execution, "server");
        assert!(tools.is_empty());
    }

    #[test]
    fn stops_at_non_eligible_history_and_returns_a_bounded_error() {
        let model = fixture_model(200, 50);
        let original = function_output("x".repeat(2_000));
        let mut request = request(vec![
            original.clone(),
            ResponseItem::Message {
                id: None,
                role: "user".to_owned(),
                content: vec![codex_protocol::models::ContentItem::InputText {
                    text: "boundary".to_owned(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
        ]);

        let error = fit_compaction_input(&mut request, &model).expect_err("history should not fit");

        assert_eq!(error.code, "compaction_context_limit_exceeded");
        assert!(!error.retryable);
        assert_eq!(
            error.message,
            "the compaction request exceeded the local model context limit"
        );
        assert_eq!(request.input[0], original);
    }
}

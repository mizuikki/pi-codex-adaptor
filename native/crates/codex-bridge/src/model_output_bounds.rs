use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelInfo;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::approx_token_count;
use codex_utils_output_truncation::truncate_function_output_items_with_policy;
use codex_utils_output_truncation::truncate_text;

const OUTPUT_MARKER_RESERVE: usize = 128;

/// Bound every model-visible tool result, then share one content budget across the latest batch.
pub(crate) fn bound_model_output_items(input: &mut [ResponseItem], model: &ModelInfo) {
    let policy = TruncationPolicy::from(model.truncation_policy) * 1.2;
    for item in input.iter_mut() {
        if let Some(output) = output_payload_mut(item) {
            *output = truncate_output_payload(output, policy);
        }
    }

    let trailing_start = input
        .iter()
        .rposition(|item| output_payload(item).is_none())
        .map_or(0, |index| index.saturating_add(1));
    let mut remaining = policy_limit(policy);
    for item in &mut input[trailing_start..] {
        let Some(output) = output_payload_mut(item) else {
            continue;
        };
        let cost = output_content_cost(output, policy);
        if cost <= remaining {
            remaining = remaining.saturating_sub(cost);
            continue;
        }
        *output = truncate_output_payload(output, policy_with_limit(policy, remaining));
        let bounded_cost = output_content_cost(output, policy);
        if bounded_cost > remaining {
            remove_budgeted_content(output);
        }
        remaining = remaining.saturating_sub(output_content_cost(output, policy));
    }
}

pub(crate) fn model_output_token_limit(model: &ModelInfo) -> usize {
    TruncationPolicy::from(model.truncation_policy).token_budget()
}

fn truncate_output_payload(
    output: &FunctionCallOutputPayload,
    policy: TruncationPolicy,
) -> FunctionCallOutputPayload {
    if output_content_cost(output, policy) <= policy_limit(policy) {
        return output.clone();
    }
    let truncation_policy = policy_with_limit(
        policy,
        policy_limit(policy).saturating_sub(OUTPUT_MARKER_RESERVE),
    );
    let body = match &output.body {
        FunctionCallOutputBody::Text(content) => {
            FunctionCallOutputBody::Text(truncate_text(content, truncation_policy))
        }
        FunctionCallOutputBody::ContentItems(items) => {
            FunctionCallOutputBody::ContentItems(truncate_function_output_items_with_policy(
                items,
                truncation_policy,
                conservative_audio_tokens,
            ))
        }
    };
    let mut bounded = FunctionCallOutputPayload {
        body,
        success: output.success,
    };
    if output_content_cost(&bounded, policy) > policy_limit(policy) {
        remove_budgeted_content(&mut bounded);
    }
    bounded
}

fn output_content_cost(output: &FunctionCallOutputPayload, policy: TruncationPolicy) -> usize {
    match &output.body {
        FunctionCallOutputBody::Text(content) => content_cost(content, policy),
        FunctionCallOutputBody::ContentItems(items) => items
            .iter()
            .map(|item| match item {
                FunctionCallOutputContentItem::InputText { text } => content_cost(text, policy),
                FunctionCallOutputContentItem::InputAudio { audio_url } => {
                    content_cost(audio_url, policy)
                }
                FunctionCallOutputContentItem::InputImage { .. }
                | FunctionCallOutputContentItem::EncryptedContent { .. } => 0,
            })
            .fold(0usize, usize::saturating_add),
    }
}

fn content_cost(content: &str, policy: TruncationPolicy) -> usize {
    match policy {
        TruncationPolicy::Bytes(_) => content.len(),
        TruncationPolicy::Tokens(_) => approx_token_count(content),
    }
}

fn conservative_audio_tokens(audio_url: &str) -> usize {
    approx_token_count(audio_url)
}

fn policy_limit(policy: TruncationPolicy) -> usize {
    match policy {
        TruncationPolicy::Bytes(bytes) => bytes,
        TruncationPolicy::Tokens(tokens) => tokens,
    }
}

fn policy_with_limit(policy: TruncationPolicy, limit: usize) -> TruncationPolicy {
    match policy {
        TruncationPolicy::Bytes(_) => TruncationPolicy::Bytes(limit),
        TruncationPolicy::Tokens(_) => TruncationPolicy::Tokens(limit),
    }
}

fn remove_budgeted_content(output: &mut FunctionCallOutputPayload) {
    match &mut output.body {
        FunctionCallOutputBody::Text(content) => content.clear(),
        FunctionCallOutputBody::ContentItems(items) => items.retain(|item| {
            matches!(
                item,
                FunctionCallOutputContentItem::InputImage { .. }
                    | FunctionCallOutputContentItem::EncryptedContent { .. }
            )
        }),
    }
}

fn output_payload(item: &ResponseItem) -> Option<&FunctionCallOutputPayload> {
    match item {
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => Some(output),
        _ => None,
    }
}

fn output_payload_mut(item: &mut ResponseItem) -> Option<&mut FunctionCallOutputPayload> {
    match item {
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => Some(output),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::ContentItem;
    use codex_protocol::models::InternalChatMessageMetadataPassthrough;
    use codex_protocol::openai_models::TruncationPolicyConfig;

    fn fixture_model(policy: TruncationPolicyConfig) -> ModelInfo {
        let mut model = crate::models::resolve_model("gpt-5.6-sol");
        model.truncation_policy = policy;
        model
    }

    fn output(text: impl Into<String>, call_id: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: call_id.to_owned(),
            output: FunctionCallOutputPayload {
                body: FunctionCallOutputBody::Text(text.into()),
                success: Some(false),
            },
            internal_chat_message_metadata_passthrough: Some(
                InternalChatMessageMetadataPassthrough {
                    turn_id: Some("turn-id".to_owned()),
                },
            ),
        }
    }

    fn user(text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: "user".to_owned(),
            content: vec![ContentItem::InputText {
                text: text.to_owned(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn model_output_bounds_truncate_each_output_and_preserve_metadata() {
        let model = fixture_model(TruncationPolicyConfig::bytes(512));
        let original = "abcdefghijklmnopqrstuvwxyz".repeat(100);
        let mut input = vec![output(&original, "call-1"), user("next")];

        bound_model_output_items(&mut input, &model);

        let ResponseItem::FunctionCallOutput {
            call_id,
            output,
            internal_chat_message_metadata_passthrough,
            ..
        } = &input[0]
        else {
            panic!("expected function output");
        };
        assert_eq!(call_id, "call-1");
        assert_eq!(output.success, Some(false));
        assert_eq!(
            internal_chat_message_metadata_passthrough
                .as_ref()
                .and_then(|metadata| metadata.turn_id.as_deref()),
            Some("turn-id")
        );
        let FunctionCallOutputBody::Text(text) = &output.body else {
            panic!("expected text output");
        };
        assert_ne!(text, &original);
        assert!(text.len() <= 615);
    }

    #[test]
    fn model_output_bounds_are_idempotent() {
        let model = fixture_model(TruncationPolicyConfig::bytes(512));
        let mut input = vec![
            output("abcdefghijklmnopqrstuvwxyz".repeat(100), "call-1"),
            user("next"),
        ];

        bound_model_output_items(&mut input, &model);
        let once = input.clone();
        bound_model_output_items(&mut input, &model);

        assert_eq!(input, once);
    }

    #[test]
    fn model_output_bounds_apply_token_policy_on_utf8_boundaries() {
        let model = fixture_model(TruncationPolicyConfig::tokens(200));
        let original = "界🙂".repeat(1_000);
        let mut input = vec![output(&original, "call-1")];

        bound_model_output_items(&mut input, &model);

        let Some(output) = output_payload(&input[0]) else {
            panic!("expected output");
        };
        let FunctionCallOutputBody::Text(text) = &output.body else {
            panic!("expected text output");
        };
        assert_ne!(text, &original);
        assert!(approx_token_count(text) <= 240);
    }

    #[test]
    fn trailing_tool_output_batch_shares_one_budget() {
        let model = fixture_model(TruncationPolicyConfig::bytes(10));
        let mut input = vec![
            output("1234567890", "call-1"),
            output("abcdefghij", "call-2"),
        ];

        bound_model_output_items(&mut input, &model);

        let total = input
            .iter()
            .filter_map(output_payload)
            .map(|output| output_content_cost(output, TruncationPolicy::Bytes(12)))
            .sum::<usize>();
        assert!(total <= 12);
        assert!(matches!(input[1], ResponseItem::FunctionCallOutput { .. }));
    }

    #[test]
    fn trailing_tool_output_batch_does_not_rebudget_history() {
        let model = fixture_model(TruncationPolicyConfig::bytes(10));
        let mut input = vec![
            output("1234567890", "old-1"),
            output("abcdefghij", "old-2"),
            user("continue"),
            output("klmnopqrst", "new-1"),
            output("uvwxyz", "new-2"),
        ];

        bound_model_output_items(&mut input, &model);

        let historical_total = input[..2]
            .iter()
            .filter_map(output_payload)
            .map(|output| output_content_cost(output, TruncationPolicy::Bytes(12)))
            .sum::<usize>();
        let trailing_total = input[3..]
            .iter()
            .filter_map(output_payload)
            .map(|output| output_content_cost(output, TruncationPolicy::Bytes(12)))
            .sum::<usize>();
        assert_eq!(historical_total, 20);
        assert!(trailing_total <= 12);
    }

    #[test]
    fn structured_bounds_preserve_image_and_encrypted_content() {
        let model = fixture_model(TruncationPolicyConfig::bytes(8));
        let mut item = output("", "call-1");
        let Some(payload) = output_payload_mut(&mut item) else {
            panic!("expected output");
        };
        payload.body = FunctionCallOutputBody::ContentItems(vec![
            FunctionCallOutputContentItem::InputText {
                text: "oversized text content".to_owned(),
            },
            FunctionCallOutputContentItem::InputAudio {
                audio_url: "data:audio/wav;base64,oversized-audio".to_owned(),
            },
            FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,image".to_owned(),
                detail: None,
            },
            FunctionCallOutputContentItem::EncryptedContent {
                encrypted_content: "opaque".to_owned(),
            },
        ]);
        let mut input = vec![item];

        bound_model_output_items(&mut input, &model);

        let Some(output) = output_payload(&input[0]) else {
            panic!("expected output");
        };
        let FunctionCallOutputBody::ContentItems(items) = &output.body else {
            panic!("expected structured output");
        };
        assert!(
            items
                .iter()
                .any(|item| matches!(item, FunctionCallOutputContentItem::InputImage { .. }))
        );
        assert!(
            items
                .iter()
                .any(|item| matches!(item, FunctionCallOutputContentItem::EncryptedContent { .. }))
        );
        assert!(output_content_cost(output, TruncationPolicy::Bytes(9)) <= 9);
    }

    #[test]
    fn model_output_token_limit_uses_model_metadata() {
        let token_model = fixture_model(TruncationPolicyConfig::tokens(321));
        let byte_model = fixture_model(TruncationPolicyConfig::bytes(400));

        assert_eq!(model_output_token_limit(&token_model), 321);
        assert_eq!(model_output_token_limit(&byte_model), 100);
    }
}

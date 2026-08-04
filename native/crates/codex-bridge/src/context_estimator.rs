use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::ImageDetail;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelInfo;
use codex_utils_output_truncation::approx_bytes_for_tokens;
use codex_utils_output_truncation::approx_token_count;
use codex_utils_output_truncation::approx_tokens_from_byte_count_i64;
use serde::Serialize;

const REASONING_BASE64_OVERHEAD_BYTES: usize = 650;
const RESIZED_IMAGE_BYTES_ESTIMATE: i64 = 7_373;
const ORIGINAL_IMAGE_PATCH_SIZE: i64 = 32;
const ORIGINAL_IMAGE_MAX_PATCHES: i64 = 10_000;

pub(crate) fn estimate_items(items: &[ResponseItem]) -> i64 {
    items
        .iter()
        .map(estimate_item_token_count)
        .fold(0, i64::saturating_add)
}

pub(crate) fn estimate_instructions(instructions: &str) -> i64 {
    i64::try_from(approx_token_count(instructions)).unwrap_or(i64::MAX)
}

pub(crate) fn estimate_suffix_after_last_model_item(
    items: &[ResponseItem],
    minimum_model_generated_index: usize,
) -> Option<i64> {
    let boundary = items
        .iter()
        .enumerate()
        .rev()
        .find(|(index, item)| {
            *index >= minimum_model_generated_index && is_model_generated_item(item)
        })?
        .0;
    Some(estimate_items(&items[boundary.saturating_add(1)..]))
}

pub(crate) fn context_window(model: &ModelInfo) -> i64 {
    model.resolved_context_window().unwrap_or(i64::MAX).max(0)
}

pub(crate) fn auto_compact_token_limit(model: &ModelInfo) -> Option<i64> {
    model.auto_compact_token_limit().filter(|limit| *limit > 0)
}

fn estimate_item_token_count(item: &ResponseItem) -> i64 {
    let bytes = match item {
        ResponseItem::Reasoning {
            encrypted_content: Some(content),
            ..
        }
        | ResponseItem::Compaction {
            encrypted_content: content,
            ..
        }
        | ResponseItem::ContextCompaction {
            encrypted_content: Some(content),
            ..
        } => estimate_reasoning_length(content.len()),
        item => estimate_serialized_model_visible_bytes(item),
    };
    approx_tokens_from_byte_count_i64(i64::try_from(bytes).unwrap_or(i64::MAX))
}

fn estimate_serialized_model_visible_bytes(item: &ResponseItem) -> usize {
    let raw = i64::try_from(serialized_len(item)).unwrap_or(i64::MAX);
    let (image_payload, image_replacement) = image_adjustment(item);
    let (encrypted_payload, encrypted_replacement) = encrypted_output_adjustment(item);
    usize::try_from(
        raw.saturating_sub(image_payload)
            .saturating_add(image_replacement)
            .saturating_sub(encrypted_payload)
            .saturating_add(encrypted_replacement),
    )
    .unwrap_or(usize::MAX)
}

fn image_adjustment(item: &ResponseItem) -> (i64, i64) {
    let mut payload_bytes = 0i64;
    let mut replacement_bytes = 0i64;
    let mut accumulate = |image_url: &str, detail: Option<ImageDetail>| {
        let Some(payload) = base64_data_url_payload(image_url, "image/") else {
            return;
        };
        payload_bytes =
            payload_bytes.saturating_add(i64::try_from(payload.len()).unwrap_or(i64::MAX));
        replacement_bytes = replacement_bytes.saturating_add(match detail {
            Some(ImageDetail::Original) => {
                estimate_original_image_bytes(payload).unwrap_or(RESIZED_IMAGE_BYTES_ESTIMATE)
            }
            _ => RESIZED_IMAGE_BYTES_ESTIMATE,
        });
    };

    match item {
        ResponseItem::Message { content, .. } => {
            for part in content {
                if let ContentItem::InputImage { image_url, detail } = part {
                    accumulate(image_url, *detail);
                }
            }
        }
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => {
            if let FunctionCallOutputBody::ContentItems(items) = &output.body {
                for part in items {
                    if let FunctionCallOutputContentItem::InputImage { image_url, detail } = part {
                        accumulate(image_url, *detail);
                    }
                }
            }
        }
        _ => {}
    }
    (payload_bytes, replacement_bytes)
}

fn base64_data_url_payload<'a>(url: &'a str, media_prefix: &str) -> Option<&'a str> {
    let (metadata, payload) = url.split_once(',')?;
    let metadata = metadata.get("data:".len()..)?;
    let mut parts = metadata.split(';');
    let mime = parts.next()?;
    if !mime
        .get(..media_prefix.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(media_prefix))
        || !parts.any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    Some(payload)
}

fn estimate_original_image_bytes(payload: &str) -> Option<i64> {
    let bytes = BASE64_STANDARD.decode(payload).ok()?;
    let image = image::load_from_memory(&bytes).ok()?;
    let patches_wide = i64::from(image.width()).saturating_add(31) / ORIGINAL_IMAGE_PATCH_SIZE;
    let patches_high = i64::from(image.height()).saturating_add(31) / ORIGINAL_IMAGE_PATCH_SIZE;
    let patches = patches_wide
        .saturating_mul(patches_high)
        .min(ORIGINAL_IMAGE_MAX_PATCHES);
    Some(i64::try_from(approx_bytes_for_tokens(usize::try_from(patches).ok()?)).unwrap_or(i64::MAX))
}

fn encrypted_output_adjustment(item: &ResponseItem) -> (i64, i64) {
    let ResponseItem::FunctionCallOutput { output, .. } = item else {
        return (0, 0);
    };
    let FunctionCallOutputBody::ContentItems(items) = &output.body else {
        return (0, 0);
    };
    items
        .iter()
        .fold((0i64, 0i64), |(payload, replacement), part| {
            let FunctionCallOutputContentItem::EncryptedContent { encrypted_content } = part else {
                return (payload, replacement);
            };
            let encoded_len = encrypted_content.len();
            (
                payload.saturating_add(i64::try_from(encoded_len).unwrap_or(i64::MAX)),
                replacement.saturating_add(
                    i64::try_from(encoded_len.saturating_mul(9).div_ceil(16)).unwrap_or(i64::MAX),
                ),
            )
        })
}

fn serialized_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_string(value).map_or(0, |serialized| serialized.len())
}

fn estimate_reasoning_length(encoded_len: usize) -> usize {
    encoded_len
        .saturating_mul(3)
        .checked_div(4)
        .unwrap_or(0)
        .saturating_sub(REASONING_BASE64_OVERHEAD_BYTES)
}

fn is_model_generated_item(item: &ResponseItem) -> bool {
    match item {
        ResponseItem::Message { role, .. } => role == "assistant",
        ResponseItem::Reasoning { .. }
        | ResponseItem::FunctionCall { .. }
        | ResponseItem::ToolSearchCall { .. }
        | ResponseItem::WebSearchCall { .. }
        | ResponseItem::ImageGenerationCall { .. }
        | ResponseItem::CustomToolCall { .. }
        | ResponseItem::LocalShellCall { .. }
        | ResponseItem::Compaction { .. }
        | ResponseItem::ContextCompaction { .. } => true,
        ResponseItem::AdditionalTools { .. }
        | ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::ToolSearchOutput { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::AgentMessage { .. }
        | ResponseItem::CompactionTrigger { .. }
        | ResponseItem::Other => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(value: serde_json::Value) -> ResponseItem {
        serde_json::from_value(value).expect("synthetic item must be valid")
    }

    #[test]
    fn uses_server_total_plus_only_the_suffix_after_the_last_model_item() {
        let items = vec![
            item(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"alpha"}]}),
            ),
            item(
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"beta"}]}),
            ),
            item(json!({"type":"function_call_output","call_id":"call-1","output":"gamma"})),
        ];
        let expected = estimate_items(&items[2..]);
        assert_eq!(
            estimate_suffix_after_last_model_item(&items, 1),
            Some(expected)
        );
        assert_eq!(estimate_suffix_after_last_model_item(&items, 2), None);
    }

    #[test]
    fn estimates_base_instructions_with_the_pinned_byte_heuristic() {
        assert_eq!(estimate_instructions("12345"), 2);
    }

    #[test]
    fn encrypted_reasoning_uses_the_pinned_base64_heuristic() {
        let reasoning = item(json!({
            "type":"reasoning",
            "summary":[],
            "encrypted_content": "x".repeat(4096)
        }));
        assert_eq!(estimate_items(&[reasoning]), 606);
    }

    #[test]
    fn discounts_inline_image_and_encrypted_output_payloads() {
        let image = item(json!({
            "type":"message",
            "role":"user",
            "content":[{
                "type":"input_image",
                "image_url": format!("data:image/png;base64,{}", "A".repeat(20_000)),
                "detail":"high"
            }]
        }));
        let encrypted = item(json!({
            "type":"function_call_output",
            "call_id":"call-1",
            "output":[{"type":"encrypted_content","encrypted_content":"x".repeat(16_000)}]
        }));
        let raw_tokens = approx_tokens_from_byte_count_i64(
            i64::try_from(serialized_len(&image) + serialized_len(&encrypted)).unwrap_or(i64::MAX),
        );
        assert!(estimate_items(&[image, encrypted]) < raw_tokens);
    }
}

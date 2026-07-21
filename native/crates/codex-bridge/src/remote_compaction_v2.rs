use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::approx_token_count;
use codex_utils_output_truncation::truncate_text;

const RETAINED_MESSAGE_TOKEN_BUDGET: usize = 64_000;

pub fn build_compacted_history(
    prompt_input: &[ResponseItem],
    compaction_output: ResponseItem,
) -> Vec<ResponseItem> {
    let retained = prompt_input
        .iter()
        .filter(|item| is_retained_for_remote_compaction_v2(item))
        .cloned()
        .collect::<Vec<_>>();
    let mut retained =
        truncate_retained_messages_for_remote_compaction(retained, RETAINED_MESSAGE_TOKEN_BUDGET);
    retained.push(compaction_output);
    retained
}

fn is_retained_for_remote_compaction_v2(item: &ResponseItem) -> bool {
    matches!(item, ResponseItem::Message { role, .. } if matches!(role.as_str(), "user" | "developer" | "system"))
}

fn truncate_retained_messages_for_remote_compaction(
    items: Vec<ResponseItem>,
    max_tokens: usize,
) -> Vec<ResponseItem> {
    let mut remaining = max_tokens;
    let mut truncated_reversed = Vec::with_capacity(items.len());
    for item in items.into_iter().rev() {
        if remaining == 0 {
            continue;
        }
        let token_count = message_text_token_count(&item).max(1);
        if token_count <= remaining {
            truncated_reversed.push(item);
            remaining = remaining.saturating_sub(token_count);
        } else if let Some(truncated_item) = truncate_message_text_to_token_budget(item, remaining)
        {
            truncated_reversed.push(truncated_item);
            remaining = 0;
        }
    }
    truncated_reversed.reverse();
    truncated_reversed
}

fn message_text_token_count(item: &ResponseItem) -> usize {
    let ResponseItem::Message { content, .. } = item else {
        return 0;
    };
    content
        .iter()
        .map(|item| match item {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                approx_token_count(text)
            }
            ContentItem::InputImage { .. } => 0,
        })
        .sum()
}

fn truncate_message_text_to_token_budget(
    item: ResponseItem,
    max_tokens: usize,
) -> Option<ResponseItem> {
    let ResponseItem::Message {
        id,
        role,
        content,
        phase,
        internal_chat_message_metadata_passthrough: metadata,
    } = item
    else {
        return Some(item);
    };
    let mut remaining = max_tokens;
    let mut truncated_content = Vec::with_capacity(content.len());
    for mut content_item in content {
        match &mut content_item {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                if remaining == 0 {
                    continue;
                }
                let token_count = approx_token_count(text);
                if token_count <= remaining {
                    remaining = remaining.saturating_sub(token_count);
                } else {
                    *text = truncate_text(text, TruncationPolicy::Tokens(remaining));
                    remaining = 0;
                }
                if !text.is_empty() {
                    truncated_content.push(content_item);
                }
            }
            ContentItem::InputImage { .. } => truncated_content.push(content_item),
        }
    }
    if truncated_content.is_empty() {
        return None;
    }
    Some(ResponseItem::Message {
        id,
        role,
        content: truncated_content,
        phase,
        internal_chat_message_metadata_passthrough: metadata,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.to_owned(),
            content: vec![ContentItem::InputText {
                text: text.to_owned(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn retains_context_messages_before_the_official_compaction_item() {
        let output = ResponseItem::Compaction {
            id: None,
            encrypted_content: "opaque".to_owned(),
            internal_chat_message_metadata_passthrough: None,
        };
        let history = build_compacted_history(
            &[
                message("developer", "instructions"),
                message("user", "request"),
            ],
            output,
        );
        assert_eq!(history.len(), 3);
        assert!(matches!(&history[0], ResponseItem::Message { role, .. } if role == "developer"));
        assert!(matches!(&history[1], ResponseItem::Message { role, .. } if role == "user"));
        assert!(matches!(history[2], ResponseItem::Compaction { .. }));
    }
}

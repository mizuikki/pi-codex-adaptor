use std::sync::OnceLock;

use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ModelsResponse;
use serde_json::json;

const BUNDLED_MODELS_JSON: &str =
    include_str!("../../../vendor/openai-codex/codex-rs/models-manager/models.json");
const BUNDLED_PROMPT: &str =
    include_str!("../../../vendor/openai-codex/codex-rs/models-manager/prompt.md");

static CATALOG: OnceLock<Vec<ModelInfo>> = OnceLock::new();

pub fn resolve_model(slug: &str) -> ModelInfo {
    let candidates = catalog();
    if let Some(model) = candidates.iter().find(|model| model.slug == slug) {
        return renamed(model, slug);
    }
    if let Some(model) = longest_prefix(slug, candidates) {
        return renamed(model, slug);
    }
    if let Some((namespace, suffix)) = slug.split_once('/')
        && !suffix.contains('/')
        && !namespace.is_empty()
        && namespace
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        && let Some(model) = longest_prefix(suffix, candidates)
    {
        return renamed(model, slug);
    }
    fallback(slug)
}

fn catalog() -> &'static [ModelInfo] {
    CATALOG
        .get_or_init(
            || match serde_json::from_str::<ModelsResponse>(BUNDLED_MODELS_JSON) {
                Ok(response) => response.models,
                Err(_) => Vec::new(),
            },
        )
        .as_slice()
}

fn longest_prefix<'a>(slug: &str, candidates: &'a [ModelInfo]) -> Option<&'a ModelInfo> {
    candidates
        .iter()
        .filter(|model| slug.starts_with(&model.slug))
        .max_by_key(|model| model.slug.len())
}

fn renamed(model: &ModelInfo, slug: &str) -> ModelInfo {
    let mut model = model.clone();
    slug.clone_into(&mut model.slug);
    model.used_fallback_model_metadata = false;
    model
}

fn fallback(slug: &str) -> ModelInfo {
    let value = json!({
        "slug": slug,
        "display_name": slug,
        "description": null,
        "supported_reasoning_levels": [],
        "shell_type": "default",
        "visibility": "none",
        "supported_in_api": true,
        "priority": 99,
        "upgrade": null,
        "base_instructions": BUNDLED_PROMPT,
        "model_messages": null,
        "supports_reasoning_summaries": false,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "default_verbosity": null,
        "apply_patch_tool_type": null,
        "truncation_policy": { "mode": "bytes", "limit": 10000 },
        "supports_parallel_tool_calls": false,
        "supports_image_detail_original": false,
        "context_window": 272_000,
        "max_context_window": 272_000,
        "auto_compact_token_limit": null,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": ["text", "image"]
    });
    let Ok(mut model) = serde_json::from_value::<ModelInfo>(value) else {
        unreachable!("pinned fallback model metadata must be valid");
    };
    model.used_fallback_model_metadata = true;
    model
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_exact_and_longest_supported_prefixes() {
        let exact = resolve_model("gpt-5.2-codex");
        assert_eq!(exact.slug, "gpt-5.2-codex");
        assert!(!exact.used_fallback_model_metadata);

        let prefixed = resolve_model("gpt-5.2-codex-preview");
        assert_eq!(prefixed.slug, "gpt-5.2-codex-preview");
        assert!(!prefixed.used_fallback_model_metadata);
    }

    #[test]
    fn resolves_one_namespace_suffix_then_official_unknown_fallback() {
        let namespaced = resolve_model("custom/gpt-5.2-codex");
        assert_eq!(namespaced.slug, "custom/gpt-5.2-codex");
        assert!(!namespaced.used_fallback_model_metadata);

        let unknown = resolve_model("unknown-model");
        assert_eq!(unknown.slug, "unknown-model");
        assert!(unknown.used_fallback_model_metadata);
    }
}

//! Compile-time boundary to the selected official Codex modules.

use codex_api::ResponsesApiRequest;
use codex_client::RetryPolicy;
use codex_http_client::Request;
use codex_protocol::models::ResponseItem;
use codex_tools::ToolSpec;
use codex_utils_pty::ProcessHandle;
use codex_websocket_client::WebSocketConnector;

/// Returns stable Rust type identities for every directly selected official crate.
///
/// The bridge calls this while constructing its handshake so dependency removal cannot silently turn
/// the official wire layer into an unused build-only artifact.
pub fn compiled_module_types() -> [&'static str; 7] {
    [
        std::any::type_name::<ResponsesApiRequest>(),
        std::any::type_name::<RetryPolicy>(),
        std::any::type_name::<Request>(),
        std::any::type_name::<ResponseItem>(),
        std::any::type_name::<ToolSpec>(),
        std::any::type_name::<ProcessHandle>(),
        std::any::type_name::<WebSocketConnector>(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_every_selected_official_module() {
        let types = compiled_module_types();

        assert_eq!(types.len(), 7);
        assert!(types.iter().all(|name| name.starts_with("codex_")));
    }

    #[test]
    fn uses_the_official_tool_json_builder() {
        let options = codex_tools::CommandToolOptions {
            allow_login_shell: true,
            exec_permission_approvals_enabled: false,
        };
        let specs = vec![
            codex_tools::create_update_plan_tool(),
            codex_tools::create_exec_command_tool(options),
            codex_tools::create_write_stdin_tool(),
            codex_tools::create_shell_command_tool(options),
        ];
        let tools = codex_tools::create_tools_json_for_responses_api(&specs)
            .expect("official P0 tool specs should serialize");

        let names = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "update_plan",
                "exec_command",
                "write_stdin",
                "shell_command"
            ]
        );
        assert_eq!(tools[0]["parameters"]["additionalProperties"], false);
        assert_eq!(
            tools[1]["parameters"]["required"],
            serde_json::json!(["cmd"])
        );
    }

    #[test]
    fn uses_the_official_hosted_web_search_resolver() {
        let spec = codex_tools::create_web_search_tool(codex_tools::WebSearchToolOptions {
            web_search_mode: Some(codex_protocol::config_types::WebSearchMode::Indexed),
            web_search_config: None,
            web_search_tool_type: codex_protocol::openai_models::WebSearchToolType::Text,
        })
        .expect("indexed search should create a hosted tool");
        let tool = codex_tools::create_tools_json_for_responses_api(&[spec])
            .expect("hosted search should serialize");

        assert_eq!(tool[0]["type"], "web_search");
        assert_eq!(tool[0]["external_web_access"], true);
        assert_eq!(tool[0]["indexed_web_access"], true);
    }
}

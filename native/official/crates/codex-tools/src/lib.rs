//! P0 adapter over selected official `codex-tools` modules.

use std::collections::BTreeMap;

extern crate self as codex_tools;

#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/dynamic_tool.rs"]
mod dynamic_tool;
#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/json_schema.rs"]
mod json_schema;
#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/mcp_tool.rs"]
mod mcp_tool;
#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/response_history.rs"]
mod response_history;
#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/responses_api.rs"]
mod responses_api;
#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/tool_definition.rs"]
mod tool_definition;
#[path = "../../../../vendor/openai-codex/codex-rs/tools/src/tool_spec.rs"]
mod tool_spec;

#[path = "../../../../vendor/openai-codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs"]
mod apply_patch_spec;
#[path = "../../../../vendor/openai-codex/codex-rs/core/src/tools/hosted_spec.rs"]
mod hosted_spec;
#[path = "../../../../vendor/openai-codex/codex-rs/core/src/tools/handlers/plan_spec.rs"]
mod plan_spec;
#[path = "../../../../vendor/openai-codex/codex-rs/core/src/tools/handlers/shell_spec.rs"]
mod shell_spec;
#[path = "../../../../vendor/openai-codex/codex-rs/ext/web-search/src/schema.rs"]
mod standalone_web_search_schema;
#[path = "../../../../vendor/openai-codex/codex-rs/core/src/tools/handlers/view_image_spec.rs"]
mod view_image_spec;

pub use apply_patch_spec::create_apply_patch_freeform_tool;
pub use codex_protocol::ToolName;
pub use dynamic_tool::parse_dynamic_tool;
pub use hosted_spec::WebSearchToolOptions;
pub use hosted_spec::create_web_search_tool;
pub use json_schema::AdditionalProperties;
pub use json_schema::JsonSchema;
pub use json_schema::JsonSchemaPrimitiveType;
pub use json_schema::JsonSchemaType;
pub use json_schema::parse_tool_input_schema;
pub use json_schema::parse_tool_input_schema_without_compaction;
pub use mcp_tool::mcp_call_tool_result_output_schema;
pub use mcp_tool::parse_mcp_tool;
pub use plan_spec::create_update_plan_tool;
pub use response_history::retain_tail_from_last_n_user_messages;
pub use response_history::truncate_assistant_output_text_to_token_budget;
pub use responses_api::FreeformTool;
pub use responses_api::FreeformToolFormat;
pub use responses_api::LoadableToolSpec;
pub use responses_api::ResponsesApiNamespace;
pub use responses_api::ResponsesApiNamespaceTool;
pub use responses_api::ResponsesApiTool;
pub use responses_api::coalesce_loadable_tool_specs;
pub use responses_api::default_namespace_description;
pub use responses_api::dynamic_tool_to_responses_api_tool;
pub use responses_api::mcp_tool_to_deferred_responses_api_tool;
pub use responses_api::mcp_tool_to_responses_api_tool;
pub use responses_api::tool_definition_to_responses_api_tool;
pub use shell_spec::CommandToolOptions;
pub use shell_spec::create_request_permissions_tool;
pub use shell_spec::create_shell_command_tool;
pub use shell_spec::create_write_stdin_tool;
pub use shell_spec::request_permissions_tool_description;
pub use tool_definition::ToolDefinition;
pub use tool_spec::ResponsesApiWebSearchFilters;
pub use tool_spec::ResponsesApiWebSearchUserLocation;
pub use tool_spec::ToolSpec;
pub use tool_spec::create_tools_json_for_responses_api;
pub use view_image_spec::ViewImageToolOptions;
pub use view_image_spec::create_view_image_tool;

pub fn create_exec_command_tool(options: CommandToolOptions) -> ToolSpec {
    shell_spec::create_exec_command_tool_with_environment_id(
        options, /* include_environment_id */ false, /* include_shell_parameter */ true,
    )
}

pub fn create_image_generation_tool() -> ToolSpec {
    let optional_integer = JsonSchema {
        schema_type: Some(JsonSchemaType::Multiple(vec![
            JsonSchemaPrimitiveType::Integer,
            JsonSchemaPrimitiveType::Null,
        ])),
        ..JsonSchema::default()
    };
    let optional_paths = JsonSchema {
        schema_type: Some(JsonSchemaType::Multiple(vec![
            JsonSchemaPrimitiveType::Array,
            JsonSchemaPrimitiveType::Null,
        ])),
        items: Some(Box::new(JsonSchema::string(None))),
        ..JsonSchema::default()
    };
    let parameters = JsonSchema::object(
        BTreeMap::from([
            ("num_last_images_to_include".to_owned(), optional_integer),
            ("prompt".to_owned(), JsonSchema::string(None)),
            ("referenced_image_paths".to_owned(), optional_paths),
        ]),
        Some(vec!["prompt".to_owned()]),
        Some(false.into()),
    );
    ToolSpec::Namespace(ResponsesApiNamespace {
        name: "image_gen".to_owned(),
        description: default_namespace_description("image_gen"),
        tools: vec![ResponsesApiNamespaceTool::Function(ResponsesApiTool {
            name: "imagegen".to_owned(),
            description: include_str!(
                "../../../../vendor/openai-codex/codex-rs/ext/image-generation/imagegen_description.md"
            )
            .to_owned(),
            strict: false,
            defer_loading: None,
            parameters,
            output_schema: None,
        })],
    })
}

pub fn create_standalone_web_search_tool() -> Result<ToolSpec, serde_json::Error> {
    let parameters = parse_tool_input_schema_without_compaction(
        &standalone_web_search_schema::commands_schema(),
    )?;
    Ok(ToolSpec::Namespace(ResponsesApiNamespace {
        name: "web".to_owned(),
        description: default_namespace_description("web"),
        tools: vec![ResponsesApiNamespaceTool::Function(ResponsesApiTool {
            name: "run".to_owned(),
            description: include_str!(
                "../../../../vendor/openai-codex/codex-rs/ext/web-search/web_run_description.md"
            )
            .to_owned(),
            strict: false,
            defer_loading: None,
            parameters,
            output_schema: None,
        })],
    }))
}

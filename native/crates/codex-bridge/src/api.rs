use std::sync::Arc;
use std::time::Duration;

use bridge_protocol::BridgeError;
use bridge_protocol::ErrorCategory;
use bridge_protocol::ProviderAuthentication;
use bridge_protocol::ProviderConnection;

/// Maximum finite stream idle / websocket connect timeout accepted on the wire (24 hours).
const MAX_FINITE_TIMEOUT_MS: u64 = 86_400_000;
/// Pi maps disabled HTTP idle timeout (`0`) to this signed 32-bit max int sentinel.
const PI_DISABLED_IDLE_TIMEOUT_MS: u64 = 2_147_483_647;
/// Leave room for JSONL protocol framing and a status prefix within the 4,096-character bridge field.
const MAX_UPSTREAM_ERROR_DETAIL_CHARS: usize = 4_000;
use bytes::Bytes;
use codex_api::ApiError;
use codex_api::AuthProvider;
use codex_api::Provider;
use codex_api::ReqwestTransport;
use codex_api::ResponseEvent;
use codex_api::RetryConfig;
use codex_api::SharedAuthProvider;
use codex_api::TransportError;
use codex_http_client::ByteStream;
use codex_http_client::HttpTransport;
use codex_http_client::Request;
use codex_http_client::Response;
use codex_http_client::build_reqwest_client_with_custom_ca;
use futures::StreamExt;
use futures::stream;
use http::HeaderMap;
use http::HeaderName;
use http::HeaderValue;
use http::header::CONTENT_TYPE;
use serde_json::Value;
use serde_json::json;

const NORMALIZED_CONTEXT_WINDOW_BODY: &str = "__codex_context_window_exceeded__";
const MAX_CONTEXT_ERROR_BODY_BYTES: usize = 64 * 1024;

pub struct ApiConnection {
    pub transport: ReqwestTransport,
    pub provider: Provider,
    pub authentication: SharedAuthProvider,
    pub max_retries: u32,
    pub websocket_connect_timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct ResponsesTransport {
    inner: ReqwestTransport,
}

impl ResponsesTransport {
    pub fn new(inner: ReqwestTransport) -> Self {
        Self { inner }
    }
}

impl HttpTransport for ResponsesTransport {
    async fn execute(&self, request: Request) -> Result<Response, TransportError> {
        self.inner.execute(request).await
    }

    async fn stream(
        &self,
        request: Request,
    ) -> Result<codex_http_client::StreamResponse, TransportError> {
        let mut response = self.inner.stream(request).await?;
        if !is_json_content_type(&response.headers) {
            return Ok(response);
        }

        let mut consumed = Vec::new();
        let mut inspected = Vec::new();
        let mut reached_end = false;
        while inspected.len() < MAX_CONTEXT_ERROR_BODY_BYTES {
            let Some(chunk) = response.bytes.next().await else {
                reached_end = true;
                break;
            };
            let chunk = chunk?;
            if chunk.is_empty() {
                continue;
            }
            let remaining = MAX_CONTEXT_ERROR_BODY_BYTES.saturating_sub(inspected.len());
            inspected.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            consumed.push(chunk);
        }
        if is_context_window_error_body(&inspected) {
            return Err(normalized_context_window_error(response.status));
        }
        response.bytes = if reached_end {
            one_chunk_stream(inspected)
        } else {
            stream::iter(consumed.into_iter().map(Ok::<Bytes, TransportError>))
                .chain(response.bytes)
                .boxed()
        };
        Ok(response)
    }
}

fn normalized_context_window_error(status: http::StatusCode) -> TransportError {
    TransportError::Http {
        status,
        url: None,
        headers: None,
        body: Some(NORMALIZED_CONTEXT_WINDOW_BODY.to_owned()),
    }
}

fn one_chunk_stream(body: Vec<u8>) -> ByteStream {
    stream::once(async move { Ok(Bytes::from(body)) }).boxed()
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn is_context_window_error_body(body: &[u8]) -> bool {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        return is_context_window_error_value(&value);
    }
    let body = String::from_utf8_lossy(body).to_ascii_lowercase();
    body.contains("context_length_exceeded")
        || body.contains("context_window_exceeded")
        || body.contains("your input exceeds the context window")
        || body.contains("maximum context length")
}

fn is_context_window_error_value(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let code = object
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code.eq_ignore_ascii_case("context_length_exceeded")
        || code.eq_ignore_ascii_case("context_window_exceeded")
    {
        return true;
    }
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if message.contains("your input exceeds the context window")
        || message.contains("maximum context length")
    {
        return true;
    }
    object
        .get("error")
        .is_some_and(is_context_window_error_value)
        || object
            .get("response")
            .is_some_and(is_context_window_error_value)
}

struct BridgeAuthProvider {
    headers: HeaderMap,
}

impl BridgeAuthProvider {
    fn new(connection: &ProviderConnection) -> Result<Self, BridgeError> {
        let mut headers = HeaderMap::new();
        if matches!(
            connection.authentication,
            ProviderAuthentication::Bearer { .. }
        ) {
            if connection
                .headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("authorization"))
            {
                return Err(invalid_connection());
            }
            let ProviderAuthentication::Bearer { token } = &connection.authentication else {
                unreachable!();
            };
            let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| invalid_authentication())?;
            authorization.set_sensitive(true);
            headers.insert(http::header::AUTHORIZATION, authorization);
        }
        if let Some(account_id) = &connection.account_id {
            if connection
                .headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("ChatGPT-Account-ID"))
            {
                return Err(invalid_connection());
            }
            let mut account_id =
                HeaderValue::from_str(account_id).map_err(|_| invalid_connection())?;
            account_id.set_sensitive(true);
            headers.insert("ChatGPT-Account-ID", account_id);
        }
        Ok(Self { headers })
    }
}

impl AuthProvider for BridgeAuthProvider {
    fn add_auth_headers(&self, headers: &mut HeaderMap) {
        headers.extend(self.headers.clone());
    }
}

pub fn connect(connection: &ProviderConnection) -> Result<ApiConnection, BridgeError> {
    validate_provider_connection(connection)?;
    let authentication_provider = BridgeAuthProvider::new(connection)?;
    let base_url = validate_base_url(&connection.base_url)?;
    let max_retries = connection.max_retries.unwrap_or(3);
    let stream_idle_timeout = resolve_stream_idle_timeout(connection.timeout_ms)?;
    let websocket_connect_timeout =
        Duration::from_millis(connection.websocket_connect_timeout_ms.unwrap_or(10_000));
    let client = build_reqwest_client_with_custom_ca(reqwest::Client::builder()).map_err(|_| {
        BridgeError {
            category: ErrorCategory::ConfigurationError,
            code: "http_client_initialization_failed".to_owned(),
            message: "the native HTTP client could not be initialized".to_owned(),
            retryable: false,
        }
    })?;

    Ok(ApiConnection {
        transport: ReqwestTransport::new(client),
        provider: Provider {
            name: "OpenAI".to_owned(),
            base_url,
            query_params: None,
            headers: provider_headers(connection)?,
            retry: RetryConfig {
                max_attempts: u64::from(max_retries).saturating_add(1),
                base_delay: Duration::from_millis(200),
                retry_429: false,
                retry_5xx: true,
                retry_transport: true,
            },
            stream_idle_timeout,
        },
        authentication: Arc::new(authentication_provider),
        max_retries,
        websocket_connect_timeout,
    })
}

fn invalid_authentication() -> BridgeError {
    BridgeError {
        category: ErrorCategory::AuthenticationError,
        code: "invalid_authentication".to_owned(),
        message: "bridge authentication is invalid".to_owned(),
        retryable: false,
    }
}

fn invalid_connection() -> BridgeError {
    BridgeError {
        category: ErrorCategory::ConfigurationError,
        code: "invalid_provider_connection".to_owned(),
        message: "the provider connection is invalid".to_owned(),
        retryable: false,
    }
}

fn provider_headers(connection: &ProviderConnection) -> Result<HeaderMap, BridgeError> {
    let mut headers = HeaderMap::new();
    for (name, value) in &connection.headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid_connection())?;
        let value = HeaderValue::from_str(value).map_err(|_| invalid_connection())?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn validate_provider_connection(connection: &ProviderConnection) -> Result<(), BridgeError> {
    if connection.provider_id.is_empty()
        || connection.provider_id.len() > 256
        || connection.provider_id.contains(['\r', '\n'])
    {
        return Err(invalid_connection());
    }
    if connection.headers.len() > 128 {
        return Err(invalid_connection());
    }
    for (name, value) in &connection.headers {
        if name.is_empty() || name.len() > 256 || value.len() > 1024 * 1024 {
            return Err(invalid_connection());
        }
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid_connection())?;
        HeaderValue::from_str(value).map_err(|_| invalid_connection())?;
    }
    match &connection.authentication {
        ProviderAuthentication::Bearer { token } => {
            if token.is_empty() || token.len() > 1024 * 1024 {
                return Err(invalid_authentication());
            }
            HeaderValue::from_str(token).map_err(|_| invalid_authentication())?;
        }
        ProviderAuthentication::None => {}
    }
    if let Some(account_id) = &connection.account_id {
        if account_id.is_empty() || account_id.len() > 256 {
            return Err(invalid_connection());
        }
        HeaderValue::from_str(account_id).map_err(|_| invalid_connection())?;
    }
    if connection.max_retries.is_some_and(|value| value > 10)
        || connection
            .timeout_ms
            .is_some_and(|value| !is_valid_timeout_ms(value))
        || connection
            .websocket_connect_timeout_ms
            .is_some_and(|value| value == 0 || value > MAX_FINITE_TIMEOUT_MS)
    {
        return Err(invalid_connection());
    }
    validate_base_url(&connection.base_url)?;
    Ok(())
}

/// Accepts finite idle timeouts in `[1, MAX_FINITE_TIMEOUT_MS]` plus Pi's disabled sentinel.
fn is_valid_timeout_ms(value: u64) -> bool {
    (1..=MAX_FINITE_TIMEOUT_MS).contains(&value) || value == PI_DISABLED_IDLE_TIMEOUT_MS
}

/// Resolves the official stream idle timeout duration for a validated connection timeout.
///
/// Omitted values default to five minutes. Pi's disabled-idle-timeout sentinel maps to an
/// effectively unbounded duration so long-running streams are not cancelled by the idle timer.
fn resolve_stream_idle_timeout(timeout_ms: Option<u64>) -> Result<Duration, BridgeError> {
    match timeout_ms {
        None => Ok(Duration::from_mins(5)),
        Some(PI_DISABLED_IDLE_TIMEOUT_MS) => Ok(Duration::from_secs(u64::MAX / 1_000)),
        Some(value) if (1..=MAX_FINITE_TIMEOUT_MS).contains(&value) => {
            Ok(Duration::from_millis(value))
        }
        Some(_) => Err(invalid_connection()),
    }
}

fn validate_base_url(value: &str) -> Result<String, BridgeError> {
    if value.len() > 2048 || !value.is_ascii() {
        return Err(invalid_connection());
    }
    let mut url = url::Url::parse(value).map_err(|_| invalid_connection())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(invalid_connection());
    }
    let path = url.path().trim_end_matches('/');
    if path == "/responses" || path.ends_with("/responses") {
        return Err(invalid_connection());
    }
    if url.scheme() == "https"
        && matches!(url.host_str(), Some("chatgpt.com" | "chat.openai.com"))
        && path == "/backend-api"
    {
        url.set_path("/backend-api/codex");
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub struct MappedResponseEvent {
    pub event: Value,
    pub completion: Option<Value>,
}

#[allow(clippy::too_many_lines)]
pub fn map_response_event(event: ResponseEvent) -> Option<MappedResponseEvent> {
    let (event, completion) = match event {
        ResponseEvent::Created => (json!({ "type": "response.created" }), None),
        ResponseEvent::SafetyBuffering(buffering) => (
            json!({
                "type": "response.safety_buffering",
                "useCases": buffering.use_cases,
                "reasons": buffering.reasons,
                "fasterModel": buffering.faster_model,
            }),
            None,
        ),
        ResponseEvent::OutputItemDone(item) => (
            json!({ "type": "response.output_item.done", "item": item }),
            None,
        ),
        ResponseEvent::OutputItemAdded(item) => (
            json!({ "type": "response.output_item.added", "item": item }),
            None,
        ),
        ResponseEvent::ServerModel(model) => (
            json!({ "type": "response.server_model", "model": model }),
            None,
        ),
        ResponseEvent::ModelVerifications(verifications) => (
            json!({
                "type": "response.model_verifications",
                "verifications": verifications,
            }),
            None,
        ),
        ResponseEvent::TurnModerationMetadata(metadata) => (
            json!({
                "type": "response.turn_moderation_metadata",
                "metadata": metadata.metadata,
            }),
            None,
        ),
        ResponseEvent::ServerReasoningIncluded(included) => (
            json!({
                "type": "response.server_reasoning_included",
                "included": included,
            }),
            None,
        ),
        ResponseEvent::Completed {
            response_id,
            token_usage,
            end_turn,
        } => {
            let completion = json!({
                "responseId": response_id,
                "tokenUsage": token_usage,
                "endTurn": end_turn,
            });
            (
                json!({
                    "type": "response.completed",
                    "responseId": completion["responseId"],
                    "tokenUsage": completion["tokenUsage"],
                    "endTurn": completion["endTurn"],
                }),
                Some(completion),
            )
        }
        ResponseEvent::OutputTextDelta(delta) => (
            json!({ "type": "response.output_text.delta", "delta": delta }),
            None,
        ),
        ResponseEvent::ToolCallInputDelta {
            item_id,
            call_id,
            delta,
        } => (
            json!({
                "type": "response.custom_tool_call_input.delta",
                "itemId": item_id,
                "callId": call_id,
                "delta": delta,
            }),
            None,
        ),
        ResponseEvent::ReasoningSummaryDelta {
            delta,
            summary_index,
        } => (
            json!({
                "type": "response.reasoning_summary_text.delta",
                "delta": delta,
                "summaryIndex": summary_index,
            }),
            None,
        ),
        ResponseEvent::ReasoningSummaryDone {
            item_id,
            text,
            summary_index,
        } => (
            json!({
                "type": "response.reasoning_summary_text.done",
                "itemId": item_id,
                "text": text,
                "summaryIndex": summary_index,
            }),
            None,
        ),
        ResponseEvent::ReasoningContentDelta {
            delta,
            content_index,
        } => (
            json!({
                "type": "response.reasoning_text.delta",
                "delta": delta,
                "contentIndex": content_index,
            }),
            None,
        ),
        ResponseEvent::ReasoningSummaryPartAdded { summary_index } => (
            json!({
                "type": "response.reasoning_summary_part.added",
                "summaryIndex": summary_index,
            }),
            None,
        ),
        ResponseEvent::ModelsEtag(etag) => (
            json!({ "type": "response.models_etag", "etag": etag }),
            None,
        ),
        ResponseEvent::RateLimits(_) => return None,
    };
    Some(MappedResponseEvent { event, completion })
}

pub fn map_api_error(error: &ApiError) -> BridgeError {
    let (category, code, retryable) = match error {
        ApiError::Transport(TransportError::Http {
            body: Some(body), ..
        }) if body == NORMALIZED_CONTEXT_WINDOW_BODY => (
            ErrorCategory::CapabilityError,
            "context_window_exceeded",
            false,
        ),
        ApiError::Transport(TransportError::Http { status, .. })
            if *status == http::StatusCode::UNAUTHORIZED
                || *status == http::StatusCode::FORBIDDEN =>
        {
            (
                ErrorCategory::AuthenticationError,
                "upstream_authentication_failed",
                false,
            )
        }
        ApiError::ContextWindowExceeded => (
            ErrorCategory::CapabilityError,
            "context_window_exceeded",
            false,
        ),
        ApiError::QuotaExceeded | ApiError::UsageNotIncluded => (
            ErrorCategory::AuthenticationError,
            "upstream_access_unavailable",
            false,
        ),
        ApiError::InvalidRequest { .. } => (
            ErrorCategory::ProtocolError,
            "upstream_invalid_request",
            false,
        ),
        ApiError::CyberPolicy { .. } => (
            ErrorCategory::CapabilityError,
            "upstream_policy_rejected",
            false,
        ),
        ApiError::ServerOverloaded => (ErrorCategory::CapabilityError, "upstream_overloaded", true),
        ApiError::Retryable { .. } | ApiError::RateLimit(_) => (
            ErrorCategory::CapabilityError,
            "upstream_temporarily_unavailable",
            true,
        ),
        ApiError::Transport(_) | ApiError::Api { .. } | ApiError::Stream(_) => (
            ErrorCategory::CapabilityError,
            "upstream_request_failed",
            true,
        ),
    };
    BridgeError {
        category,
        code: code.to_owned(),
        message: format_upstream_api_error(error),
        retryable,
    }
}

/// Extract only the official error variant's user-facing message or response body.
/// This intentionally never formats the whole transport error, which could include URLs or headers.
fn format_upstream_api_error(error: &ApiError) -> String {
    let detail = match error {
        ApiError::Transport(TransportError::Http { status, body, .. }) => match body {
            Some(body) if !body.trim().is_empty() => format!("{status}: {}", body.trim()),
            _ => format!("HTTP {status}"),
        },
        ApiError::Transport(TransportError::RetryLimit) => "retry limit reached".to_owned(),
        ApiError::Transport(TransportError::Timeout) => "request timed out".to_owned(),
        ApiError::Transport(TransportError::Network(message) | TransportError::Build(message))
        | ApiError::Stream(message)
        | ApiError::Retryable { message, .. }
        | ApiError::RateLimit(message)
        | ApiError::InvalidRequest { message }
        | ApiError::CyberPolicy { message } => message.clone(),
        ApiError::Api { status, message } => format!("{status}: {message}"),
        ApiError::ContextWindowExceeded => {
            "the request exceeded the model context window".to_owned()
        }
        ApiError::QuotaExceeded | ApiError::UsageNotIncluded => {
            "OpenAI access is unavailable for this request".to_owned()
        }
        ApiError::ServerOverloaded => "OpenAI is temporarily overloaded".to_owned(),
    };
    truncate_upstream_error_detail(&detail)
}

fn truncate_upstream_error_detail(detail: &str) -> String {
    let utf16_count = detail.encode_utf16().count();
    if utf16_count <= MAX_UPSTREAM_ERROR_DETAIL_CHARS {
        return detail.to_owned();
    }
    let mut prefix = String::new();
    let mut prefix_utf16_count = 0;
    for character in detail.chars() {
        let character_utf16_count = character.len_utf16();
        if prefix_utf16_count + character_utf16_count > MAX_UPSTREAM_ERROR_DETAIL_CHARS {
            break;
        }
        prefix.push(character);
        prefix_utf16_count += character_utf16_count;
    }
    format!(
        "{prefix}... [truncated {} chars]",
        utf16_count - prefix_utf16_count
    )
}

/// Maps an endpoint-level unsupported response to the activated provider contract member.
/// The returned error never includes the URL, headers, response body, or request content.
pub fn map_provider_contract_error(error: &ApiError, capability: &str) -> BridgeError {
    let unsupported = match error {
        ApiError::Transport(TransportError::Http { status, .. }) | ApiError::Api { status, .. } => {
            matches!(
                *status,
                http::StatusCode::NOT_FOUND
                    | http::StatusCode::METHOD_NOT_ALLOWED
                    | http::StatusCode::NOT_IMPLEMENTED
            )
        }
        _ => false,
    };
    if !unsupported {
        return map_api_error(error);
    }
    BridgeError {
        category: ErrorCategory::CapabilityError,
        code: "provider_contract_mismatch".to_owned(),
        message: format!("the selected provider does not implement {capability}"),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use codex_protocol::protocol::RateLimitSnapshot;

    #[test]
    fn drops_account_rate_limit_events() {
        let snapshot = RateLimitSnapshot {
            limit_id: None,
            limit_name: None,
            primary: None,
            secondary: None,
            credits: None,
            individual_limit: None,
            plan_type: None,
            rate_limit_reached_type: None,
            spend_control_reached: None,
        };
        assert!(map_response_event(ResponseEvent::RateLimits(snapshot)).is_none());
    }

    #[test]
    fn upstream_error_messages_are_bounded_and_cross_the_bridge() {
        let error = map_api_error(&ApiError::InvalidRequest {
            message: "upstream fixture detail".to_owned(),
        });
        assert_eq!(error.code, "upstream_invalid_request");
        assert_eq!(error.message, "upstream fixture detail");
    }

    #[test]
    fn recognizes_context_errors_in_json_error_envelopes_only() {
        assert!(is_context_window_error_body(
            br#"{"error":{"code":"context_length_exceeded"}}"#
        ));
        assert!(is_context_window_error_body(
            br#"{"error":{"code":"context_window_exceeded"}}"#
        ));
        assert!(is_context_window_error_body(
            br#"{"response":{"error":{"message":"Your input exceeds the context window of this model"}}}"#
        ));
        assert!(!is_context_window_error_body(
            br#"{"output":[{"message":"Your input exceeds the context window of this model"}]}"#
        ));
    }

    #[test]
    fn upstream_http_errors_include_status_and_body_without_transport_metadata() {
        let error = map_api_error(&ApiError::Transport(TransportError::Http {
            status: http::StatusCode::BAD_REQUEST,
            url: Some("https://private.invalid/endpoint".to_owned()),
            headers: None,
            body: Some("upstream fixture detail".to_owned()),
        }));
        assert_eq!(error.message, "400 Bad Request: upstream fixture detail");
        assert!(!error.message.contains("private.invalid"));
    }

    #[test]
    fn upstream_retryable_http_errors_keep_classification_and_detail() {
        let cases = [
            (
                http::StatusCode::TOO_MANY_REQUESTS,
                "rate limit fixture detail",
            ),
            (
                http::StatusCode::SERVICE_UNAVAILABLE,
                "service fixture detail",
            ),
        ];
        for (status, body) in cases {
            let error = map_api_error(&ApiError::Transport(TransportError::Http {
                status,
                url: None,
                headers: None,
                body: Some(body.to_owned()),
            }));
            assert_eq!(error.category, ErrorCategory::CapabilityError);
            assert_eq!(error.code, "upstream_request_failed");
            assert!(error.retryable);
            assert_eq!(error.message, format!("{status}: {body}"));
        }
    }

    #[test]
    fn upstream_error_detail_is_truncated_before_bridge_serialization() {
        let source = "😀".repeat(MAX_UPSTREAM_ERROR_DETAIL_CHARS / 2 + 6);
        let error = map_api_error(&ApiError::InvalidRequest { message: source });
        assert_eq!(
            error.message.encode_utf16().count(),
            MAX_UPSTREAM_ERROR_DETAIL_CHARS + 24
        );
        assert!(error.message.ends_with("... [truncated 12 chars]"));
        assert!(error.message.encode_utf16().count() <= 4_096);
    }

    #[test]
    fn endpoint_unsupported_errors_name_only_the_provider_contract_member() {
        for capability in [
            "responses_sse",
            "remote_compaction_v2",
            "compact_endpoint",
            "images_api",
            "search_api",
        ] {
            let error = map_provider_contract_error(
                &ApiError::Transport(TransportError::Http {
                    status: http::StatusCode::NOT_FOUND,
                    url: Some("https://private.invalid/endpoint".to_owned()),
                    headers: None,
                    body: Some("private response body".to_owned()),
                }),
                capability,
            );
            assert_eq!(error.code, "provider_contract_mismatch");
            assert_eq!(
                error.message,
                format!("the selected provider does not implement {capability}")
            );
            assert!(!error.message.contains("private.invalid"));
            assert!(!error.message.contains("private response"));
            assert!(!error.retryable);
        }
    }

    #[test]
    fn bearer_authentication_adds_optional_account_header() {
        let connection = ProviderConnection {
            provider_id: "fixture-provider".to_owned(),
            base_url: "https://example.invalid/v1".to_owned(),
            headers: BTreeMap::new(),
            authentication: ProviderAuthentication::Bearer {
                token: "fixture-token".to_owned(),
            },
            account_id: Some("fixture-account".to_owned()),
            max_retries: None,
            timeout_ms: None,
            websocket_connect_timeout_ms: None,
        };
        let provider =
            BridgeAuthProvider::new(&connection).expect("fixture authentication should be valid");
        let headers = provider.headers;

        assert_eq!(
            headers
                .get("ChatGPT-Account-ID")
                .and_then(|value| value.to_str().ok()),
            Some("fixture-account")
        );
        assert!(headers.contains_key(http::header::AUTHORIZATION));
    }

    #[test]
    fn rejects_authentication_that_cannot_be_encoded_as_headers() {
        let connection = ProviderConnection {
            provider_id: "fixture-provider".to_owned(),
            base_url: "https://example.invalid/v1".to_owned(),
            headers: BTreeMap::new(),
            authentication: ProviderAuthentication::Bearer {
                token: "fixture\ntoken".to_owned(),
            },
            account_id: None,
            max_retries: None,
            timeout_ms: None,
            websocket_connect_timeout_ms: None,
        };
        let Err(error) = BridgeAuthProvider::new(&connection) else {
            panic!("invalid header values must be rejected");
        };
        assert_eq!(error.code, "invalid_authentication");
    }

    fn fixture_connection(timeout_ms: Option<u64>) -> ProviderConnection {
        ProviderConnection {
            provider_id: "fixture-provider".to_owned(),
            base_url: "https://example.invalid/v1".to_owned(),
            headers: BTreeMap::new(),
            authentication: ProviderAuthentication::None,
            account_id: None,
            max_retries: None,
            timeout_ms,
            websocket_connect_timeout_ms: None,
        }
    }

    #[test]
    fn accepts_pi_disabled_idle_timeout_sentinel() {
        assert!(is_valid_timeout_ms(PI_DISABLED_IDLE_TIMEOUT_MS));
        assert!(
            validate_provider_connection(&fixture_connection(Some(PI_DISABLED_IDLE_TIMEOUT_MS)))
                .is_ok()
        );
        let timeout = resolve_stream_idle_timeout(Some(PI_DISABLED_IDLE_TIMEOUT_MS))
            .expect("disabled sentinel must resolve");
        assert_eq!(timeout, Duration::from_secs(u64::MAX / 1_000));
    }

    #[test]
    fn accepts_finite_timeout_boundaries() {
        assert!(is_valid_timeout_ms(1));
        assert!(is_valid_timeout_ms(MAX_FINITE_TIMEOUT_MS));
        assert!(validate_provider_connection(&fixture_connection(Some(1))).is_ok());
        assert!(
            validate_provider_connection(&fixture_connection(Some(MAX_FINITE_TIMEOUT_MS))).is_ok()
        );
        assert_eq!(
            resolve_stream_idle_timeout(Some(1)).expect("minimum timeout"),
            Duration::from_millis(1)
        );
        assert_eq!(
            resolve_stream_idle_timeout(Some(MAX_FINITE_TIMEOUT_MS)).expect("maximum timeout"),
            Duration::from_millis(MAX_FINITE_TIMEOUT_MS)
        );
        assert_eq!(
            resolve_stream_idle_timeout(None).expect("default timeout"),
            Duration::from_mins(5)
        );
    }

    #[test]
    fn rejects_timeouts_outside_finite_bound_except_disabled_sentinel() {
        assert!(!is_valid_timeout_ms(0));
        assert!(!is_valid_timeout_ms(MAX_FINITE_TIMEOUT_MS + 1));
        assert!(!is_valid_timeout_ms(PI_DISABLED_IDLE_TIMEOUT_MS - 1));
        assert!(!is_valid_timeout_ms(PI_DISABLED_IDLE_TIMEOUT_MS + 1));

        for value in [
            0,
            MAX_FINITE_TIMEOUT_MS + 1,
            PI_DISABLED_IDLE_TIMEOUT_MS - 1,
            PI_DISABLED_IDLE_TIMEOUT_MS + 1,
        ] {
            let Err(error) = validate_provider_connection(&fixture_connection(Some(value))) else {
                panic!("timeout {value} must be rejected");
            };
            assert_eq!(error.code, "invalid_provider_connection");
            let Err(error) = resolve_stream_idle_timeout(Some(value)) else {
                panic!("timeout {value} must not resolve");
            };
            assert_eq!(error.code, "invalid_provider_connection");
        }
    }

    #[test]
    fn websocket_connect_timeout_does_not_accept_disabled_sentinel() {
        let mut connection = fixture_connection(None);
        connection.websocket_connect_timeout_ms = Some(PI_DISABLED_IDLE_TIMEOUT_MS);
        let Err(error) = validate_provider_connection(&connection) else {
            panic!("websocket connect timeout must remain finite");
        };
        assert_eq!(error.code, "invalid_provider_connection");
    }
}

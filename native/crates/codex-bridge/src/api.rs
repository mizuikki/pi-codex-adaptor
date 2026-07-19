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
use codex_api::ApiError;
use codex_api::AuthProvider;
use codex_api::Provider;
use codex_api::ReqwestTransport;
use codex_api::ResponseEvent;
use codex_api::RetryConfig;
use codex_api::SharedAuthProvider;
use codex_api::TransportError;
use codex_http_client::build_reqwest_client_with_custom_ca;
use http::HeaderMap;
use http::HeaderName;
use http::HeaderValue;
use serde_json::Value;
use serde_json::json;

pub struct ApiConnection {
    pub transport: ReqwestTransport,
    pub provider: Provider,
    pub authentication: SharedAuthProvider,
    pub websocket_connect_timeout: Duration,
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
    let (category, code, message, retryable) = match error {
        ApiError::Transport(TransportError::Http { status, .. })
            if *status == http::StatusCode::UNAUTHORIZED
                || *status == http::StatusCode::FORBIDDEN =>
        {
            (
                ErrorCategory::AuthenticationError,
                "upstream_authentication_failed",
                "OpenAI rejected the bridge authentication",
                false,
            )
        }
        ApiError::ContextWindowExceeded => (
            ErrorCategory::CapabilityError,
            "context_window_exceeded",
            "the request exceeded the model context window",
            false,
        ),
        ApiError::QuotaExceeded | ApiError::UsageNotIncluded => (
            ErrorCategory::AuthenticationError,
            "upstream_access_unavailable",
            "OpenAI access is unavailable for this request",
            false,
        ),
        ApiError::InvalidRequest { .. } => (
            ErrorCategory::ProtocolError,
            "upstream_invalid_request",
            "OpenAI rejected the request",
            false,
        ),
        ApiError::CyberPolicy { .. } => (
            ErrorCategory::CapabilityError,
            "upstream_policy_rejected",
            "OpenAI policy rejected the request",
            false,
        ),
        ApiError::ServerOverloaded => (
            ErrorCategory::CapabilityError,
            "upstream_overloaded",
            "OpenAI is temporarily overloaded",
            true,
        ),
        ApiError::Retryable { .. } | ApiError::RateLimit(_) => (
            ErrorCategory::CapabilityError,
            "upstream_temporarily_unavailable",
            "OpenAI is temporarily unavailable",
            true,
        ),
        ApiError::Transport(_) | ApiError::Api { .. } | ApiError::Stream(_) => (
            ErrorCategory::CapabilityError,
            "upstream_request_failed",
            "the OpenAI request failed",
            true,
        ),
    };
    BridgeError {
        category,
        code: code.to_owned(),
        message: message.to_owned(),
        retryable,
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
        };
        assert!(map_response_event(ResponseEvent::RateLimits(snapshot)).is_none());
    }

    #[test]
    fn upstream_error_messages_never_cross_the_bridge() {
        let error = map_api_error(&ApiError::InvalidRequest {
            message: "private upstream detail".to_owned(),
        });
        assert_eq!(error.code, "upstream_invalid_request");
        assert!(!error.message.contains("private upstream detail"));
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

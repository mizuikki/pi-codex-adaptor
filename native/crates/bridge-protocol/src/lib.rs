//! Versioned, adaptor-owned envelopes for the TypeScript/native JSONL boundary.
//!
//! `OpenAI` wire objects remain opaque JSON values here. Their typed source of truth belongs to the
//! pinned native Codex modules, not this bridge protocol crate.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Initial bridge protocol version.
pub const BRIDGE_PROTOCOL_VERSION: u32 = 2;

/// Maximum JSON payload size for one JSONL frame, excluding the line terminator.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Maximum number of unacknowledged stream events advertised by protocol v2.
pub const MAX_PENDING_EVENTS: u32 = 256;

/// Official Codex release used by the native implementation.
pub const OFFICIAL_CODEX_VERSION: &str = "0.144.3";

/// Human-readable tag for the official Codex release.
pub const OFFICIAL_CODEX_TAG: &str = "rust-v0.144.3";

/// Immutable `OpenAI` Codex source commit used by the native implementation.
pub const OFFICIAL_SOURCE_COMMIT: &str = "78ad6e6bfd1d3b6a209acd3ef82172a96b25179c";

/// Recorded hash of the currently selected vendor tree.
pub const VENDOR_TREE_SHA256: &str =
    "4e73a4c8efdc818b085b4abea1660b3a6d84b0fdbb6d687bda5c55dc0f07caad";

/// A frame sent from the TypeScript host to the native bridge.
///
/// This type intentionally does not implement `Debug`: provider connections and request frames can contain
/// credentials or user content and must not be accidentally included in diagnostics.
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ClientMessage {
    /// Starts a bridge connection and negotiates the exact protocol version.
    Initialize {
        request_id: String,
        protocol_version: u32,
        client: ClientIdentity,
    },
    /// Starts a multiplexed bridge operation.
    Request {
        request_id: String,
        method: RequestMethod,
        params: Value,
    },
    /// Cancels an in-flight request.
    Cancel {
        request_id: String,
        target_request_id: String,
    },
    /// Resolves a native operation that is waiting for Pi authorization.
    ApprovalDecision {
        request_id: String,
        approval_id: String,
        decision: ApprovalDecision,
    },
    /// Writes bytes represented as UTF-8 text to a running native session.
    SessionWrite {
        request_id: String,
        session_id: String,
        authorization: NativeAuthorization,
        data: String,
    },
    /// Changes the terminal dimensions of a running native session.
    SessionResize {
        request_id: String,
        session_id: String,
        columns: u16,
        rows: u16,
    },
    /// Terminates a running native session and its process tree.
    SessionTerminate {
        request_id: String,
        session_id: String,
    },
    /// Acknowledges consumption of stream events through the supplied sequence number.
    Acknowledge {
        target_request_id: String,
        sequence: u32,
    },
    /// Requests an orderly bridge shutdown.
    Shutdown { request_id: String },
}

/// Non-secret identity supplied by the TypeScript host during initialization.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientIdentity {
    pub name: String,
    pub version: String,
}

/// Request-scoped provider connection supplied to network operations.
///
/// This type intentionally does not implement `Debug` or `Display`.
///
/// ```compile_fail
/// use bridge_protocol::ProviderConnection;
/// let connection: ProviderConnection = todo!();
/// println!("{connection:?}");
/// ```
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConnection {
    pub provider_id: String,
    pub base_url: String,
    pub headers: BTreeMap<String, String>,
    pub authentication: ProviderAuthentication,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websocket_connect_timeout_ms: Option<u64>,
}

/// Bearer credentials are separated from ordinary provider headers.
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderAuthentication {
    Bearer { token: String },
    None,
}

/// Multiplexed operations supported by the bridge protocol.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RequestMethod {
    #[serde(rename = "responses.create")]
    ResponsesCreate,
    #[serde(rename = "responses.compact")]
    ResponsesCompact,
    #[serde(rename = "models.resolve")]
    ModelsResolve,
    #[serde(rename = "tools.resolve")]
    ToolsResolve,
    #[serde(rename = "tools.execute")]
    ToolsExecute,
    #[serde(rename = "diagnostics.read")]
    DiagnosticsRead,
}

/// An authorization decision made by Pi.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    AllowOnce,
    AllowSession,
    Decline,
    Cancel,
}

/// Authorization selected by Pi for one native request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeAuthorization {
    RequireApproval,
    Preauthorized,
}

impl ApprovalDecision {
    /// Decisions advertised on every approval request in protocol v2.
    ///
    /// Order is intentional: Decline, Cancel, then `AllowOnce`. Session-scoped allow is never
    /// advertised because Pi has no session approval policy surface.
    pub const ADVERTISED: [Self; 3] = [Self::Decline, Self::Cancel, Self::AllowOnce];

    /// Returns whether this decision is advertised to Pi for protocol v2 approvals.
    #[must_use]
    pub const fn is_advertised(self) -> bool {
        matches!(self, Self::Decline | Self::Cancel | Self::AllowOnce)
    }
}

/// A frame sent from the native bridge to the TypeScript host.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ServerMessage {
    /// Confirms baseline identity and reports only capabilities compiled into this bridge.
    Handshake {
        request_id: String,
        handshake: BridgeHandshake,
    },
    /// Delivers an ordered, non-terminal event for an in-flight request.
    Event {
        request_id: String,
        sequence: u32,
        event: Value,
    },
    /// Completes a request with a terminal status and method-specific result.
    Result {
        request_id: String,
        status: TerminalStatus,
        result: Value,
    },
    /// Reports a safe, categorized error. An absent request id means the frame was not correlatable.
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        error: BridgeError,
    },
    /// Pauses native execution until Pi returns an approval decision.
    ApprovalRequest {
        request_id: String,
        approval: ApprovalRequest,
    },
    /// Reports whether the bridge has paused or resumed event production.
    Backpressure {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        state: BackpressureState,
        pending_events: u32,
        capacity: u32,
    },
}

/// Immutable native identity returned during the initialization handshake.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeHandshake {
    pub bridge_protocol_version: u32,
    pub official_codex_version: String,
    pub official_codex_tag: String,
    pub official_source_commit: String,
    pub build_target: String,
    pub build_source_commit: String,
    pub vendor_tree_sha256: String,
    pub max_frame_bytes: usize,
    pub max_pending_events: u32,
    pub capabilities: Vec<BridgeCapability>,
}

/// Native features that can be compiled into a bridge binary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeCapability {
    ResponsesSse,
    ResponsesWebsocket,
    RemoteCompactionV2,
    CompactEndpoint,
    ModelMetadata,
    UpdatePlan,
    UnifiedExec,
    ShellCommand,
    ApplyPatch,
    ViewImage,
    ImageGeneration,
    StandaloneWebSearch,
    HostedWebSearch,
}

/// Request completion states exposed to TypeScript and Pi.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Completed,
    Incomplete,
    Failed,
    Aborted,
    TimedOut,
}

/// Public error categories from the product contract.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ErrorCategory {
    ConfigurationError,
    AuthenticationError,
    ProtocolError,
    CapabilityError,
    NativeToolError,
}

/// Error information that is safe to show in the Pi UI.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeError {
    pub category: ErrorCategory,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// A native operation that requires a Pi authorization and workspace policy decision.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub operation: ApprovalOperation,
    pub summary: String,
    pub details: Value,
    pub available_decisions: Vec<ApprovalDecision>,
}

/// Security-sensitive operation classes presented to Pi for authorization.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalOperation {
    Command,
    Patch,
    Filesystem,
    Network,
}

/// Current event flow state for the bounded bridge channel.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackpressureState {
    Paused,
    Resumed,
}

/// A bounded JSONL codec failure. It never includes the rejected frame contents.
#[derive(Debug)]
pub enum ProtocolCodecError {
    EmptyFrame,
    FrameTooLarge { actual: usize, maximum: usize },
    MultipleFrames,
    InvalidJson(serde_json::Error),
}

impl fmt::Display for ProtocolCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => formatter.write_str("bridge frame is empty"),
            Self::FrameTooLarge { actual, maximum } => write!(
                formatter,
                "bridge frame is {actual} bytes, exceeding the {maximum}-byte limit"
            ),
            Self::MultipleFrames => {
                formatter.write_str("bridge input contains multiple JSONL frames")
            }
            Self::InvalidJson(error) => match error.classify() {
                serde_json::error::Category::Data => {
                    formatter.write_str("bridge frame does not match protocol v2")
                }
                serde_json::error::Category::Io
                | serde_json::error::Category::Syntax
                | serde_json::error::Category::Eof => {
                    formatter.write_str("bridge frame is invalid JSON")
                }
            },
        }
    }
}

impl Error for ProtocolCodecError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidJson(error) => Some(error),
            Self::EmptyFrame | Self::FrameTooLarge { .. } | Self::MultipleFrames => None,
        }
    }
}

/// Decodes exactly one bounded client JSONL frame.
///
/// # Errors
///
/// Returns [`ProtocolCodecError`] when the frame is empty, oversized, contains more than one record,
/// or does not match the protocol v2 client envelope.
pub fn decode_client_frame(frame: &[u8]) -> Result<ClientMessage, ProtocolCodecError> {
    decode_frame(frame)
}

/// Decodes exactly one bounded server JSONL frame.
///
/// # Errors
///
/// Returns [`ProtocolCodecError`] when the frame is empty, oversized, contains more than one record,
/// or does not match the protocol v2 server envelope.
pub fn decode_server_frame(frame: &[u8]) -> Result<ServerMessage, ProtocolCodecError> {
    decode_frame(frame)
}

/// Encodes one server message as a bounded JSONL frame with a trailing newline.
///
/// # Errors
///
/// Returns [`ProtocolCodecError`] if serialization fails or the encoded payload exceeds
/// [`MAX_FRAME_BYTES`].
pub fn encode_server_frame(message: &ServerMessage) -> Result<Vec<u8>, ProtocolCodecError> {
    encode_frame(message)
}

/// Encodes one client message as a bounded JSONL frame with a trailing newline.
///
/// # Errors
///
/// Returns [`ProtocolCodecError`] if serialization fails or the encoded payload exceeds
/// [`MAX_FRAME_BYTES`].
pub fn encode_client_frame(message: &ClientMessage) -> Result<Vec<u8>, ProtocolCodecError> {
    encode_frame(message)
}

fn decode_frame<T: DeserializeOwned>(frame: &[u8]) -> Result<T, ProtocolCodecError> {
    let payload = if let Some(without_line_feed) = frame.strip_suffix(b"\n") {
        without_line_feed
            .strip_suffix(b"\r")
            .unwrap_or(without_line_feed)
    } else {
        frame
    };

    if payload.is_empty() {
        return Err(ProtocolCodecError::EmptyFrame);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolCodecError::FrameTooLarge {
            actual: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    if payload.contains(&b'\n') || payload.contains(&b'\r') {
        return Err(ProtocolCodecError::MultipleFrames);
    }

    serde_json::from_slice(payload).map_err(ProtocolCodecError::InvalidJson)
}

fn encode_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, ProtocolCodecError> {
    let mut payload = serde_json::to_vec(message).map_err(ProtocolCodecError::InvalidJson)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolCodecError::FrameTooLarge {
            actual: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    payload.push(b'\n');
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn expect_client_error(
        result: Result<ClientMessage, ProtocolCodecError>,
    ) -> ProtocolCodecError {
        match result {
            Ok(_) => panic!("client frame unexpectedly decoded"),
            Err(error) => error,
        }
    }

    #[test]
    fn decodes_every_recorded_client_contract_frame() {
        let fixture = include_bytes!("../../../../fixtures/bridge-protocol/client-v2.jsonl");

        for line in fixture.split_inclusive(|byte| *byte == b'\n') {
            decode_client_frame(line).expect("client fixture frame should decode");
        }
    }

    #[test]
    fn decodes_every_recorded_server_contract_frame() {
        let fixture = include_bytes!("../../../../fixtures/bridge-protocol/server-v2.jsonl");

        for line in fixture.split_inclusive(|byte| *byte == b'\n') {
            decode_server_frame(line).expect("server fixture frame should decode");
        }
    }

    #[test]
    fn round_trips_an_opaque_stream_event() {
        let message = ServerMessage::Event {
            request_id: "request-1".to_owned(),
            sequence: 3,
            event: json!({"type": "future.event", "opaque": {"retained": true}}),
        };

        let encoded = encode_server_frame(&message).expect("server message should encode");
        let decoded = decode_server_frame(&encoded).expect("server message should decode");

        assert_eq!(decoded, message);
    }

    #[test]
    fn rejects_unknown_envelope_fields() {
        let error = expect_client_error(decode_client_frame(
            br#"{"type":"shutdown","requestId":"request-1","unexpected":true}"#,
        ));

        assert!(matches!(error, ProtocolCodecError::InvalidJson(_)));
    }

    #[test]
    fn rejects_multiple_frames() {
        let error = expect_client_error(decode_client_frame(
            b"{\"type\":\"shutdown\",\"requestId\":\"one\"}\n{\"type\":\"shutdown\",\"requestId\":\"two\"}\n",
        ));

        assert!(matches!(error, ProtocolCodecError::MultipleFrames));
    }

    #[test]
    fn rejects_oversized_frames_without_echoing_contents() {
        let frame = vec![b'x'; MAX_FRAME_BYTES + 1];
        let error = expect_client_error(decode_client_frame(&frame));
        let display = error.to_string();

        assert!(matches!(error, ProtocolCodecError::FrameTooLarge { .. }));
        assert!(!display.contains("xxxxx"));
    }

    #[test]
    fn advertises_approval_decisions_in_safe_order() {
        assert_eq!(
            ApprovalDecision::ADVERTISED,
            [
                ApprovalDecision::Decline,
                ApprovalDecision::Cancel,
                ApprovalDecision::AllowOnce,
            ]
        );
        assert!(ApprovalDecision::Decline.is_advertised());
        assert!(ApprovalDecision::Cancel.is_advertised());
        assert!(ApprovalDecision::AllowOnce.is_advertised());
        assert!(!ApprovalDecision::AllowSession.is_advertised());
    }

    #[test]
    fn invalid_json_errors_do_not_echo_parser_snippets_or_secrets() {
        let secret = "fixture-secret-sentinel";
        let truncated = format!(
            r#"{{"type":"request","requestId":"request-1","method":"responses.create","params":{{"token":"{secret}""#
        );
        let error = expect_client_error(decode_client_frame(truncated.as_bytes()));
        let display = error.to_string();

        assert!(matches!(error, ProtocolCodecError::InvalidJson(_)));
        assert_eq!(display, "bridge frame is invalid JSON");
        assert!(!display.contains(secret));
        assert!(!display.contains("openai_api_key"));
        assert!(!display.contains("responses.create"));
    }

    #[test]
    fn schema_errors_do_not_echo_secret_bearing_frame_contents() {
        let secret = "fixture-secret-sentinel";
        let frame = format!(
            r#"{{"type":"initialize","requestId":"request-1","protocolVersion":2,"client":{{"name":"fixture","version":"0.0.0"}},"extra":true,"token":"{secret}"}}"#
        );
        let error = expect_client_error(decode_client_frame(frame.as_bytes()));
        let display = error.to_string();

        assert!(matches!(error, ProtocolCodecError::InvalidJson(_)));
        assert_eq!(display, "bridge frame does not match protocol v2");
        assert!(!display.contains(secret));
        assert!(!display.contains("initialize"));
        assert!(!display.contains("extra"));
    }

    #[test]
    fn valid_client_frames_still_decode_after_safe_error_hardening() {
        let frame = br#"{"type":"approval_decision","requestId":"decision-1","approvalId":"approval-1","decision":"allow_once"}"#;
        let message = decode_client_frame(frame).expect("valid approval decision should decode");
        assert!(matches!(
            message,
            ClientMessage::ApprovalDecision {
                decision: ApprovalDecision::AllowOnce,
                ..
            }
        ));
    }
}

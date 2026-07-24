use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::collections::hash_map::Entry;
use std::future::Future;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use bridge_protocol::ApprovalDecision;
use bridge_protocol::ApprovalOperation;
use bridge_protocol::ApprovalRequest;
use bridge_protocol::BRIDGE_PROTOCOL_VERSION;
use bridge_protocol::BackpressureState;
use bridge_protocol::BridgeCapability;
use bridge_protocol::BridgeError;
use bridge_protocol::BridgeHandshake;
use bridge_protocol::ClientMessage;
use bridge_protocol::ErrorCategory;
use bridge_protocol::MAX_FRAME_BYTES;
use bridge_protocol::MAX_PENDING_EVENTS;
use bridge_protocol::NativeAuthorization;
use bridge_protocol::OFFICIAL_CODEX_TAG;
use bridge_protocol::OFFICIAL_CODEX_VERSION;
use bridge_protocol::OFFICIAL_SOURCE_COMMIT;
use bridge_protocol::ProviderConnection;
use bridge_protocol::RequestMethod;
use bridge_protocol::ServerMessage;
use bridge_protocol::TerminalStatus;
use bridge_protocol::VENDOR_TREE_SHA256;
use bridge_protocol::decode_client_frame;
use bridge_protocol::encode_server_frame;
use codex_api::AllowedCaller;
use codex_api::CompactClient;
use codex_api::CompactionInput;
use codex_api::ExternalWebAccess;
use codex_api::ExternalWebAccessMode;
use codex_api::ImageBackground;
use codex_api::ImageEditRequest;
use codex_api::ImageGenerationRequest;
use codex_api::ImageQuality;
use codex_api::ImageUrl;
use codex_api::ImagesClient;
use codex_api::OpenAiVerbosity;
use codex_api::Reasoning;
use codex_api::ResponsesApiRequest;
use codex_api::ResponsesClient;
use codex_api::ResponsesOptions;
use codex_api::ResponsesWebsocketClient;
use codex_api::ResponsesWsRequest;
use codex_api::SearchClient;
use codex_api::SearchCommands;
use codex_api::SearchInput;
use codex_api::SearchRequest;
use codex_api::SearchSettings;
use codex_api::TextControls;
use codex_http_client::HttpClientFactory;
use codex_http_client::OutboundProxyPolicy;
use codex_protocol::config_types::WebSearchMode;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ConfigShellToolType;
use codex_protocol::openai_models::InputModality;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::protocol::TokenUsage;
use codex_tools::CommandToolOptions;
use codex_tools::ToolSpec;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::approx_token_count;
use codex_utils_output_truncation::formatted_truncate_text;
use http::HeaderMap;
use http::HeaderValue;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufRead;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::api;
use crate::official;

const INPUT_CHANNEL_CAPACITY: usize = 32;
const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const MAX_REQUEST_ID_BYTES: usize = 256;
const MAX_REQUEST_IDS_PER_CONNECTION: usize = 65_536;
const MAX_SESSION_OUTPUT_BYTES: usize = codex_utils_pty::DEFAULT_OUTPUT_BYTES_CAP;
const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
const PORTABLE_SUMMARY_TIMEOUT_MS: u64 = 600_000;
const PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS: usize = 1_024;
const PORTABLE_SUMMARY_V1_INSTRUCTIONS: &str = "Summarize this conversation context for future continuation. Return plain text only. Preserve the user's goals, decisions, constraints, pending work, tool outcomes, and important factual state. Be concise and do not add markdown, bullets, or commentary about the summarization process.";
const MAX_IMAGE_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_RESULT_BYTES: usize = 12 * 1024 * 1024;
const MAX_IMAGE_REFERENCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_REFERENCE_DATA_URL_BYTES: usize = 64 * 1024 * 1024;
const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMAGE_PROMPT_BYTES: usize = 64 * 1024;
const MAX_GENERATED_IMAGE_BYTES: usize = 24 * 1024 * 1024;
const PREAUTHORIZED_TOOLS: &[&str] = &[
    "exec_command",
    "shell_command",
    "write_stdin",
    "apply_patch",
    "view_image",
    "image_gen.imagegen",
    "web.run",
];
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_APPROVAL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct BuildIdentity {
    pub target: String,
    pub source_commit: String,
}

struct ActiveRequest {
    cancellation: CancellationToken,
    flow: Arc<FlowController>,
}

#[derive(Default)]
struct NativeSessions {
    entries: Mutex<HashMap<u64, Arc<NativeSession>>>,
}

struct NativeSession {
    process: Arc<codex_utils_pty::ProcessHandle>,
    output: Mutex<SessionOutput>,
    changed: Notify,
}

#[derive(Default)]
struct SessionOutput {
    chunks: VecDeque<ProcessOutputChunk>,
    retained_bytes: usize,
    original_bytes: usize,
    truncated: bool,
    exit_code: Option<i32>,
    stdout_open: bool,
    stderr_open: bool,
}

struct ProcessOutputChunk {
    stream: &'static str,
    bytes: Vec<u8>,
}

struct SessionSnapshot {
    chunks: Vec<ProcessOutputChunk>,
    output: String,
    original_bytes: usize,
    truncated: bool,
    exit_code: Option<i32>,
}

impl NativeSessions {
    async fn insert(&self, session: Arc<NativeSession>) -> u64 {
        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        self.entries.lock().await.insert(id, session);
        id
    }

    async fn get(&self, session_id: &str) -> Option<(u64, Arc<NativeSession>)> {
        let id = parse_session_id(session_id)?;
        self.entries
            .lock()
            .await
            .get(&id)
            .cloned()
            .map(|session| (id, session))
    }

    async fn remove(&self, id: u64) -> Option<Arc<NativeSession>> {
        self.entries.lock().await.remove(&id)
    }

    async fn terminate_all(&self) {
        let sessions = self
            .entries
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            session.process.terminate();
        }
    }
}

impl NativeSession {
    fn start(process: codex_utils_pty::SpawnedProcess) -> Arc<Self> {
        let codex_utils_pty::SpawnedProcess {
            session,
            stdout_rx,
            stderr_rx,
            exit_rx,
        } = process;
        let session = Arc::new(Self {
            process: Arc::new(session),
            output: Mutex::new(SessionOutput {
                stdout_open: true,
                stderr_open: true,
                ..SessionOutput::default()
            }),
            changed: Notify::new(),
        });
        spawn_session_drainers(Arc::clone(&session), stdout_rx, stderr_rx, exit_rx);
        session
    }

    async fn append(&self, stream: &'static str, bytes: Vec<u8>) {
        let mut output = self.output.lock().await;
        output.original_bytes = output.original_bytes.saturating_add(bytes.len());
        if output.retained_bytes >= MAX_SESSION_OUTPUT_BYTES {
            output.truncated = true;
        } else {
            let retain = bytes
                .len()
                .min(MAX_SESSION_OUTPUT_BYTES - output.retained_bytes);
            if retain < bytes.len() {
                output.truncated = true;
            }
            if retain > 0 {
                output.retained_bytes += retain;
                output.chunks.push_back(ProcessOutputChunk {
                    stream,
                    bytes: bytes[..retain].to_vec(),
                });
            }
        }
        drop(output);
        self.changed.notify_waiters();
    }

    async fn set_exit_code(&self, exit_code: i32) {
        self.output.lock().await.exit_code = Some(exit_code);
        self.changed.notify_waiters();
    }

    async fn close_stream(&self, stream: &'static str) {
        let mut output = self.output.lock().await;
        if stream == "stdout" {
            output.stdout_open = false;
        } else {
            output.stderr_open = false;
        }
        drop(output);
        self.changed.notify_waiters();
    }

    async fn is_drained(&self) -> bool {
        let output = self.output.lock().await;
        output.exit_code.is_some() && !output.stdout_open && !output.stderr_open
    }

    async fn snapshot(&self) -> SessionSnapshot {
        let mut output = self.output.lock().await;
        let chunks = output.chunks.drain(..).collect::<Vec<_>>();
        let mut text = String::new();
        for chunk in &chunks {
            text.push_str(&String::from_utf8_lossy(&chunk.bytes));
        }
        let snapshot = SessionSnapshot {
            chunks,
            output: text,
            original_bytes: output.original_bytes,
            truncated: output.truncated,
            exit_code: output.exit_code,
        };
        output.retained_bytes = 0;
        output.original_bytes = 0;
        output.truncated = false;
        snapshot
    }
}

fn spawn_session_drainers(
    session: Arc<NativeSession>,
    mut stdout_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut stderr_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut exit_rx: tokio::sync::oneshot::Receiver<i32>,
) {
    let stdout_session = Arc::clone(&session);
    tokio::spawn(async move {
        while let Some(bytes) = stdout_rx.recv().await {
            stdout_session.append("stdout", bytes).await;
        }
        stdout_session.close_stream("stdout").await;
    });
    let stderr_session = Arc::clone(&session);
    tokio::spawn(async move {
        while let Some(bytes) = stderr_rx.recv().await {
            stderr_session.append("stderr", bytes).await;
        }
        stderr_session.close_stream("stderr").await;
    });
    tokio::spawn(async move {
        if let Ok(exit_code) = (&mut exit_rx).await {
            session.set_exit_code(exit_code).await;
        }
    });
}

enum InputEvent {
    Message(ClientMessage),
    ProtocolFailure(String),
    ReadFailure,
    Eof,
}

enum ReadFrameError {
    Io,
    TooLarge,
}

struct FlowState {
    last_sent: u32,
    last_acknowledged: u32,
    paused: bool,
}

struct FlowController {
    request_id: String,
    output: mpsc::Sender<ServerMessage>,
    state: Mutex<FlowState>,
    acknowledgement: Notify,
}

#[derive(Clone, Copy, Debug)]
enum EmitError {
    Cancelled,
    OutputClosed,
    SequenceExhausted,
}

#[derive(Debug)]
enum AcknowledgeError {
    FutureSequence,
    OutputClosed,
}

#[derive(Clone, Copy)]
enum RequestIdError {
    Invalid,
    Duplicate,
}

impl FlowController {
    fn new(request_id: String, output: mpsc::Sender<ServerMessage>) -> Self {
        Self {
            request_id,
            output,
            state: Mutex::new(FlowState {
                last_sent: 0,
                last_acknowledged: 0,
                paused: false,
            }),
            acknowledgement: Notify::new(),
        }
    }

    async fn emit(&self, event: Value, cancellation: &CancellationToken) -> Result<u32, EmitError> {
        loop {
            let mut state = self.state.lock().await;
            let pending = state.last_sent - state.last_acknowledged;
            if pending < MAX_PENDING_EVENTS {
                let Some(sequence) = state.last_sent.checked_add(1) else {
                    return Err(EmitError::SequenceExhausted);
                };
                state.last_sent = sequence;
                drop(state);
                self.output
                    .send(ServerMessage::Event {
                        request_id: self.request_id.clone(),
                        sequence,
                        event,
                    })
                    .await
                    .map_err(|_| EmitError::OutputClosed)?;
                return Ok(sequence);
            }

            let announce_pause = !state.paused;
            state.paused = true;
            drop(state);
            if announce_pause {
                self.output
                    .send(ServerMessage::Backpressure {
                        request_id: Some(self.request_id.clone()),
                        state: BackpressureState::Paused,
                        pending_events: MAX_PENDING_EVENTS,
                        capacity: MAX_PENDING_EVENTS,
                    })
                    .await
                    .map_err(|_| EmitError::OutputClosed)?;
            }

            tokio::select! {
                () = self.acknowledgement.notified() => {}
                () = cancellation.cancelled() => return Err(EmitError::Cancelled),
            }
        }
    }

    async fn acknowledge(&self, sequence: u32) -> Result<(), AcknowledgeError> {
        let mut state = self.state.lock().await;
        if sequence > state.last_sent {
            return Err(AcknowledgeError::FutureSequence);
        }
        if sequence <= state.last_acknowledged {
            return Ok(());
        }

        state.last_acknowledged = sequence;
        let pending = state.last_sent - state.last_acknowledged;
        let announce_resume = state.paused;
        state.paused = false;
        drop(state);
        self.acknowledgement.notify_waiters();

        if announce_resume {
            self.output
                .send(ServerMessage::Backpressure {
                    request_id: Some(self.request_id.clone()),
                    state: BackpressureState::Resumed,
                    pending_events: pending,
                    capacity: MAX_PENDING_EVENTS,
                })
                .await
                .map_err(|_| AcknowledgeError::OutputClosed)?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosticsParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponsesCreateParams {
    connection: ProviderConnection,
    request: ResponsesApiRequest,
    transport_mode: ResponsesTransportMode,
    provider_supports_websockets: bool,
    #[serde(default)]
    remote_compaction_v2_context: Option<RemoteCompactionV2Context>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextsSummarizeParams {
    connection: ProviderConnection,
    model_id: String,
    input: Vec<ResponseItem>,
    #[serde(default)]
    transport_mode: ResponsesTransportMode,
    #[serde(default = "default_provider_websocket_capability")]
    provider_supports_websockets: bool,
    #[serde(default)]
    remote_compaction_v2_context: Option<RemoteCompactionV2Context>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ResponsesTransportMode {
    #[default]
    Auto,
    Sse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponsesCompactParams {
    connection: ProviderConnection,
    request: OwnedCompactionInput,
    #[serde(default)]
    implementation: CompactionImplementation,
    #[serde(default)]
    transport_mode: ResponsesTransportMode,
    #[serde(default = "default_provider_websocket_capability")]
    provider_supports_websockets: bool,
    #[serde(default = "default_compaction_timeout_ms")]
    request_timeout_ms: u64,
    #[serde(default)]
    remote_compaction_v2_context: Option<RemoteCompactionV2Context>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CompactionImplementation {
    #[default]
    CompactEndpoint,
    RemoteV2,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteCompactionV2Context {
    session_id: String,
    #[serde(default)]
    compaction_trigger: Option<RemoteCompactionV2Trigger>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RemoteCompactionV2Trigger {
    Auto,
    Manual,
}

#[derive(Clone, Copy)]
enum RemoteCompactionV2RequestKind {
    Turn,
    Compaction,
}

#[derive(Clone, Copy)]
struct RemoteCompactionV2RequestMetadata<'a> {
    context: Option<&'a RemoteCompactionV2Context>,
    kind: RemoteCompactionV2RequestKind,
}

impl RemoteCompactionV2Context {
    fn validate(self) -> Result<Self, BridgeError> {
        if self.session_id.is_empty()
            || self.session_id.len() > 256
            || self.session_id.contains(['\r', '\n'])
        {
            return Err(invalid_params(
                "remote compaction v2 session context is invalid",
            ));
        }
        Ok(self)
    }

    fn apply_to_request(
        &self,
        request: &mut ResponsesApiRequest,
        kind: RemoteCompactionV2RequestKind,
    ) -> Result<(), BridgeError> {
        let mut metadata = request.client_metadata.take().unwrap_or_default();
        metadata.extend(self.client_metadata(kind)?);
        request.client_metadata = Some(metadata);
        Ok(())
    }

    fn responses_options(
        &self,
        kind: RemoteCompactionV2RequestKind,
    ) -> Result<ResponsesOptions, BridgeError> {
        Ok(ResponsesOptions {
            session_id: Some(self.session_id.clone()),
            thread_id: Some(self.session_id.clone()),
            extra_headers: self.extra_headers(kind)?,
            ..ResponsesOptions::default()
        })
    }

    fn websocket_headers(
        &self,
        kind: RemoteCompactionV2RequestKind,
    ) -> Result<HeaderMap, BridgeError> {
        let mut headers = self.extra_headers(kind)?;
        insert_remote_v2_header(&mut headers, "session-id", &self.session_id)?;
        insert_remote_v2_header(&mut headers, "thread-id", &self.session_id)?;
        insert_remote_v2_header(&mut headers, "x-client-request-id", &self.session_id)?;
        Ok(headers)
    }

    fn client_metadata(
        &self,
        kind: RemoteCompactionV2RequestKind,
    ) -> Result<HashMap<String, String>, BridgeError> {
        Ok(HashMap::from([
            ("session_id".to_owned(), self.session_id.clone()),
            ("thread_id".to_owned(), self.session_id.clone()),
            ("x-codex-window-id".to_owned(), self.session_id.clone()),
            (
                "x-codex-turn-metadata".to_owned(),
                self.turn_metadata(kind)?,
            ),
        ]))
    }

    fn extra_headers(&self, kind: RemoteCompactionV2RequestKind) -> Result<HeaderMap, BridgeError> {
        let mut headers = HeaderMap::new();
        insert_remote_v2_header(
            &mut headers,
            "x-codex-beta-features",
            "remote_compaction_v2",
        )?;
        insert_remote_v2_header(&mut headers, "x-codex-window-id", &self.session_id)?;
        insert_remote_v2_header(
            &mut headers,
            "x-codex-turn-metadata",
            &self.turn_metadata(kind)?,
        )?;
        Ok(headers)
    }

    fn turn_metadata(&self, kind: RemoteCompactionV2RequestKind) -> Result<String, BridgeError> {
        let base = json!({
            "session_id": self.session_id,
            "thread_id": self.session_id,
            "window_id": self.session_id,
        });
        let mut metadata = base
            .as_object()
            .cloned()
            .ok_or_else(|| invalid_params("remote compaction v2 metadata could not be encoded"))?;
        match kind {
            RemoteCompactionV2RequestKind::Turn => {
                metadata.insert("request_kind".to_owned(), json!("turn"));
            }
            RemoteCompactionV2RequestKind::Compaction => {
                let trigger = self
                    .compaction_trigger
                    .unwrap_or(RemoteCompactionV2Trigger::Auto);
                let (trigger, reason, phase) = match trigger {
                    RemoteCompactionV2Trigger::Auto => ("auto", "context_limit", "pre_turn"),
                    RemoteCompactionV2Trigger::Manual => {
                        ("manual", "user_requested", "standalone_turn")
                    }
                };
                metadata.insert("request_kind".to_owned(), json!("compaction"));
                metadata.insert(
                    "compaction".to_owned(),
                    json!({
                        "trigger": trigger,
                        "reason": reason,
                        "implementation": "responses_compaction_v2",
                        "phase": phase,
                        "strategy": "memento",
                    }),
                );
            }
        }
        serde_json::to_string(&metadata)
            .map_err(|_| invalid_params("remote compaction v2 metadata could not be encoded"))
    }
}

fn insert_remote_v2_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &str,
) -> Result<(), BridgeError> {
    let value = HeaderValue::from_str(value)
        .map_err(|_| invalid_params("remote compaction v2 session context is invalid"))?;
    headers.insert(name, value);
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedCompactionInput {
    model: String,
    input: Vec<ResponseItem>,
    #[serde(default)]
    instructions: String,
    tools: Option<Vec<Value>>,
    parallel_tool_calls: bool,
    reasoning: Option<Reasoning>,
    service_tier: Option<String>,
    prompt_cache_key: Option<String>,
    text: Option<TextControls>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelsResolveParams {
    model_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolsResolveParams {
    model: ModelInfo,
    web_search_mode: WebSearchMode,
    provider_contract: CompleteProviderContract,
    standalone_web_search: StandaloneWebSearchCapabilities,
    sessions: SessionCapabilities,
    shell: ShellToolOptions,
    #[serde(default)]
    optional: OptionalToolCapabilities,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)]
struct CompleteProviderContract {
    responses_sse: bool,
    responses_websocket: ProviderWebsocketContract,
    remote_compaction_v2: bool,
    compact_endpoint: bool,
    hosted_web_search: bool,
    namespace_tools: bool,
    images_api: bool,
    search_api: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ProviderWebsocketContract {
    OfficialOnly,
    Unavailable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionCapabilities {
    enabled: bool,
    executor_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StandaloneWebSearchCapabilities {
    feature_enabled: bool,
    executor_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShellToolOptions {
    allow_login_shell: bool,
    exec_permission_approvals_enabled: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OptionalToolCapabilities {
    view_image: bool,
    image_generation: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolExecuteParams {
    tool: String,
    authorization: NativeAuthorization,
    #[serde(default)]
    connection: Option<ProviderConnection>,
    command: Option<String>,
    cmd: Option<String>,
    #[serde(default)]
    workdir: String,
    #[serde(default)]
    workspace_roots: Vec<String>,
    #[serde(alias = "timeout_ms")]
    timeout_ms: Option<u64>,
    shell: Option<String>,
    tty: Option<bool>,
    #[serde(alias = "yield_time_ms")]
    yield_time_ms: Option<u64>,
    #[serde(alias = "max_output_tokens")]
    max_output_tokens: Option<u64>,
    #[serde(default)]
    login: Option<bool>,
    #[serde(default = "default_allow_login_shell", alias = "allow_login_shell")]
    allow_login_shell: bool,
    #[serde(alias = "allow_background_sessions")]
    allow_background_sessions: Option<bool>,
    #[serde(alias = "session_id")]
    session_id: Option<u64>,
    chars: Option<String>,
    path: Option<String>,
    detail: Option<String>,
    input: Option<String>,
    prompt: Option<String>,
    #[serde(alias = "referenced_image_paths")]
    referenced_image_paths: Option<Vec<String>>,
    #[serde(alias = "num_last_images_to_include")]
    num_last_images_to_include: Option<usize>,
    #[serde(alias = "recent_image_urls")]
    recent_image_urls: Option<Vec<String>>,
    commands: Option<Value>,
    #[serde(default, alias = "conversation_items")]
    conversation_items: Vec<ResponseItem>,
    model: Option<String>,
    #[serde(alias = "request_session_id")]
    request_session_id: Option<String>,
    #[serde(alias = "web_search_mode")]
    web_search_mode: Option<WebSearchMode>,
}

const fn default_compaction_timeout_ms() -> u64 {
    120_000
}

const fn default_allow_login_shell() -> bool {
    true
}

const fn default_provider_websocket_capability() -> bool {
    true
}

enum ConnectionControl {
    Continue,
    Stop(Option<String>),
}

struct ConnectionState {
    initialized: bool,
    seen_request_ids: HashSet<String>,
    active: HashMap<String, ActiveRequest>,
    requests: JoinSet<String>,
    output: mpsc::Sender<ServerMessage>,
    approvals: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    sessions: Arc<NativeSessions>,
    identity: Arc<BuildIdentity>,
}

struct RequestTask {
    request_id: String,
    method: RequestMethod,
    params: Value,
    cancellation: CancellationToken,
    flow: Arc<FlowController>,
    output: mpsc::Sender<ServerMessage>,
    identity: Arc<BuildIdentity>,
    approvals: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    sessions: Arc<NativeSessions>,
}

struct DispatchContext<'a> {
    request_id: &'a str,
    identity: &'a BuildIdentity,
    flow: &'a FlowController,
    cancellation: &'a CancellationToken,
    output: &'a mpsc::Sender<ServerMessage>,
    approvals: &'a Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    sessions: &'a Arc<NativeSessions>,
}

impl ConnectionState {
    fn new(output: mpsc::Sender<ServerMessage>, identity: BuildIdentity) -> Self {
        Self {
            initialized: false,
            seen_request_ids: HashSet::new(),
            active: HashMap::new(),
            requests: JoinSet::new(),
            output,
            approvals: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(NativeSessions::default()),
            identity: Arc::new(identity),
        }
    }

    async fn handle_message(&mut self, message: ClientMessage) -> io::Result<ConnectionControl> {
        if self.initialized && self.seen_request_ids.len() >= MAX_REQUEST_IDS_PER_CONNECTION {
            send(
                &self.output,
                protocol_error(
                    None,
                    "request_limit_exceeded",
                    "the bridge connection has reached its request limit".to_owned(),
                ),
            )
            .await?;
            return Ok(ConnectionControl::Stop(None));
        }
        if self.initialized {
            self.handle_initialized(message).await
        } else {
            self.initialize(message).await
        }
    }

    async fn initialize(&mut self, message: ClientMessage) -> io::Result<ConnectionControl> {
        let ClientMessage::Initialize {
            request_id,
            protocol_version,
            ..
        } = message
        else {
            send(
                &self.output,
                protocol_error(
                    None,
                    "initialization_required",
                    format!(
                        "the first client frame must initialize protocol v{BRIDGE_PROTOCOL_VERSION}"
                    ),
                ),
            )
            .await?;
            return Ok(ConnectionControl::Stop(None));
        };

        if let Err(error) = claim_request_id(&mut self.seen_request_ids, &request_id) {
            send(&self.output, request_id_error(error, request_id)).await?;
            return Ok(ConnectionControl::Stop(None));
        }
        if protocol_version != BRIDGE_PROTOCOL_VERSION {
            send(
                &self.output,
                protocol_error(
                    Some(request_id),
                    "protocol_version_mismatch",
                    format!(
                        "bridge protocol version {protocol_version} is unsupported; expected {BRIDGE_PROTOCOL_VERSION}"
                    ),
                ),
            )
            .await?;
            return Ok(ConnectionControl::Stop(None));
        }
        self.initialized = true;
        send(
            &self.output,
            ServerMessage::Handshake {
                request_id,
                handshake: handshake(&self.identity),
            },
        )
        .await?;
        Ok(ConnectionControl::Continue)
    }

    async fn handle_initialized(
        &mut self,
        message: ClientMessage,
    ) -> io::Result<ConnectionControl> {
        match message {
            ClientMessage::Initialize { request_id, .. } => {
                self.reject_reinitialization(request_id).await?;
            }
            ClientMessage::Request {
                request_id,
                method,
                params,
            } => self.start_request(request_id, method, params).await?,
            ClientMessage::Cancel {
                request_id,
                target_request_id,
            } => self.cancel_request(request_id, target_request_id).await?,
            ClientMessage::Acknowledge {
                target_request_id,
                sequence,
            } => self.acknowledge(target_request_id, sequence).await?,
            ClientMessage::ApprovalDecision {
                request_id,
                approval_id,
                decision,
            } => {
                self.resolve_approval(request_id, approval_id, decision)
                    .await?;
            }
            ClientMessage::Shutdown { request_id } => {
                if self.claim(&request_id).await? {
                    return Ok(ConnectionControl::Stop(Some(request_id)));
                }
            }
            ClientMessage::SessionWrite {
                request_id,
                session_id,
                authorization,
                data,
            } => {
                self.write_session(request_id, session_id, authorization, data)
                    .await?;
            }
            ClientMessage::SessionResize {
                request_id,
                session_id,
                columns,
                rows,
            } => {
                self.resize_session(request_id, session_id, columns, rows)
                    .await?;
            }
            ClientMessage::SessionTerminate {
                request_id,
                session_id,
            } => self.terminate_session(request_id, session_id).await?,
        }
        Ok(ConnectionControl::Continue)
    }

    async fn reject_reinitialization(&mut self, request_id: String) -> io::Result<()> {
        let message = match claim_request_id(&mut self.seen_request_ids, &request_id) {
            Ok(()) => protocol_error(
                Some(request_id),
                "already_initialized",
                "the bridge connection is already initialized".to_owned(),
            ),
            Err(error) => request_id_error(error, request_id),
        };
        send(&self.output, message).await
    }

    #[allow(clippy::large_futures)]
    async fn start_request(
        &mut self,
        request_id: String,
        method: RequestMethod,
        params: Value,
    ) -> io::Result<()> {
        if !self.claim(&request_id).await? {
            return Ok(());
        }
        let cancellation = CancellationToken::new();
        let flow = Arc::new(FlowController::new(request_id.clone(), self.output.clone()));
        self.active.insert(
            request_id.clone(),
            ActiveRequest {
                cancellation: cancellation.clone(),
                flow: Arc::clone(&flow),
            },
        );
        let task_output = self.output.clone();
        let task_identity = Arc::clone(&self.identity);
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&self.approvals);
        let task_sessions = Arc::clone(&self.sessions);
        self.requests.spawn(async move {
            run_request(RequestTask {
                request_id,
                method,
                params,
                cancellation,
                flow: task_flow,
                output: task_output,
                identity: task_identity,
                approvals: task_approvals,
                sessions: task_sessions,
            })
            .await
        });
        Ok(())
    }

    async fn cancel_request(
        &mut self,
        request_id: String,
        target_request_id: String,
    ) -> io::Result<()> {
        if !self.claim(&request_id).await? {
            return Ok(());
        }
        if let Some(request) = self.active.get(&target_request_id) {
            request.cancellation.cancel();
            self.complete(request_id, json!({ "targetRequestId": target_request_id }))
                .await
        } else {
            send(
                &self.output,
                protocol_error(
                    Some(request_id),
                    "unknown_request",
                    "the cancellation target is not active".to_owned(),
                ),
            )
            .await
        }
    }

    async fn acknowledge(&self, target_request_id: String, sequence: u32) -> io::Result<()> {
        let Some(request) = self.active.get(&target_request_id) else {
            if self.seen_request_ids.contains(&target_request_id) {
                return Ok(());
            }
            return send(
                &self.output,
                protocol_error(
                    None,
                    "unknown_acknowledgement_target",
                    "the acknowledgement target is not active".to_owned(),
                ),
            )
            .await;
        };
        match request.flow.acknowledge(sequence).await {
            Ok(()) => Ok(()),
            Err(AcknowledgeError::FutureSequence) => {
                send(
                    &self.output,
                    protocol_error(
                        None,
                        "invalid_acknowledgement",
                        "the acknowledgement sequence is invalid".to_owned(),
                    ),
                )
                .await
            }
            Err(AcknowledgeError::OutputClosed) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "bridge stdout channel is closed",
            )),
        }
    }

    async fn resolve_approval(
        &mut self,
        request_id: String,
        approval_id: String,
        decision: ApprovalDecision,
    ) -> io::Result<()> {
        if !self.claim(&request_id).await? {
            return Ok(());
        }
        if !decision.is_advertised() {
            return send(
                &self.output,
                protocol_error(
                    Some(request_id),
                    "unadvertised_approval_decision",
                    "allow_session is not an advertised approval decision".to_owned(),
                ),
            )
            .await;
        }
        let sender = self.approvals.lock().await.remove(&approval_id);
        let Some(sender) = sender else {
            // Late or cancelled approvals are no-ops. Completing them keeps the
            // TypeScript decision path from treating an expired id as a fatal
            // protocol failure that tears down the whole bridge connection.
            return self
                .complete(
                    request_id,
                    json!({
                        "approvalId": approval_id,
                        "status": "expired",
                    }),
                )
                .await;
        };
        let _ = sender.send(decision);
        self.complete(request_id, json!({ "approvalId": approval_id }))
            .await
    }

    async fn write_session(
        &mut self,
        request_id: String,
        session_id: String,
        authorization: NativeAuthorization,
        data: String,
    ) -> io::Result<()> {
        if !self.claim(&request_id).await? {
            return Ok(());
        }
        let Some((numeric_id, session)) = self.sessions.get(&session_id).await else {
            return send(&self.output, unknown_session(request_id)).await;
        };
        if session.process.has_exited() {
            self.sessions.remove(numeric_id).await;
            return send(&self.output, unknown_session(request_id)).await;
        }
        // Empty control-frame writes are non-mutating and do not re-prompt.
        if data.is_empty() {
            return self
                .complete(request_id, json!({ "sessionId": session_id }))
                .await;
        }
        // Non-empty writes must be authorized before mutating process stdin.
        // Approval correlation requires a background task so the connection loop can
        // still process approval_decision frames.
        let cancellation = CancellationToken::new();
        let flow = Arc::new(FlowController::new(request_id.clone(), self.output.clone()));
        self.active.insert(
            request_id.clone(),
            ActiveRequest {
                cancellation: cancellation.clone(),
                flow,
            },
        );
        let output = self.output.clone();
        let approvals = Arc::clone(&self.approvals);
        self.requests.spawn(async move {
            // Per-operation cancellation is enforced inside write_session_stdin
            // (approval wait and the pre-mutation commit check). An outer select
            // would drop those cleanups and leak approval-map entries.
            let message = match write_session_stdin(
                &request_id,
                &session_id,
                authorization,
                data,
                &session,
                &output,
                &approvals,
                &cancellation,
            )
            .await
            {
                Ok(result) => ServerMessage::Result {
                    request_id: request_id.clone(),
                    status: TerminalStatus::Completed,
                    result,
                },
                Err(RequestFailure::Bridge(error)) => ServerMessage::Error {
                    request_id: Some(request_id.clone()),
                    error,
                },
                Err(RequestFailure::Cancelled) => ServerMessage::Result {
                    request_id: request_id.clone(),
                    status: TerminalStatus::Aborted,
                    result: json!({}),
                },
            };
            let _ = output.send(message).await;
            request_id
        });
        Ok(())
    }

    async fn resize_session(
        &mut self,
        request_id: String,
        session_id: String,
        columns: u16,
        rows: u16,
    ) -> io::Result<()> {
        if !self.claim(&request_id).await? {
            return Ok(());
        }
        let Some((_, session)) = self.sessions.get(&session_id).await else {
            return send(&self.output, unknown_session(request_id)).await;
        };
        if session
            .process
            .resize(codex_utils_pty::TerminalSize {
                rows,
                cols: columns,
            })
            .is_err()
        {
            return send(&self.output, non_pty_session(request_id)).await;
        }
        self.complete(
            request_id,
            json!({ "sessionId": session_id, "columns": columns, "rows": rows }),
        )
        .await
    }

    async fn terminate_session(
        &mut self,
        request_id: String,
        session_id: String,
    ) -> io::Result<()> {
        if !self.claim(&request_id).await? {
            return Ok(());
        }
        let Some(numeric_id) = parse_session_id(&session_id) else {
            return send(&self.output, unknown_session(request_id)).await;
        };
        let Some(session) = self.sessions.remove(numeric_id).await else {
            return send(&self.output, unknown_session(request_id)).await;
        };
        session.process.request_terminate();
        self.complete(request_id, json!({ "sessionId": session_id }))
            .await
    }

    async fn claim(&mut self, request_id: &str) -> io::Result<bool> {
        match claim_request_id(&mut self.seen_request_ids, request_id) {
            Ok(()) => Ok(true),
            Err(error) => {
                send(&self.output, request_id_error(error, request_id.to_owned())).await?;
                Ok(false)
            }
        }
    }

    async fn complete(&self, request_id: String, result: Value) -> io::Result<()> {
        send(
            &self.output,
            ServerMessage::Result {
                request_id,
                status: TerminalStatus::Completed,
                result,
            },
        )
        .await
    }

    fn remove_completed(&mut self, completed: Option<Result<String, tokio::task::JoinError>>) {
        if let Some(Ok(request_id)) = completed {
            self.active.remove(&request_id);
        }
    }

    async fn cancel_and_join_requests(&mut self) {
        for request in self.active.values() {
            request.cancellation.cancel();
        }
        let shutdown_deadline = tokio::time::sleep(request_shutdown_timeout());
        tokio::pin!(shutdown_deadline);
        while !self.requests.is_empty() {
            tokio::select! {
                completed = self.requests.join_next() => self.remove_completed(completed),
                () = &mut shutdown_deadline => {
                    self.requests.abort_all();
                    break;
                }
            }
        }
        while let Some(completed) = self.requests.join_next().await {
            self.remove_completed(Some(completed));
        }
        self.active.clear();
        self.sessions.terminate_all().await;
    }
}

pub async fn serve<R, W>(reader: R, writer: W, identity: BuildIdentity) -> io::Result<()>
where
    R: AsyncBufRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (input_tx, mut input_rx) = mpsc::channel(INPUT_CHANNEL_CAPACITY);
    let reader_task = tokio::spawn(read_loop(reader, input_tx));
    let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel();
    let writer_task = tokio::spawn(async move {
        let result = write_loop(writer, output_rx).await;
        let _ = writer_done_tx.send(result);
    });
    let mut state = ConnectionState::new(output_tx, identity);
    let mut shutdown_request_id = None;
    let mut writer_result = None;

    loop {
        tokio::select! {
            input = input_rx.recv() => {
                match handle_input(&mut state, input).await? {
                    ConnectionControl::Continue => {}
                    ConnectionControl::Stop(request_id) => {
                        shutdown_request_id = request_id;
                        break;
                    }
                }
            }
            completed = state.requests.join_next(), if !state.requests.is_empty() => {
                state.remove_completed(completed);
            }
            result = &mut writer_done_rx => {
                writer_result = Some(writer_task_result(result));
                break;
            }
        }
    }

    reader_task.abort();
    state.cancel_and_join_requests().await;
    if let Some(request_id) = shutdown_request_id {
        state.complete(request_id, json!({})).await?;
    }
    drop(state);

    if writer_result.is_none() {
        writer_result = Some(writer_task_result(writer_done_rx.await));
    }
    let _ = writer_task.await;
    writer_result.unwrap_or(Ok(()))
}

async fn handle_input(
    state: &mut ConnectionState,
    input: Option<InputEvent>,
) -> io::Result<ConnectionControl> {
    match input {
        Some(InputEvent::Message(message)) => state.handle_message(message).await,
        Some(InputEvent::ProtocolFailure(message)) => {
            send(
                &state.output,
                protocol_error(None, "invalid_frame", message),
            )
            .await?;
            Ok(ConnectionControl::Stop(None))
        }
        Some(InputEvent::ReadFailure) => {
            send(
                &state.output,
                protocol_error(
                    None,
                    "stdin_read_failed",
                    "the bridge could not read its stdin channel".to_owned(),
                ),
            )
            .await?;
            Ok(ConnectionControl::Stop(None))
        }
        Some(InputEvent::Eof) | None => Ok(ConnectionControl::Stop(None)),
    }
}

fn writer_task_result(result: Result<io::Result<()>, oneshot::error::RecvError>) -> io::Result<()> {
    result.unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "bridge stdout task stopped",
        ))
    })
}

#[allow(clippy::large_futures)]
async fn run_request(task: RequestTask) -> String {
    let RequestTask {
        request_id,
        method,
        params,
        cancellation,
        flow,
        output,
        identity,
        approvals,
        sessions,
    } = task;
    // Cancellation is cooperative and checked at operation-defined points.
    // Racing the entire dispatch future would drop approval-map cleanup and
    // could report `aborted` while a blocking apply_patch mutation continues.
    let message = match dispatch(
        method,
        params,
        DispatchContext {
            request_id: &request_id,
            identity: &identity,
            flow: &flow,
            cancellation: &cancellation,
            output: &output,
            approvals: &approvals,
            sessions: &sessions,
        },
    )
    .await
    {
        Ok(result) => ServerMessage::Result {
            request_id: request_id.clone(),
            status: result.status,
            result: result.result,
        },
        Err(RequestFailure::Bridge(error)) => ServerMessage::Error {
            request_id: Some(request_id.clone()),
            error,
        },
        Err(RequestFailure::Cancelled) => ServerMessage::Result {
            request_id: request_id.clone(),
            status: TerminalStatus::Aborted,
            result: json!({}),
        },
    };
    let _ = output.send(message).await;
    request_id
}

#[derive(Debug)]
enum RequestFailure {
    Bridge(BridgeError),
    Cancelled,
}

impl From<BridgeError> for RequestFailure {
    fn from(error: BridgeError) -> Self {
        Self::Bridge(error)
    }
}

/// Fail closed when a request was cancelled before a side-effecting commit point.
fn ensure_not_cancelled(cancellation: &CancellationToken) -> Result<(), RequestFailure> {
    if cancellation.is_cancelled() {
        Err(RequestFailure::Cancelled)
    } else {
        Ok(())
    }
}

async fn await_with_cancellation<T>(
    cancellation: &CancellationToken,
    future: impl Future<Output = T>,
) -> Result<T, RequestFailure> {
    tokio::pin!(future);
    tokio::select! {
        () = cancellation.cancelled() => Err(RequestFailure::Cancelled),
        output = &mut future => Ok(output),
    }
}

fn reserve_reference_bytes(total: &mut u64, amount: u64) -> bool {
    let Some(next) = total.checked_add(amount) else {
        return false;
    };
    if next > MAX_IMAGE_REFERENCE_BYTES {
        return false;
    }
    *total = next;
    true
}

fn reserve_reference_data_url_bytes(total: &mut usize, amount: usize) -> bool {
    let Some(next) = total.checked_add(amount) else {
        return false;
    };
    if next > MAX_IMAGE_REFERENCE_DATA_URL_BYTES {
        return false;
    }
    *total = next;
    true
}

const fn request_shutdown_timeout() -> Duration {
    if cfg!(test) {
        Duration::from_millis(100)
    } else {
        Duration::from_secs(5)
    }
}

#[allow(clippy::large_futures)]
async fn dispatch(
    method: RequestMethod,
    params: Value,
    context: DispatchContext<'_>,
) -> Result<RequestSuccess, RequestFailure> {
    let DispatchContext {
        request_id,
        identity,
        flow,
        cancellation,
        output,
        approvals,
        sessions,
    } = context;
    match method {
        RequestMethod::DiagnosticsRead => {
            serde_json::from_value::<DiagnosticsParams>(params).map_err(|_| BridgeError {
                category: ErrorCategory::ProtocolError,
                code: "invalid_params".to_owned(),
                message: "diagnostics.read parameters must be an empty object".to_owned(),
                retryable: false,
            })?;
            Ok(RequestSuccess::completed(json!({
                "bridgeProtocolVersion": BRIDGE_PROTOCOL_VERSION,
                "officialCodexVersion": OFFICIAL_CODEX_VERSION,
                "officialCodexTag": OFFICIAL_CODEX_TAG,
                "officialSourceCommit": OFFICIAL_SOURCE_COMMIT,
                "vendorTreeSha256": VENDOR_TREE_SHA256,
                "buildTarget": identity.target,
                "buildSourceCommit": identity.source_commit,
                "compiledOfficialTypes": official::compiled_module_types(),
                "capabilities": compiled_capabilities(),
            })))
        }
        RequestMethod::ContextsSummarize => contexts_summarize(params, cancellation).await,
        RequestMethod::ResponsesCreate => responses_create(params, flow, cancellation)
            .await
            .map(RequestSuccess::completed),
        RequestMethod::ResponsesCompact => responses_compact(params, cancellation).await,
        RequestMethod::ModelsResolve => {
            models_resolve(params, cancellation).map(RequestSuccess::completed)
        }
        RequestMethod::ToolsExecute => {
            tools_execute(
                request_id,
                params,
                flow,
                cancellation,
                output,
                approvals,
                sessions,
            )
            .await
        }
        RequestMethod::ToolsResolve => tools_resolve(params).map(RequestSuccess::completed),
    }
}

#[derive(Debug)]
struct RequestSuccess {
    status: TerminalStatus,
    result: Value,
}

impl RequestSuccess {
    fn completed(result: Value) -> Self {
        Self {
            status: TerminalStatus::Completed,
            result,
        }
    }

    fn timed_out(result: Value) -> Self {
        Self {
            status: TerminalStatus::TimedOut,
            result,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn tools_execute(
    request_id: &str,
    params: Value,
    flow: &FlowController,
    cancellation: &CancellationToken,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    sessions: &Arc<NativeSessions>,
) -> Result<RequestSuccess, RequestFailure> {
    let params = serde_json::from_value::<ToolExecuteParams>(params)
        .map_err(|_| invalid_params("tools.execute parameters are invalid"))?;
    if params.authorization == NativeAuthorization::Preauthorized
        && !PREAUTHORIZED_TOOLS.contains(&params.tool.as_str())
    {
        return Err(BridgeError {
            category: ErrorCategory::CapabilityError,
            code: "preauthorization_unsupported".to_owned(),
            message: "preauthorization is not supported for the requested native tool".to_owned(),
            retryable: false,
        }
        .into());
    }
    if params.tool == "write_stdin" {
        return write_stdin(
            request_id,
            params,
            flow,
            cancellation,
            output,
            approvals,
            sessions,
        )
        .await;
    }
    if params.tool == "view_image" {
        return view_image(request_id, params, output, approvals, cancellation).await;
    }
    if params.tool == "apply_patch" {
        return apply_patch(request_id, params, output, approvals, cancellation).await;
    }
    if params.tool == "image_gen.imagegen" {
        return image_generation(request_id, params, output, approvals, cancellation).await;
    }
    if params.tool == "web.run" {
        return standalone_web_search(request_id, params, output, approvals, cancellation).await;
    }
    if params.tool != "shell_command" && params.tool != "exec_command" {
        return Err(BridgeError {
            category: ErrorCategory::CapabilityError,
            code: "tool_execution_unsupported".to_owned(),
            message: "the requested native tool is not available".to_owned(),
            retryable: false,
        }
        .into());
    }
    execute_shell_tool(
        request_id,
        params,
        flow,
        cancellation,
        output,
        approvals,
        sessions,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute_shell_tool(
    request_id: &str,
    params: ToolExecuteParams,
    flow: &FlowController,
    cancellation: &CancellationToken,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    sessions: &Arc<NativeSessions>,
) -> Result<RequestSuccess, RequestFailure> {
    let command = params
        .command
        .or(params.cmd)
        .filter(|command| !command.is_empty())
        .ok_or_else(|| invalid_params("tools.execute requires a command"))?;
    let workdir = validate_workspace(&params.workdir, &params.workspace_roots).await?;
    let shell_program = resolve_supported_shell(params.shell)?;
    let use_login_shell = resolve_use_login_shell(params.login, params.allow_login_shell)?;
    await_command_approval(
        request_id,
        params.authorization,
        &command,
        &shell_program,
        &workdir,
        &params.workspace_roots,
        output,
        approvals,
        cancellation,
    )
    .await?;
    ensure_not_cancelled(cancellation)?;
    if params.tool == "exec_command" {
        let yield_ms = params.yield_time_ms.unwrap_or(10_000).clamp(250, 30_000);
        return run_exec_process(
            command,
            shell_program,
            workdir,
            params.tty.unwrap_or(false),
            yield_ms,
            params.max_output_tokens,
            use_login_shell,
            params.allow_background_sessions.unwrap_or(true),
            flow,
            cancellation,
            sessions,
        )
        .await;
    }
    let timeout_ms = params.timeout_ms.unwrap_or(10_000).clamp(1, 600_000);
    run_shell_process(
        command,
        shell_program,
        workdir,
        timeout_ms,
        use_login_shell,
        params.max_output_tokens,
        flow,
        cancellation,
    )
    .await
}

async fn validate_workspace(
    workdir: &str,
    workspace_roots: &[String],
) -> Result<PathBuf, BridgeError> {
    if workspace_roots.is_empty() || workdir.is_empty() {
        return Err(BridgeError {
            category: ErrorCategory::NativeToolError,
            code: "workspace_required".to_owned(),
            message: "a workspace root and working directory are required".to_owned(),
            retryable: false,
        });
    }
    let workdir = tokio::fs::canonicalize(workdir)
        .await
        .map_err(|_| BridgeError {
            category: ErrorCategory::NativeToolError,
            code: "workspace_unavailable".to_owned(),
            message: "the requested working directory is unavailable".to_owned(),
            retryable: false,
        })?;
    for root in workspace_roots {
        let root = tokio::fs::canonicalize(root)
            .await
            .map_err(|_| BridgeError {
                category: ErrorCategory::NativeToolError,
                code: "workspace_unavailable".to_owned(),
                message: "the requested workspace root is unavailable".to_owned(),
                retryable: false,
            })?;
        if workdir.starts_with(root) {
            return Ok(workdir);
        }
    }
    Err(BridgeError {
        category: ErrorCategory::NativeToolError,
        code: "workspace_escape".to_owned(),
        message: "the working directory is outside the approved workspace".to_owned(),
        retryable: false,
    })
}

#[allow(clippy::too_many_arguments)]
async fn await_command_approval(
    request_id: &str,
    authorization: NativeAuthorization,
    command: &str,
    shell: &str,
    workdir: &Path,
    workspace_roots: &[String],
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<(), RequestFailure> {
    let workdir = display_path_for_approval(workdir, workspace_roots).await;
    authorize_operation(
        request_id,
        authorization,
        ApprovalOperation::Command,
        format!("{shell}: {command}"),
        json!({
            "workdir": workdir,
            "shell": shell,
            "command": command,
        }),
        "Pi declined the command approval",
        output,
        approvals,
        cancellation,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn authorize_operation(
    request_id: &str,
    authorization: NativeAuthorization,
    operation: ApprovalOperation,
    summary: String,
    details: Value,
    declined_message: &str,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<(), RequestFailure> {
    ensure_not_cancelled(cancellation)?;
    match authorization {
        NativeAuthorization::Preauthorized => Ok(()),
        NativeAuthorization::RequireApproval => {
            await_approval(
                request_id,
                operation,
                summary,
                details,
                declined_message,
                output,
                approvals,
                cancellation,
            )
            .await
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn await_approval(
    request_id: &str,
    operation: ApprovalOperation,
    summary: String,
    details: Value,
    declined_message: &str,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<(), RequestFailure> {
    ensure_not_cancelled(cancellation)?;
    let approval_id = format!(
        "approval-{:016x}",
        NEXT_APPROVAL_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = oneshot::channel();
    {
        let mut approvals = approvals.lock().await;
        match approvals.entry(approval_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(sender);
            }
            Entry::Occupied(_) => {
                return Err(BridgeError {
                    category: ErrorCategory::ProtocolError,
                    code: "approval_id_collision".to_owned(),
                    message: "the bridge could not allocate an approval id".to_owned(),
                    retryable: false,
                }
                .into());
            }
        }
    }
    if output
        .send(ServerMessage::ApprovalRequest {
            request_id: request_id.to_owned(),
            approval: ApprovalRequest {
                approval_id: approval_id.clone(),
                operation,
                summary,
                details,
                // Decline/Cancel first, AllowOnce last. allow_session is never advertised.
                available_decisions: ApprovalDecision::ADVERTISED.to_vec(),
            },
        })
        .await
        .is_err()
    {
        approvals.lock().await.remove(&approval_id);
        return Err(BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "bridge_output_closed".to_owned(),
            message: "the bridge output channel closed while waiting for approval".to_owned(),
            retryable: false,
        }
        .into());
    }
    let decision = tokio::select! {
        decision = receiver => decision.ok(),
        () = cancellation.cancelled() => None,
    };
    approvals.lock().await.remove(&approval_id);
    match decision {
        Some(ApprovalDecision::AllowOnce) => Ok(()),
        Some(ApprovalDecision::AllowSession) => Err(BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "unadvertised_approval_decision".to_owned(),
            message: "allow_session is not an advertised approval decision".to_owned(),
            retryable: false,
        }
        .into()),
        Some(ApprovalDecision::Cancel) | None => Err(RequestFailure::Cancelled),
        Some(ApprovalDecision::Decline) => Err(BridgeError {
            category: ErrorCategory::NativeToolError,
            code: "approval_declined".to_owned(),
            message: declined_message.to_owned(),
            retryable: false,
        }
        .into()),
    }
}

async fn view_image(
    request_id: &str,
    params: ToolExecuteParams,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let path = params
        .path
        .filter(|path| !path.is_empty())
        .ok_or_else(|| invalid_params("view_image requires path"))?;
    let detail = match params.detail.as_deref() {
        None | Some("high") => "high",
        Some("original") => "original",
        Some(_) => return Err(invalid_params("view_image detail must be high or original").into()),
    };
    // Relative paths resolve against the validated tool workdir, never bridge CWD.
    let candidate =
        resolve_view_image_path(&path, &params.workdir, &params.workspace_roots).await?;
    let path = validate_workspace_file(&candidate, &params.workspace_roots).await?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| image_error("image_unavailable", "the requested image is unavailable"))?;
    if !metadata.is_file() {
        return Err(image_error("image_not_file", "the requested image is not a file").into());
    }
    if metadata.len() > MAX_IMAGE_SOURCE_BYTES {
        return Err(image_error("image_too_large", "the requested image is too large").into());
    }
    let path_display = display_path_for_approval(&path, &params.workspace_roots).await;
    authorize_operation(
        request_id,
        params.authorization,
        ApprovalOperation::Filesystem,
        "Read image file".to_owned(),
        json!({ "path": path_display }),
        "Pi declined the image approval",
        output,
        approvals,
        cancellation,
    )
    .await?;
    ensure_not_cancelled(cancellation)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| image_error("image_unavailable", "the requested image could not be read"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| image_error("image_unavailable", "the requested image is unavailable"))?;
    if !metadata.is_file() {
        return Err(image_error("image_not_file", "the requested image is not a file").into());
    }
    if metadata.len() > MAX_IMAGE_SOURCE_BYTES {
        return Err(image_error("image_too_large", "the requested image is too large").into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_SOURCE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| image_error("image_unavailable", "the requested image could not be read"))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_IMAGE_SOURCE_BYTES {
        return Err(image_error("image_too_large", "the requested image is too large").into());
    }
    let mode = if detail == "original" {
        codex_utils_image::PromptImageMode::Original
    } else {
        codex_utils_image::PromptImageMode::ResizeToFit
    };
    let encoded = tokio::task::spawn_blocking(move || {
        codex_utils_image::load_for_prompt_bytes(&path, bytes, mode)
    })
    .await
    .map_err(|_| {
        image_error(
            "image_processing_failed",
            "the image could not be processed",
        )
    })?
    .map_err(|_| {
        image_error(
            "invalid_image",
            "the requested file is not a supported image",
        )
    })?;
    let image_url = encoded.into_data_url();
    if image_url.len() > MAX_IMAGE_RESULT_BYTES {
        return Err(image_error(
            "image_result_too_large",
            "the processed image exceeds the bridge result limit",
        )
        .into());
    }
    Ok(RequestSuccess::completed(json!({
        "image_url": image_url,
        "detail": detail,
    })))
}

async fn apply_patch(
    request_id: &str,
    params: ToolExecuteParams,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let patch = params
        .input
        .filter(|input| !input.is_empty())
        .ok_or_else(|| invalid_params("apply_patch requires freeform input"))?;
    if patch.len() > MAX_PATCH_BYTES {
        return Err(patch_error("patch_too_large", "the requested patch is too large").into());
    }
    let workdir = validate_workspace(&params.workdir, &params.workspace_roots).await?;
    let parsed = codex_apply_patch_adapter::parse_patch(&patch)
        .map_err(|_| patch_error("invalid_patch", "the patch syntax is invalid"))?;
    if parsed.hunks.is_empty() {
        return Err(patch_error("empty_patch", "the patch does not modify any files").into());
    }
    let paths = validate_patch_paths(&parsed.hunks, &workdir, &params.workspace_roots).await?;
    authorize_operation(
        request_id,
        params.authorization,
        ApprovalOperation::Patch,
        format!("Modify {} file(s)", paths.approval.len()),
        json!({ "paths": paths.approval }),
        "Pi declined the patch approval",
        output,
        approvals,
        cancellation,
    )
    .await?;
    let validated = validate_patch_paths(&parsed.hunks, &workdir, &params.workspace_roots).await?;
    // Atomic commit point: cancel is honored until immediately before the
    // filesystem apply begins. Once the blocking apply is scheduled, this
    // request waits for the actual terminal outcome instead of claiming aborted
    // while mutation continues.
    ensure_not_cancelled(cancellation)?;
    let apply = tokio::task::spawn_blocking(move || {
        codex_apply_patch_adapter::apply_patch(&patch, &workdir)
    });
    apply
        .await
        .map_err(|_| patch_error("patch_execution_failed", "the patch could not be applied"))?
        .map_err(|_| patch_error("patch_application_failed", "the patch could not be applied"))?;
    let output = render_patch_summary(&validated.affected);
    Ok(RequestSuccess::completed(json!({
        "output": output,
        "added": validated.affected.added,
        "modified": validated.affected.modified,
        "deleted": validated.affected.deleted,
    })))
}

#[allow(clippy::too_many_lines)]
async fn image_generation(
    request_id: &str,
    params: ToolExecuteParams,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let prompt = params
        .prompt
        .filter(|prompt| !prompt.is_empty())
        .ok_or_else(|| invalid_params("image_gen.imagegen requires prompt"))?;
    if prompt.len() > MAX_IMAGE_PROMPT_BYTES {
        return Err(invalid_params("image_gen.imagegen prompt is too large").into());
    }
    let referenced_paths = params.referenced_image_paths.unwrap_or_default();
    let recent_count = params.num_last_images_to_include;
    if !referenced_paths.is_empty() && recent_count.is_some() {
        return Err(invalid_params(
            "image_gen.imagegen accepts only one image reference mechanism",
        )
        .into());
    }
    if referenced_paths.len() > 5 || recent_count.is_some_and(|count| !(1..=5).contains(&count)) {
        return Err(
            invalid_params("image_gen.imagegen accepts between one and five images").into(),
        );
    }

    let mut images = Vec::new();
    let mut referenced_bytes = 0_u64;
    let mut referenced_data_url_bytes = 0_usize;
    if !referenced_paths.is_empty() {
        let mut paths = Vec::with_capacity(referenced_paths.len());
        let mut display_paths = Vec::with_capacity(referenced_paths.len());
        for path in &referenced_paths {
            if !Path::new(path).is_absolute() {
                return Err(image_error(
                    "invalid_image_path",
                    "referenced image paths must be absolute",
                )
                .into());
            }
            let absolute =
                validate_workspace_file(Path::new(path), &params.workspace_roots).await?;
            display_paths.push(display_path_for_approval(&absolute, &params.workspace_roots).await);
            paths.push(absolute);
        }
        let mut validated_reference_bytes = referenced_bytes;
        for path in &paths {
            let metadata = tokio::fs::metadata(path).await.map_err(|_| {
                image_error("image_unavailable", "a referenced image is unavailable")
            })?;
            let remaining_bytes =
                MAX_IMAGE_REFERENCE_BYTES.saturating_sub(validated_reference_bytes);
            if !metadata.is_file()
                || metadata.len() > MAX_IMAGE_SOURCE_BYTES
                || metadata.len() > remaining_bytes
            {
                return Err(image_error(
                    "invalid_image_reference",
                    "the referenced images are invalid or too large",
                )
                .into());
            }
            validated_reference_bytes = validated_reference_bytes.saturating_add(metadata.len());
        }
        authorize_operation(
            request_id,
            params.authorization,
            ApprovalOperation::Filesystem,
            format!("Read {} referenced image(s)", paths.len()),
            json!({ "paths": display_paths }),
            "Pi declined the image reference approval",
            output,
            approvals,
            cancellation,
        )
        .await?;
        ensure_not_cancelled(cancellation)?;
        for path in paths {
            ensure_not_cancelled(cancellation)?;
            let metadata = tokio::fs::metadata(&path).await.map_err(|_| {
                image_error("image_unavailable", "a referenced image is unavailable")
            })?;
            let remaining_bytes = MAX_IMAGE_REFERENCE_BYTES.saturating_sub(referenced_bytes);
            if !metadata.is_file()
                || metadata.len() > MAX_IMAGE_SOURCE_BYTES
                || metadata.len() > remaining_bytes
            {
                return Err(image_error(
                    "invalid_image_reference",
                    "the referenced images are invalid or too large",
                )
                .into());
            }
            let bytes = tokio::fs::read(&path).await.map_err(|_| {
                image_error("image_unavailable", "a referenced image could not be read")
            })?;
            let byte_count = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            if byte_count > remaining_bytes
                || !reserve_reference_bytes(&mut referenced_bytes, byte_count)
            {
                return Err(image_error(
                    "image_references_too_large",
                    "the referenced images exceed the aggregate size limit",
                )
                .into());
            }
            let encoded = tokio::task::spawn_blocking(move || {
                codex_utils_image::load_for_prompt_bytes(
                    &path,
                    bytes,
                    codex_utils_image::PromptImageMode::Original,
                )
            })
            .await
            .map_err(|_| {
                image_error(
                    "image_processing_failed",
                    "a referenced image could not be processed",
                )
            })?
            .map_err(|_| {
                image_error(
                    "invalid_image_reference",
                    "a referenced image is not supported",
                )
            })?;
            let image_url = encoded.into_data_url();
            let remaining_data_url_bytes =
                MAX_IMAGE_REFERENCE_DATA_URL_BYTES.saturating_sub(referenced_data_url_bytes);
            if image_url.len() > remaining_data_url_bytes
                || !reserve_reference_data_url_bytes(
                    &mut referenced_data_url_bytes,
                    image_url.len(),
                )
            {
                return Err(image_error(
                    "image_references_too_large",
                    "the referenced images exceed the aggregate size limit",
                )
                .into());
            }
            images.push(ImageUrl { image_url });
        }
    } else if let Some(count) = recent_count {
        let recent = params.recent_image_urls.unwrap_or_default();
        let mut total_data_url_bytes = 0_usize;
        if recent.len() != count
            || recent.iter().any(|url| {
                !url.starts_with("data:image/")
                    || url.len() > MAX_IMAGE_RESULT_BYTES
                    || !reserve_reference_data_url_bytes(&mut total_data_url_bytes, url.len())
            })
        {
            return Err(image_error(
                "recent_images_unavailable",
                "the requested recent conversation images are unavailable",
            )
            .into());
        }
        images.extend(recent.into_iter().map(|image_url| ImageUrl { image_url }));
    }

    let connection = params
        .connection
        .as_ref()
        .ok_or_else(|| invalid_params("image_gen.imagegen requires a provider connection"))?;
    let connection = api::connect(connection)?;

    authorize_operation(
        request_id,
        params.authorization,
        ApprovalOperation::Network,
        "image_gen.imagegen network access".to_owned(),
        json!({
            "tool": "image_gen.imagegen",
            "referencedImages": images.len(),
        }),
        "Pi declined the network approval",
        output,
        approvals,
        cancellation,
    )
    .await?;
    ensure_not_cancelled(cancellation)?;

    let client = ImagesClient::new(
        connection.transport,
        connection.provider,
        connection.authentication,
    );
    let response = if images.is_empty() {
        await_with_cancellation(
            cancellation,
            client.generate(
                &ImageGenerationRequest {
                    prompt: prompt.clone(),
                    background: Some(ImageBackground::Auto),
                    model: "gpt-image-2".to_owned(),
                    n: None,
                    quality: Some(ImageQuality::Auto),
                    size: Some("auto".to_owned()),
                },
                HeaderMap::default(),
            ),
        )
        .await?
    } else {
        await_with_cancellation(
            cancellation,
            client.edit(
                &ImageEditRequest {
                    images,
                    prompt: prompt.clone(),
                    background: Some(ImageBackground::Auto),
                    model: "gpt-image-2".to_owned(),
                    n: None,
                    quality: Some(ImageQuality::Auto),
                    size: Some("auto".to_owned()),
                },
                HeaderMap::default(),
            ),
        )
        .await?
    }
    .map_err(|error| api::map_provider_contract_error(&error, "images_api"))?;
    let encoded = response
        .data
        .into_iter()
        .next()
        .map(|image| image.b64_json)
        .ok_or_else(|| {
            image_error(
                "image_generation_empty",
                "image generation returned no data",
            )
        })?;
    let encoded = encoded.trim().to_owned();
    let decoded_size = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| {
            image_error(
                "invalid_generated_image",
                "image generation returned invalid data",
            )
        })?
        .len();
    if decoded_size > MAX_GENERATED_IMAGE_BYTES {
        return Err(image_error(
            "generated_image_too_large",
            "the generated image exceeds the bridge result limit",
        )
        .into());
    }
    Ok(RequestSuccess::completed(json!({
        "image_url": format!("data:image/png;base64,{encoded}"),
        "revised_prompt": prompt,
    })))
}

async fn standalone_web_search(
    request_id: &str,
    params: ToolExecuteParams,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let commands = match params.commands {
        Some(value) => serde_json::from_value::<SearchCommands>(value)
            .map_err(|_| invalid_params("web.run commands are invalid"))?,
        None => SearchCommands::default(),
    };
    let model = params
        .model
        .filter(|model| !model.is_empty() && model.len() <= 256)
        .ok_or_else(|| invalid_params("web.run model is invalid"))?;
    let session_id = params
        .request_session_id
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or_else(|| invalid_params("web.run session is invalid"))?;
    let web_search_mode = params
        .web_search_mode
        .filter(|mode| *mode != WebSearchMode::Disabled)
        .ok_or_else(|| invalid_params("web.run search mode is disabled"))?;
    let external_web_access = match web_search_mode {
        WebSearchMode::Disabled => unreachable!("disabled mode was rejected"),
        WebSearchMode::Cached => ExternalWebAccessMode::Cached,
        WebSearchMode::Indexed => ExternalWebAccessMode::Indexed,
        WebSearchMode::Live => ExternalWebAccessMode::Live,
    };
    let connection = params
        .connection
        .as_ref()
        .ok_or_else(|| invalid_params("web.run requires a provider connection"))?;
    let connection = api::connect(connection)?;

    authorize_operation(
        request_id,
        params.authorization,
        ApprovalOperation::Network,
        "standalone web.run network access".to_owned(),
        json!({
            "tool": "web.run",
            "model": model,
            "webSearchMode": web_search_mode,
            "sessionId": session_id,
        }),
        "Pi declined the network approval",
        output,
        approvals,
        cancellation,
    )
    .await?;
    ensure_not_cancelled(cancellation)?;
    let request = SearchRequest {
        id: session_id,
        model,
        reasoning: None,
        input: recent_search_input(params.conversation_items),
        commands: Some(commands),
        settings: Some(SearchSettings {
            allowed_callers: Some(vec![AllowedCaller::Direct]),
            external_web_access: Some(ExternalWebAccess::Mode(external_web_access)),
            ..SearchSettings::default()
        }),
        max_output_tokens: Some(10_000),
    };
    let client = SearchClient::new(
        connection.transport,
        connection.provider,
        connection.authentication,
    );
    let response =
        await_with_cancellation(cancellation, client.search(&request, HeaderMap::default()))
            .await?
            .map_err(|error| api::map_provider_contract_error(&error, "search_api"))?;
    if response.output.len() > MAX_SESSION_OUTPUT_BYTES {
        return Err(BridgeError {
            category: ErrorCategory::NativeToolError,
            code: "web_search_output_too_large".to_owned(),
            message: "the standalone web search output is too large".to_owned(),
            retryable: false,
        }
        .into());
    }
    Ok(RequestSuccess::completed(
        json!({ "output": response.output }),
    ))
}

fn recent_search_input(items: Vec<ResponseItem>) -> Option<SearchInput> {
    let mut messages = items
        .into_iter()
        .filter_map(|item| match item {
            ResponseItem::Message {
                role,
                content,
                phase,
                internal_chat_message_metadata_passthrough,
                ..
            } if role == "user" => {
                let content = content
                    .into_iter()
                    .filter(|content| matches!(content, ContentItem::InputText { .. }))
                    .collect::<Vec<_>>();
                (!content.is_empty()).then_some(ResponseItem::Message {
                    id: None,
                    role,
                    content,
                    phase,
                    internal_chat_message_metadata_passthrough,
                })
            }
            ResponseItem::Message {
                role,
                content,
                phase,
                internal_chat_message_metadata_passthrough,
                ..
            } if role == "assistant" => Some(ResponseItem::Message {
                id: None,
                role,
                content,
                phase,
                internal_chat_message_metadata_passthrough,
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    codex_tools::retain_tail_from_last_n_user_messages(&mut messages, 2);
    codex_tools::truncate_assistant_output_text_to_token_budget(&mut messages, 1_000);
    (!messages.is_empty()).then_some(SearchInput::Items(messages))
}

struct ValidatedPatchPaths {
    approval: Vec<String>,
    affected: DisplayAffectedPaths,
}

struct DisplayAffectedPaths {
    added: Vec<String>,
    modified: Vec<String>,
    deleted: Vec<String>,
}

async fn validate_patch_paths(
    hunks: &[codex_apply_patch_adapter::Hunk],
    workdir: &Path,
    workspace_roots: &[String],
) -> Result<ValidatedPatchPaths, BridgeError> {
    let mut roots = Vec::with_capacity(workspace_roots.len());
    for root in workspace_roots {
        roots.push(tokio::fs::canonicalize(root).await.map_err(|_| {
            patch_error(
                "workspace_unavailable",
                "the requested workspace root is unavailable",
            )
        })?);
    }
    let mut approval = Vec::new();
    let mut display_by_requested_path = HashMap::new();
    for hunk in hunks {
        let candidates = match hunk {
            codex_apply_patch_adapter::Hunk::AddFile { path, .. }
            | codex_apply_patch_adapter::Hunk::DeleteFile { path }
            | codex_apply_patch_adapter::Hunk::UpdateFile {
                path,
                move_path: None,
                ..
            } => vec![path],
            codex_apply_patch_adapter::Hunk::UpdateFile {
                path,
                move_path: Some(destination),
                ..
            } => vec![path, destination],
        };
        for requested in candidates {
            let absolute = requested.is_absolute();
            if requested.as_os_str().is_empty()
                || requested.components().any(|component| {
                    matches!(component, std::path::Component::ParentDir)
                        || !absolute
                            && matches!(
                                component,
                                std::path::Component::RootDir | std::path::Component::Prefix(_)
                            )
                })
            {
                return Err(patch_error(
                    "invalid_patch_path",
                    "the patch contains an invalid path",
                ));
            }
            let candidate = if absolute {
                requested.clone()
            } else {
                workdir.join(requested)
            };
            let resolved = canonical_patch_path(&candidate).await?;
            let Some(root) = roots.iter().find(|root| resolved.starts_with(root)) else {
                return Err(patch_error(
                    "workspace_escape",
                    "the patch path is outside the approved workspace",
                ));
            };
            if let Ok(metadata) = tokio::fs::symlink_metadata(&candidate).await
                && metadata.file_type().is_symlink()
            {
                return Err(patch_error(
                    "symlink_unsupported",
                    "patching symbolic links is not supported",
                ));
            }
            let relative = resolved.strip_prefix(root).map_err(|_| {
                patch_error("patch_path_unavailable", "the patch path is unavailable")
            })?;
            let display = display_relative_path(relative);
            display_by_requested_path.insert(requested.clone(), display.clone());
            if !approval.contains(&display) {
                approval.push(display);
            }
        }
    }
    let affected = codex_apply_patch_adapter::affected_paths(hunks);
    Ok(ValidatedPatchPaths {
        approval,
        affected: DisplayAffectedPaths {
            added: display_affected_paths(&affected.added, &display_by_requested_path)?,
            modified: display_affected_paths(&affected.modified, &display_by_requested_path)?,
            deleted: display_affected_paths(&affected.deleted, &display_by_requested_path)?,
        },
    })
}

fn display_affected_paths(
    paths: &[PathBuf],
    display_by_requested_path: &HashMap<PathBuf, String>,
) -> Result<Vec<String>, BridgeError> {
    paths
        .iter()
        .map(|path| {
            display_by_requested_path.get(path).cloned().ok_or_else(|| {
                patch_error("patch_path_unavailable", "the patch path is unavailable")
            })
        })
        .collect()
}

fn display_relative_path(path: &Path) -> String {
    let display = path.to_string_lossy().replace('\\', "/");
    if display.is_empty() {
        ".".to_owned()
    } else {
        display
    }
}

async fn canonical_patch_path(path: &Path) -> Result<PathBuf, BridgeError> {
    let mut anchor = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match tokio::fs::canonicalize(&anchor).await {
            Ok(mut canonical) => {
                for component in missing.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(component) = anchor.file_name().map(ToOwned::to_owned) else {
                    return Err(patch_error(
                        "patch_path_unavailable",
                        "the patch path is unavailable",
                    ));
                };
                missing.push(component);
                if !anchor.pop() {
                    return Err(patch_error(
                        "patch_path_unavailable",
                        "the patch path is unavailable",
                    ));
                }
            }
            Err(_) => {
                return Err(patch_error(
                    "patch_path_unavailable",
                    "the patch path is unavailable",
                ));
            }
        }
    }
}

fn render_patch_summary(affected: &DisplayAffectedPaths) -> String {
    let mut lines = vec!["Done!".to_owned()];
    for (label, paths) in [
        ("Added", &affected.added),
        ("Modified", &affected.modified),
        ("Deleted", &affected.deleted),
    ] {
        for path in paths {
            lines.push(format!("{label}: {path}"));
        }
    }
    lines.join("\n")
}

fn patch_error(code: &str, message: &str) -> BridgeError {
    BridgeError {
        category: ErrorCategory::NativeToolError,
        code: code.to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

async fn resolve_view_image_path(
    path: &str,
    workdir: &str,
    workspace_roots: &[String],
) -> Result<PathBuf, BridgeError> {
    let requested = PathBuf::from(path);
    if requested.is_absolute() {
        return Ok(requested);
    }
    if workdir.is_empty() {
        return Err(invalid_params(
            "view_image relative paths require a validated tool workdir",
        ));
    }
    let workdir = validate_workspace(workdir, workspace_roots).await?;
    Ok(workdir.join(requested))
}

async fn validate_workspace_file(
    path: &Path,
    workspace_roots: &[String],
) -> Result<PathBuf, BridgeError> {
    if workspace_roots.is_empty() {
        return Err(image_error(
            "workspace_required",
            "a workspace root is required for image access",
        ));
    }
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| image_error("image_unavailable", "the requested image is unavailable"))?;
    for root in workspace_roots {
        let root = tokio::fs::canonicalize(root).await.map_err(|_| {
            image_error(
                "workspace_unavailable",
                "the requested workspace root is unavailable",
            )
        })?;
        if path.starts_with(root) {
            return Ok(path);
        }
    }
    Err(image_error(
        "workspace_escape",
        "the image is outside the approved workspace",
    ))
}

fn image_error(code: &str, message: &str) -> BridgeError {
    BridgeError {
        category: ErrorCategory::NativeToolError,
        code: code.to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

async fn display_path_for_approval(path: &Path, workspace_roots: &[String]) -> String {
    for root in workspace_roots {
        let Ok(root) = tokio::fs::canonicalize(root).await else {
            continue;
        };
        if let Ok(relative) = path.strip_prefix(&root) {
            let display = relative.to_string_lossy().replace('\\', "/");
            return if display.is_empty() {
                ".".to_owned()
            } else {
                display
            };
        }
    }
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| ".".to_owned())
}

#[allow(clippy::too_many_arguments)]
async fn run_exec_process(
    command: String,
    shell: String,
    workdir: PathBuf,
    tty: bool,
    yield_ms: u64,
    max_output_tokens: Option<u64>,
    use_login_shell: bool,
    allow_background_sessions: bool,
    flow: &FlowController,
    cancellation: &CancellationToken,
    sessions: &Arc<NativeSessions>,
) -> Result<RequestSuccess, RequestFailure> {
    let (program, args) = build_shell_invocation(&shell, command, use_login_shell);
    let spawned = spawn_command_process(&program, &args, &workdir, tty).await?;
    let session = NativeSession::start(spawned);
    let started = Instant::now();
    wait_for_session(&session, Duration::from_millis(yield_ms), cancellation).await?;
    let snapshot = session.snapshot().await;
    emit_session_chunks(&snapshot.chunks, flow, cancellation).await?;
    let running = !session.is_drained().await;
    if running && !allow_background_sessions {
        session.process.request_terminate();
        wait_for_session(&session, Duration::from_secs(5), cancellation).await?;
        let snapshot = session.snapshot().await;
        emit_session_chunks(&snapshot.chunks, flow, cancellation).await?;
        return Ok(RequestSuccess::timed_out(session_result(
            &snapshot,
            None,
            started.elapsed(),
            max_output_tokens,
        )));
    }
    let session_id = if running {
        Some(sessions.insert(session).await)
    } else {
        None
    };
    Ok(RequestSuccess::completed(session_result(
        &snapshot,
        session_id,
        started.elapsed(),
        max_output_tokens,
    )))
}

#[allow(clippy::too_many_arguments)]
async fn write_session_stdin(
    request_id: &str,
    session_id: &str,
    authorization: NativeAuthorization,
    data: String,
    session: &NativeSession,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    cancellation: &CancellationToken,
) -> Result<Value, RequestFailure> {
    // Empty writes are non-mutating and must not re-prompt for approval.
    if data.is_empty() {
        return Ok(json!({ "sessionId": session_id }));
    }
    let (preview, truncated) = bounded_session_input_preview(&data);
    authorize_operation(
        request_id,
        authorization,
        ApprovalOperation::Command,
        preview.clone(),
        json!({
            "sessionId": session_id,
            "inputPreview": preview,
            "inputTruncated": truncated,
        }),
        "Pi declined the session write approval",
        output,
        approvals,
        cancellation,
    )
    .await?;
    ensure_not_cancelled(cancellation)?;
    if session
        .process
        .writer_sender()
        .send(data.into_bytes())
        .await
        .is_err()
    {
        return Err(
            session_error("session_stdin_closed", "the native session input is closed").into(),
        );
    }
    Ok(json!({ "sessionId": session_id }))
}

async fn write_stdin(
    request_id: &str,
    params: ToolExecuteParams,
    flow: &FlowController,
    cancellation: &CancellationToken,
    output: &mpsc::Sender<ServerMessage>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
    sessions: &Arc<NativeSessions>,
) -> Result<RequestSuccess, RequestFailure> {
    let session_id = params
        .session_id
        .ok_or_else(|| invalid_params("write_stdin requires session_id"))?;
    let Some((_, session)) = sessions.get(&session_id.to_string()).await else {
        return Err(session_error("unknown_session", "the native session is not active").into());
    };
    let chars = params.chars.unwrap_or_default();
    // Empty polls are non-mutating and must not re-prompt for approval.
    if !chars.is_empty() {
        let (preview, truncated) = bounded_session_input_preview(&chars);
        authorize_operation(
            request_id,
            params.authorization,
            ApprovalOperation::Command,
            preview.clone(),
            json!({
                "sessionId": session_id.to_string(),
                "inputPreview": preview,
                "inputTruncated": truncated,
            }),
            "Pi declined the session write approval",
            output,
            approvals,
            cancellation,
        )
        .await?;
        ensure_not_cancelled(cancellation)?;
        if session
            .process
            .writer_sender()
            .send(chars.clone().into_bytes())
            .await
            .is_err()
        {
            return Err(session_error(
                "session_stdin_closed",
                "the native session input is closed",
            )
            .into());
        }
    }
    let default_yield = if chars.is_empty() { 5_000 } else { 250 };
    let maximum_yield = if chars.is_empty() { 300_000 } else { 30_000 };
    let yield_ms = params
        .yield_time_ms
        .unwrap_or(default_yield)
        .clamp(1, maximum_yield);
    let started = Instant::now();
    let outcome = async {
        wait_for_session(&session, Duration::from_millis(yield_ms), cancellation).await?;
        let snapshot = session.snapshot().await;
        emit_session_chunks(&snapshot.chunks, flow, cancellation).await?;
        let still_running = !session.is_drained().await;
        if !still_running {
            sessions.remove(session_id).await;
        }
        Ok(RequestSuccess::completed(session_result(
            &snapshot,
            still_running.then_some(session_id),
            started.elapsed(),
            params.max_output_tokens,
        )))
    }
    .await;
    if matches!(outcome, Err(RequestFailure::Cancelled)) {
        session.process.request_terminate();
        sessions.remove(session_id).await;
    }
    outcome
}

const SESSION_INPUT_PREVIEW_MAX_CHARS: usize = 240;

/// Build a bounded, inspectable preview for session stdin approval.
///
/// The preview is for Pi UI only. Callers must not copy it into diagnostics or
/// error surfaces that can be retained outside the approval prompt.
fn bounded_session_input_preview(input: &str) -> (String, bool) {
    let mut preview = String::new();
    let mut count = 0usize;
    let mut truncated = false;
    for ch in input.chars() {
        if count >= SESSION_INPUT_PREVIEW_MAX_CHARS {
            truncated = true;
            break;
        }
        match ch {
            '\n' => preview.push_str("\\n"),
            '\r' => preview.push_str("\\r"),
            '\t' => preview.push_str("\\t"),
            c if c.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(preview, "\\u{{{:x}}}", u32::from(c));
            }
            c => preview.push(c),
        }
        count = count.saturating_add(1);
    }
    if truncated {
        preview.push('…');
    }
    (preview, truncated)
}

async fn wait_for_session(
    session: &NativeSession,
    duration: Duration,
    cancellation: &CancellationToken,
) -> Result<(), RequestFailure> {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    loop {
        let changed = session.changed.notified();
        if session.is_drained().await {
            return Ok(());
        }
        tokio::select! {
            () = cancellation.cancelled() => {
                session.process.request_terminate();
                return Err(RequestFailure::Cancelled);
            }
            () = &mut deadline => return Ok(()),
            () = changed => {}
        }
    }
}

async fn emit_session_chunks(
    chunks: &[ProcessOutputChunk],
    flow: &FlowController,
    cancellation: &CancellationToken,
) -> Result<(), RequestFailure> {
    for chunk in chunks {
        flow.emit(
            json!({
                "type": "tool.output.delta",
                "stream": chunk.stream,
                "text": String::from_utf8_lossy(&chunk.bytes),
            }),
            cancellation,
        )
        .await
        .map_err(map_emit_error)?;
    }
    Ok(())
}

fn session_result(
    snapshot: &SessionSnapshot,
    session_id: Option<u64>,
    elapsed: Duration,
    max_output_tokens: Option<u64>,
) -> Value {
    let (output, original_token_count) = truncate_command_output(
        &snapshot.output,
        resolve_max_output_tokens(max_output_tokens),
    );
    let original_token_count = original_token_count.or_else(|| {
        snapshot
            .truncated
            .then_some(approx_tokens_from_bytes(snapshot.original_bytes))
    });
    let mut result = json!({
        "wall_time_seconds": elapsed.as_secs_f64(),
        "output": output,
    });
    if let Some(exit_code) = snapshot.exit_code {
        result["exit_code"] = json!(exit_code);
    }
    if let Some(session_id) = session_id {
        result["session_id"] = json!(session_id);
    }
    if let Some(original_token_count) = original_token_count {
        result["original_token_count"] = json!(original_token_count);
    }
    result
}

fn process_spawn_error() -> BridgeError {
    BridgeError {
        category: ErrorCategory::NativeToolError,
        code: "process_spawn_failed".to_owned(),
        message: "the command process could not be started".to_owned(),
        retryable: false,
    }
}

fn session_error(code: &str, message: &str) -> BridgeError {
    BridgeError {
        category: ErrorCategory::NativeToolError,
        code: code.to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_shell_process(
    command: String,
    shell: String,
    workdir: PathBuf,
    timeout_ms: u64,
    use_login_shell: bool,
    max_output_tokens: Option<u64>,
    flow: &FlowController,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let (program, args) = build_shell_invocation(&shell, command, use_login_shell);
    let spawned = spawn_command_process(&program, &args, &workdir, false).await?;
    let codex_utils_pty::SpawnedProcess {
        session,
        mut stdout_rx,
        mut stderr_rx,
        mut exit_rx,
    } = spawned;
    let mut deadline = Box::pin(tokio::time::sleep(Duration::from_millis(timeout_ms)));
    let mut exit_code = None;
    let mut output = String::new();
    let mut truncated = false;
    let mut stdout_open = true;
    let mut stderr_open = true;
    loop {
        if exit_code.is_some() && !stdout_open && !stderr_open {
            break;
        }
        tokio::select! {
            () = cancellation.cancelled() => {
                session.request_terminate();
                return Err(RequestFailure::Cancelled);
            }
            () = &mut deadline, if exit_code.is_none() => {
                session.request_terminate();
                let (output, original_token_count) =
                    finalize_process_output(&output, truncated, max_output_tokens);
                let mut result = json!({
                    "exitCode": null,
                    "output": output,
                    "truncated": original_token_count.is_some() || truncated,
                });
                if let Some(original_token_count) = original_token_count {
                    result["original_token_count"] = json!(original_token_count);
                }
                return Ok(RequestSuccess::timed_out(result));
            }
            code = &mut exit_rx, if exit_code.is_none() => {
                exit_code = Some(code.unwrap_or(-1));
            }
            chunk = stdout_rx.recv(), if stdout_open => match chunk {
                Some(chunk) => append_process_output(&mut output, &mut truncated, &chunk, "stdout", flow, cancellation).await?,
                None => stdout_open = false,
            },
            chunk = stderr_rx.recv(), if stderr_open => match chunk {
                Some(chunk) => append_process_output(&mut output, &mut truncated, &chunk, "stderr", flow, cancellation).await?,
                None => stderr_open = false,
            },
        }
    }
    let (output, original_token_count) =
        finalize_process_output(&output, truncated, max_output_tokens);
    let mut result = json!({
        "exitCode": exit_code.unwrap_or(-1),
        "output": output,
        "truncated": original_token_count.is_some() || truncated,
    });
    if let Some(original_token_count) = original_token_count {
        result["original_token_count"] = json!(original_token_count);
    }
    Ok(RequestSuccess::completed(result))
}

async fn append_process_output(
    output: &mut String,
    truncated: &mut bool,
    chunk: &[u8],
    stream: &str,
    flow: &FlowController,
    cancellation: &CancellationToken,
) -> Result<(), RequestFailure> {
    const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
    let available = MAX_OUTPUT_BYTES.saturating_sub(output.len());
    if available == 0 {
        *truncated = true;
    } else {
        let length = chunk.len().min(available);
        output.push_str(&String::from_utf8_lossy(&chunk[..length]));
        if length < chunk.len() {
            *truncated = true;
        }
    }
    flow.emit(
        json!({
            "type": "tool.output.delta",
            "stream": stream,
            "text": String::from_utf8_lossy(chunk),
        }),
        cancellation,
    )
    .await
    .map(|_| ())
    .map_err(map_emit_error)
}

fn resolve_use_login_shell(
    login: Option<bool>,
    allow_login_shell: bool,
) -> Result<bool, BridgeError> {
    if !allow_login_shell && login == Some(true) {
        return Err(BridgeError {
            category: ErrorCategory::NativeToolError,
            code: "login_shell_disabled".to_owned(),
            message: "login shell is disabled by config; omit `login` or set it to false."
                .to_owned(),
            retryable: false,
        });
    }
    Ok(login.unwrap_or(allow_login_shell))
}

fn resolve_supported_shell(shell: Option<String>) -> Result<String, BridgeError> {
    if let Some(requested) = shell
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return resolve_host_shell_program(&requested);
    }
    if let Ok(env_shell) = std::env::var("SHELL") {
        let env_shell = env_shell.trim().to_owned();
        if !env_shell.is_empty()
            && let Ok(resolved) = resolve_host_shell_program(&env_shell)
        {
            return Ok(resolved);
        }
    }
    resolve_host_shell_program(default_shell_program())
}

fn default_shell_program() -> &'static str {
    #[cfg(windows)]
    {
        "powershell.exe"
    }
    #[cfg(not(windows))]
    {
        "sh"
    }
}

/// Resolve a model- or host-supplied shell to a real supported executable under a
/// trusted host directory. Basename-only acceptance is intentionally insufficient:
/// workspace-relative paths and attacker-created executables such as `./bash` or
/// `/tmp/bash` must be rejected even when their final path component looks like a shell.
fn resolve_host_shell_program(program: &str) -> Result<String, BridgeError> {
    let Some(stem) = supported_shell_stem(program) else {
        return Err(unsupported_shell_error());
    };
    if is_relative_shell_request(program) {
        return Err(unsupported_shell_error());
    }

    if is_bare_shell_name(program) {
        return find_trusted_shell_executable(&stem)
            .ok_or_else(unsupported_shell_error)
            .map(|path| path.to_string_lossy().into_owned());
    }

    // Absolute path: accept only when it resolves to a real supported shell under a
    // fixed system installation directory.
    let requested = PathBuf::from(program);
    if !requested.is_absolute() {
        return Err(unsupported_shell_error());
    }
    let canonical = std::fs::canonicalize(&requested).map_err(|_| unsupported_shell_error())?;
    // Allow standard aliases such as /bin/sh -> dash, but still require the resolved
    // executable itself to be a supported shell under a trusted host directory.
    if supported_shell_stem(&canonical.to_string_lossy()).is_none() {
        return Err(unsupported_shell_error());
    }
    if !is_path_under_trusted_shell_dir(&canonical) {
        return Err(unsupported_shell_error());
    }
    if !canonical.is_file() {
        return Err(unsupported_shell_error());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn unsupported_shell_error() -> BridgeError {
    BridgeError {
        category: ErrorCategory::NativeToolError,
        code: "unsupported_shell".to_owned(),
        message: "the requested shell program is not supported".to_owned(),
        retryable: false,
    }
}

fn is_bare_shell_name(program: &str) -> bool {
    !program.contains('/') && !program.contains('\\') && !program.starts_with('.')
}

fn is_relative_shell_request(program: &str) -> bool {
    let path = Path::new(program);
    if path.is_absolute() {
        return false;
    }
    // Bare names are resolved from trusted host directories.
    if is_bare_shell_name(program) {
        return false;
    }
    true
}

fn supported_shell_stem(program: &str) -> Option<String> {
    if program.is_empty()
        || program.len() > 4_096
        || !program.is_ascii()
        || program.contains('\0')
        || program.chars().any(char::is_control)
        || program.contains(['\n', '\r', '\t'])
    {
        return None;
    }
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    if name.is_empty() || name.contains(' ') {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower
        .strip_suffix(".exe")
        .or_else(|| lower.strip_suffix(".com"))
        .unwrap_or(lower.as_str());
    matches!(
        stem,
        "sh" | "bash"
            | "zsh"
            | "dash"
            | "ksh"
            | "csh"
            | "tcsh"
            | "fish"
            | "cmd"
            | "powershell"
            | "pwsh"
    )
    .then(|| stem.to_owned())
}

fn trusted_shell_directories() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(root) = std::env::var("SystemRoot") {
            let root = PathBuf::from(root);
            dirs.push(root.join("System32"));
            dirs.push(root.join("System32").join("WindowsPowerShell").join("v1.0"));
            dirs.push(root.join("SysWOW64"));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(prefix) = std::env::var(key) {
                dirs.push(PathBuf::from(prefix).join("PowerShell").join("7"));
            }
        }
    }
    #[cfg(not(windows))]
    {
        for entry in ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"] {
            dirs.push(PathBuf::from(entry));
        }
    }
    dirs
}

fn shell_candidate_names(stem: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            format!("{stem}.exe"),
            format!("{stem}.com"),
            stem.to_owned(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![stem.to_owned()]
    }
}

fn find_trusted_shell_executable(stem: &str) -> Option<PathBuf> {
    for dir in trusted_shell_directories() {
        for name in shell_candidate_names(stem) {
            // Match on the directory entry name before following aliases such as
            // /bin/sh -> /usr/bin/dash.
            if supported_shell_stem(&name).as_deref() != Some(stem) {
                continue;
            }
            let candidate = dir.join(&name);
            let Ok(canonical) = std::fs::canonicalize(&candidate) else {
                continue;
            };
            if !canonical.is_file() {
                continue;
            }
            // The resolved target must still be a supported shell binary under a
            // trusted host directory.
            if supported_shell_stem(&canonical.to_string_lossy()).is_none() {
                continue;
            }
            if is_path_under_trusted_shell_dir(&canonical) {
                return Some(canonical);
            }
        }
    }
    None
}

fn is_path_under_trusted_shell_dir(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent) = std::fs::canonicalize(parent) else {
        return false;
    };
    for dir in trusted_shell_directories() {
        let Ok(trusted) = std::fs::canonicalize(&dir) else {
            continue;
        };
        if parent == trusted {
            return true;
        }
    }
    false
}

fn build_shell_invocation(
    shell: &str,
    command: String,
    use_login_shell: bool,
) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let program = shell.to_owned();
        let lower = program.to_ascii_lowercase();
        if lower.ends_with("cmd.exe")
            || lower.ends_with(r"\cmd")
            || lower.ends_with("/cmd")
            || lower == "cmd"
        {
            return (program, vec!["/c".to_owned(), command]);
        }
        let mut args = Vec::new();
        if !use_login_shell {
            args.push("-NoProfile".to_owned());
        }
        args.push("-Command".to_owned());
        args.push(command);
        (program, args)
    }
    #[cfg(not(windows))]
    {
        let flag = if use_login_shell { "-lc" } else { "-c" };
        (shell.to_owned(), vec![flag.to_owned(), command])
    }
}

async fn spawn_command_process(
    program: &str,
    args: &[String],
    workdir: &Path,
    tty: bool,
) -> Result<codex_utils_pty::SpawnedProcess, BridgeError> {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    let spawned = if tty {
        codex_utils_pty::spawn_pty_process(
            program,
            args,
            workdir,
            &environment,
            &None,
            codex_utils_pty::TerminalSize { rows: 24, cols: 80 },
        )
        .await
    } else {
        codex_utils_pty::spawn_pipe_process(program, args, workdir, &environment, &None).await
    };
    spawned.map_err(|_| process_spawn_error())
}

fn resolve_max_output_tokens(max_output_tokens: Option<u64>) -> usize {
    max_output_tokens
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
}

fn approx_tokens_from_bytes(bytes: usize) -> u64 {
    u64::try_from(bytes.div_ceil(4)).unwrap_or(u64::MAX)
}

fn truncate_command_output(output: &str, max_tokens: usize) -> (String, Option<u64>) {
    let policy = TruncationPolicy::Tokens(max_tokens);
    if output.len() <= policy.byte_budget() {
        return (output.to_owned(), None);
    }
    let original_token_count = u64::try_from(approx_token_count(output)).unwrap_or(u64::MAX);
    (
        formatted_truncate_text(output, policy),
        Some(original_token_count),
    )
}

fn finalize_process_output(
    output: &str,
    truncated_by_byte_cap: bool,
    max_output_tokens: Option<u64>,
) -> (String, Option<u64>) {
    let (output, token_truncated) =
        truncate_command_output(output, resolve_max_output_tokens(max_output_tokens));
    if token_truncated.is_some() {
        return (output, token_truncated);
    }
    if truncated_by_byte_cap {
        let original = approx_tokens_from_bytes(output.len().saturating_add(1));
        (output, Some(original))
    } else {
        (output, None)
    }
}

#[allow(clippy::too_many_lines)]
fn tools_resolve(params: Value) -> Result<Value, RequestFailure> {
    let parsed = serde_json::from_value::<ToolsResolveParams>(params)
        .map_err(|_| invalid_params("tools.resolve parameters are invalid"))?;
    if !parsed.model.supported_in_api {
        return Err(BridgeError {
            category: ErrorCategory::CapabilityError,
            code: "model_tools_unsupported".to_owned(),
            message: "the requested model is not supported by the OpenAI API".to_owned(),
            retryable: false,
        }
        .into());
    }

    let command_options = CommandToolOptions {
        allow_login_shell: parsed.shell.allow_login_shell,
        exec_permission_approvals_enabled: parsed.shell.exec_permission_approvals_enabled,
    };
    if parsed.sessions.enabled && !parsed.sessions.executor_available {
        return Err(BridgeError {
            category: ErrorCategory::CapabilityError,
            code: "session_executor_unavailable".to_owned(),
            message: "background sessions require the native managed-session executor".to_owned(),
            retryable: false,
        }
        .into());
    }
    if !parsed.provider_contract.responses_sse
        || !parsed.provider_contract.remote_compaction_v2
        || !parsed.provider_contract.compact_endpoint
    {
        return Err(BridgeError {
            category: ErrorCategory::CapabilityError,
            code: "provider_contract_incomplete".to_owned(),
            message: "the selected provider contract is incomplete".to_owned(),
            retryable: false,
        }
        .into());
    }
    match parsed.provider_contract.responses_websocket {
        ProviderWebsocketContract::OfficialOnly | ProviderWebsocketContract::Unavailable => {}
    }
    let mut model_visible = vec![codex_tools::create_update_plan_tool()];
    let mut dispatch_only = Vec::new();
    let mut local_tool_names = vec!["update_plan"];
    let mut hosted_tool_names: Vec<&str> = Vec::new();
    let session_surface;
    let session_capability;
    let shell_surface = match parsed.model.shell_type {
        ConfigShellToolType::UnifiedExec => {
            model_visible.push(codex_tools::create_exec_command_tool(command_options));
            model_visible.push(codex_tools::create_write_stdin_tool());
            dispatch_only.push(codex_tools::create_shell_command_tool(command_options));
            local_tool_names.extend(["exec_command", "write_stdin"]);
            session_surface = "official";
            session_capability = if parsed.sessions.enabled {
                json!({ "status": "available", "source": "official" })
            } else {
                json!({ "status": "disabled", "reason": "disabled_by_configuration" })
            };
            "unified-exec"
        }
        ConfigShellToolType::Default
        | ConfigShellToolType::Local
        | ConfigShellToolType::ShellCommand => {
            model_visible.push(codex_tools::create_shell_command_tool(command_options));
            local_tool_names.push("shell_command");
            if parsed.sessions.enabled {
                model_visible.push(codex_tools::create_exec_command_tool(command_options));
                model_visible.push(codex_tools::create_write_stdin_tool());
                local_tool_names.extend(["exec_command", "write_stdin"]);
                session_surface = "supplemental";
                session_capability = json!({ "status": "available", "source": "supplemental" });
            } else {
                session_surface = "disabled";
                session_capability =
                    json!({ "status": "disabled", "reason": "disabled_by_configuration" });
            }
            "shell-command"
        }
        ConfigShellToolType::Disabled => {
            session_surface = "unavailable";
            session_capability =
                json!({ "status": "unavailable", "reason": "model_shell_disabled" });
            "disabled"
        }
    };
    if parsed.model.apply_patch_tool_type.is_some() {
        model_visible.push(codex_tools::create_apply_patch_freeform_tool(false));
        local_tool_names.push("apply_patch");
    }
    let view_image_available = parsed.optional.view_image
        && parsed
            .model
            .input_modalities
            .contains(&InputModality::Image);
    if view_image_available {
        model_visible.push(codex_tools::create_view_image_tool(
            codex_tools::ViewImageToolOptions {
                can_request_original_image_detail: parsed.model.supports_image_detail_original,
                include_environment_id: false,
            },
        ));
        local_tool_names.push("view_image");
    }
    let image_generation_surface = if parsed.optional.image_generation
        && parsed.provider_contract.namespace_tools
        && parsed.provider_contract.images_api
        && parsed
            .model
            .input_modalities
            .contains(&InputModality::Image)
    {
        model_visible.push(codex_tools::create_image_generation_tool());
        local_tool_names.push("image_gen.imagegen");
        "standalone"
    } else {
        "disabled"
    };

    let standalone_available = parsed.provider_contract.namespace_tools
        && parsed.provider_contract.search_api
        && (parsed.model.use_responses_lite || parsed.standalone_web_search.feature_enabled)
        && parsed.standalone_web_search.executor_available;
    let (web_surface, web_reason) = if parsed.web_search_mode == WebSearchMode::Disabled {
        ("disabled", "configured_disabled")
    } else if standalone_available {
        model_visible.push(
            codex_tools::create_standalone_web_search_tool().map_err(|_| {
                invalid_params("the official standalone web search schema is invalid")
            })?,
        );
        local_tool_names.push("web.run");
        ("standalone", "standalone_available")
    } else if !parsed.model.use_responses_lite && parsed.provider_contract.hosted_web_search {
        let hosted = codex_tools::create_web_search_tool(codex_tools::WebSearchToolOptions {
            web_search_mode: Some(parsed.web_search_mode),
            web_search_config: None,
            web_search_tool_type: parsed.model.web_search_tool_type,
        })
        .ok_or_else(|| invalid_params("tools.resolve web search mode is invalid"))?;
        model_visible.push(hosted);
        hosted_tool_names.push("web_search");
        ("hosted", "hosted_provider_capability")
    } else {
        ("unsupported", "required_capability_unavailable")
    };

    let model_tools = serialize_tool_specs(&model_visible)?;
    let dispatch_tools = serialize_tool_specs(&dispatch_only)?;
    Ok(json!({
        "modelTools": model_tools,
        "dispatchTools": dispatch_tools,
        "localToolNames": local_tool_names,
        "hostedToolNames": hosted_tool_names,
        "shellSurface": shell_surface,
        "sessionSurface": session_surface,
        "webSurface": web_surface,
        "webReason": web_reason,
        "imageGenerationSurface": image_generation_surface,
        "capabilities": {
            "sessions": session_capability,
            "applyPatch": if parsed.model.apply_patch_tool_type.is_some() {
                json!({ "status": "available", "source": "official" })
            } else {
                json!({ "status": "unavailable", "reason": "model_apply_patch_disabled" })
            },
            "viewImage": if view_image_available {
                json!({ "status": "available", "source": "official" })
            } else if !parsed.optional.view_image {
                json!({ "status": "disabled", "reason": "disabled_by_configuration" })
            } else {
                json!({ "status": "unavailable", "reason": "model_image_input_unavailable" })
            },
            "imageGeneration": if image_generation_surface == "standalone" {
                json!({ "status": "available", "source": "provider-contract" })
            } else if !parsed.optional.image_generation {
                json!({ "status": "disabled", "reason": "disabled_by_configuration" })
            } else {
                json!({ "status": "unavailable", "reason": "image_generation_route_unavailable" })
            },
            "webSearch": if web_surface == "disabled" {
                json!({ "status": "disabled", "reason": "disabled_by_configuration" })
            } else if web_surface == "unsupported" {
                json!({ "status": "unavailable", "reason": "web_search_route_unavailable" })
            } else {
                json!({ "status": "available", "source": "provider-contract" })
            },
        },
    }))
}

fn serialize_tool_specs(specs: &[ToolSpec]) -> Result<Vec<Value>, BridgeError> {
    codex_tools::create_tools_json_for_responses_api(specs).map_err(|_| BridgeError {
        category: ErrorCategory::ProtocolError,
        code: "tool_contract_serialization_failed".to_owned(),
        message: "the official tool contract could not be serialized".to_owned(),
        retryable: false,
    })
}

fn models_resolve(
    params: Value,
    _cancellation: &CancellationToken,
) -> Result<Value, RequestFailure> {
    let parsed = serde_json::from_value::<ModelsResolveParams>(params)
        .map_err(|_| invalid_params("models.resolve parameters are invalid"))?;
    if parsed.model_id.is_empty() || parsed.model_id.len() > 256 {
        return Err(invalid_params("models.resolve modelId is invalid").into());
    }
    let model = crate::models::resolve_model(&parsed.model_id);
    let shell_surface = match model.shell_type {
        ConfigShellToolType::UnifiedExec => "unified-exec",
        ConfigShellToolType::Default
        | ConfigShellToolType::Local
        | ConfigShellToolType::ShellCommand => "shell-command",
        ConfigShellToolType::Disabled => "disabled",
    };
    let auto_compact_token_limit = model.auto_compact_token_limit();
    Ok(json!({
        "model": model,
        "shellSurface": shell_surface,
        "autoCompactTokenLimit": auto_compact_token_limit,
    }))
}

async fn responses_create(
    params: Value,
    flow: &FlowController,
    cancellation: &CancellationToken,
) -> Result<Value, RequestFailure> {
    let mut parsed = serde_json::from_value::<ResponsesCreateParams>(params)
        .map_err(|_| invalid_params("responses.create parameters are invalid"))?;
    parsed.request.stream = true;
    let remote_v2_context = parsed
        .remote_compaction_v2_context
        .take()
        .map(RemoteCompactionV2Context::validate)
        .transpose()?;
    if let Some(context) = remote_v2_context.as_ref() {
        context.apply_to_request(&mut parsed.request, RemoteCompactionV2RequestKind::Turn)?;
    }
    let connection = api::connect(&parsed.connection)?;
    let websocket_connect_timeout = connection.websocket_connect_timeout;
    let mut response = await_with_cancellation(
        cancellation,
        Box::pin(start_response_stream(
            parsed.request,
            parsed.transport_mode,
            parsed.provider_supports_websockets,
            connection,
            websocket_connect_timeout,
            RemoteCompactionV2RequestMetadata {
                context: remote_v2_context.as_ref(),
                kind: RemoteCompactionV2RequestKind::Turn,
            },
            "responses_sse",
        )),
    )
    .await??;

    loop {
        let event = tokio::select! {
            () = cancellation.cancelled() => return Err(RequestFailure::Cancelled),
            event = response.rx_event.recv() => event,
        };
        let Some(event) = event else {
            break;
        };
        let event =
            event.map_err(|error| api::map_provider_contract_error(&error, "responses_sse"))?;
        let Some(mapped) = api::map_response_event(event) else {
            continue;
        };
        flow.emit(mapped.event, cancellation)
            .await
            .map_err(map_emit_error)?;
        if let Some(completion) = mapped.completion {
            return Ok(completion);
        }
    }

    Err(BridgeError {
        category: ErrorCategory::ProtocolError,
        code: "upstream_stream_ended".to_owned(),
        message: "the OpenAI response stream ended without completion".to_owned(),
        retryable: true,
    }
    .into())
}

async fn contexts_summarize(
    params: Value,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let mut parsed = serde_json::from_value::<ContextsSummarizeParams>(params)
        .map_err(|_| invalid_params("contexts.summarize parameters are invalid"))?;
    if parsed.model_id.is_empty() || parsed.model_id.len() > 256 {
        return Err(invalid_params("contexts.summarize modelId is invalid").into());
    }
    if parsed.input.is_empty() {
        return Err(invalid_params("contexts.summarize input is invalid").into());
    }
    let remote_v2_context = parsed
        .remote_compaction_v2_context
        .take()
        .map(RemoteCompactionV2Context::validate)
        .transpose()?;
    let connection = api::connect(&parsed.connection)?;
    let timeout = Duration::from_millis(PORTABLE_SUMMARY_TIMEOUT_MS);
    let result = await_with_cancellation(
        cancellation,
        Box::pin(tokio::time::timeout(
            timeout,
            contexts_summarize_inner(
                parsed.model_id,
                parsed.input,
                parsed.transport_mode,
                parsed.provider_supports_websockets,
                connection,
                cancellation,
                remote_v2_context,
            ),
        )),
    )
    .await?;
    match result {
        Ok(result) => result.map(RequestSuccess::completed),
        Err(_) => Ok(RequestSuccess::timed_out(json!({}))),
    }
}

#[allow(clippy::too_many_lines)]
async fn contexts_summarize_inner(
    model_id: String,
    input: Vec<ResponseItem>,
    transport_mode: ResponsesTransportMode,
    provider_supports_websockets: bool,
    connection: api::ApiConnection,
    cancellation: &CancellationToken,
    remote_v2_context: Option<RemoteCompactionV2Context>,
) -> Result<Value, RequestFailure> {
    let mut request = ResponsesApiRequest {
        model: model_id,
        instructions: PORTABLE_SUMMARY_V1_INSTRUCTIONS.to_owned(),
        input,
        tools: None,
        tool_choice: "none".to_owned(),
        parallel_tool_calls: false,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: Vec::new(),
        service_tier: None,
        prompt_cache_key: None,
        text: Some(TextControls {
            verbosity: Some(OpenAiVerbosity::Low),
            format: None,
        }),
        client_metadata: None,
    };
    if let Some(context) = remote_v2_context.as_ref() {
        context.apply_to_request(&mut request, RemoteCompactionV2RequestKind::Compaction)?;
    }
    let websocket_connect_timeout = connection.websocket_connect_timeout;
    let mut response = await_with_cancellation(
        cancellation,
        Box::pin(start_response_stream(
            request,
            transport_mode,
            provider_supports_websockets,
            connection,
            websocket_connect_timeout,
            RemoteCompactionV2RequestMetadata {
                context: remote_v2_context.as_ref(),
                kind: RemoteCompactionV2RequestKind::Compaction,
            },
            "portable_context_summary",
        )),
    )
    .await??;
    let mut summary = None;
    let mut completed = false;
    let mut saw_invalid_output = false;
    let mut token_usage = None;
    loop {
        let event = tokio::select! {
            () = cancellation.cancelled() => return Err(RequestFailure::Cancelled),
            event = response.rx_event.recv() => event,
        };
        let Some(event) = event else {
            break;
        };
        let event = event.map_err(|error| {
            api::map_provider_contract_error(&error, "portable_context_summary")
        })?;
        match event {
            codex_api::ResponseEvent::OutputItemDone(item) => match extract_portable_summary(&item)
            {
                Ok(text) => {
                    if summary.replace(text).is_some() {
                        saw_invalid_output = true;
                    }
                }
                Err(_) => {
                    saw_invalid_output = true;
                }
            },
            codex_api::ResponseEvent::Completed {
                token_usage: usage, ..
            } => {
                token_usage = usage;
                completed = true;
                break;
            }
            _ => {}
        }
    }
    if !completed {
        return Err(BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "portable_summary_incomplete".to_owned(),
            message: "portable context summary ended without completion".to_owned(),
            retryable: true,
        }
        .into());
    }
    if saw_invalid_output {
        return Err(
            invalid_portable_summary("portable context summary returned invalid output").into(),
        );
    }
    let Some(summary) = summary else {
        return Err(invalid_portable_summary(
            "portable context summary returned no assistant message",
        )
        .into());
    };
    let mut result = json!({ "summary": summary });
    if let Some(usage) = normalized_usage_json(token_usage) {
        result
            .as_object_mut()
            .expect("summary result should be an object")
            .insert("usage".to_owned(), usage);
    }
    Ok(result)
}

async fn start_response_stream(
    request: ResponsesApiRequest,
    transport_mode: ResponsesTransportMode,
    provider_supports_websockets: bool,
    connection: api::ApiConnection,
    websocket_connect_timeout: Duration,
    remote_v2: RemoteCompactionV2RequestMetadata<'_>,
    contract_capability: &'static str,
) -> Result<codex_api::ResponseStream, BridgeError> {
    let responses_options = match remote_v2.context {
        Some(context) => context.responses_options(remote_v2.kind)?,
        None => ResponsesOptions::default(),
    };
    let websocket_headers = match remote_v2.context {
        Some(context) => context.websocket_headers(remote_v2.kind)?,
        None => HeaderMap::default(),
    };
    if matches!(transport_mode, ResponsesTransportMode::Auto) && provider_supports_websockets {
        let websocket = ResponsesWebsocketClient::new(
            connection.provider.clone(),
            Arc::clone(&connection.authentication),
        );
        let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);
        if let Ok(Ok(websocket)) = tokio::time::timeout(
            websocket_connect_timeout,
            websocket.connect(
                &factory,
                websocket_headers,
                HeaderMap::default(),
                None,
                None,
            ),
        )
        .await
        {
            return websocket
                .stream_request(
                    ResponsesWsRequest::ResponseCreate((&request).into()),
                    false,
                    None,
                )
                .await
                .map_err(|error| api::map_provider_contract_error(&error, contract_capability));
        }
    }

    ResponsesClient::new(
        connection.transport,
        connection.provider,
        connection.authentication,
    )
    .stream_request(request, responses_options)
    .await
    .map_err(|error| api::map_provider_contract_error(&error, contract_capability))
}

async fn responses_compact(
    params: Value,
    cancellation: &CancellationToken,
) -> Result<RequestSuccess, RequestFailure> {
    let mut parsed = serde_json::from_value::<ResponsesCompactParams>(params)
        .map_err(|_| invalid_params("responses.compact parameters are invalid"))?;
    if parsed.request_timeout_ms == 0 || parsed.request_timeout_ms > 600_000 {
        return Err(invalid_params(
            "responses.compact requestTimeoutMs must be between 1 and 600000",
        )
        .into());
    }
    let remote_v2_context = parsed
        .remote_compaction_v2_context
        .take()
        .map(RemoteCompactionV2Context::validate)
        .transpose()?;
    let implementation = parsed.implementation;
    let connection = api::connect(&parsed.connection)?;
    ensure_not_cancelled(cancellation)?;
    if matches!(implementation, CompactionImplementation::RemoteV2) {
        let timeout = Duration::from_millis(parsed.request_timeout_ms);
        return match await_with_cancellation(
            cancellation,
            Box::pin(tokio::time::timeout(
                timeout,
                responses_compact_remote(
                    parsed.request,
                    parsed.transport_mode,
                    parsed.provider_supports_websockets,
                    connection,
                    cancellation,
                    remote_v2_context,
                ),
            )),
        )
        .await?
        {
            Ok(result) => result.map(RequestSuccess::completed),
            Err(_) => Ok(RequestSuccess::timed_out(json!({}))),
        };
    }
    let client = CompactClient::new(
        connection.transport,
        connection.provider,
        connection.authentication,
    );
    let request = parsed.request;
    if request.model.is_empty() || request.model.len() > 256 {
        return Err(invalid_params("responses.compact model is invalid").into());
    }
    let input = CompactionInput {
        model: &request.model,
        input: &request.input,
        instructions: &request.instructions,
        tools: request.tools,
        parallel_tool_calls: request.parallel_tool_calls,
        reasoning: request.reasoning,
        service_tier: request.service_tier.as_deref(),
        prompt_cache_key: request.prompt_cache_key.as_deref(),
        text: request.text,
    };
    ensure_not_cancelled(cancellation)?;
    let timeout = Duration::from_millis(parsed.request_timeout_ms);
    let output = await_with_cancellation(
        cancellation,
        Box::pin(client.compact_input(&input, HeaderMap::default(), timeout, None)),
    )
    .await?;
    match output {
        Ok(output) => Ok(RequestSuccess::completed(json!({ "output": output }))),
        Err(codex_api::ApiError::Transport(codex_api::TransportError::Timeout)) => {
            Ok(RequestSuccess::timed_out(json!({})))
        }
        Err(error) => Err(api::map_provider_contract_error(&error, "compact_endpoint").into()),
    }
}

#[allow(clippy::too_many_lines)]
async fn responses_compact_remote(
    request: OwnedCompactionInput,
    transport_mode: ResponsesTransportMode,
    provider_supports_websockets: bool,
    connection: api::ApiConnection,
    cancellation: &CancellationToken,
    remote_v2_context: Option<RemoteCompactionV2Context>,
) -> Result<Value, RequestFailure> {
    let retained_input = request.input.clone();
    let mut input = request.input;
    input.push(ResponseItem::CompactionTrigger {});
    let mut request = ResponsesApiRequest {
        model: request.model,
        instructions: request.instructions,
        input,
        tools: request.tools,
        tool_choice: "auto".to_owned(),
        parallel_tool_calls: request.parallel_tool_calls,
        reasoning: request.reasoning,
        store: false,
        stream: true,
        stream_options: None,
        include: vec!["reasoning.encrypted_content".to_owned()],
        service_tier: request.service_tier,
        prompt_cache_key: request.prompt_cache_key,
        text: request.text,
        client_metadata: None,
    };
    if let Some(context) = remote_v2_context.as_ref() {
        context.apply_to_request(&mut request, RemoteCompactionV2RequestKind::Compaction)?;
    }
    let websocket_connect_timeout = connection.websocket_connect_timeout;
    let mut stream = await_with_cancellation(
        cancellation,
        Box::pin(start_response_stream(
            request,
            transport_mode,
            provider_supports_websockets,
            connection,
            websocket_connect_timeout,
            RemoteCompactionV2RequestMetadata {
                context: remote_v2_context.as_ref(),
                kind: RemoteCompactionV2RequestKind::Compaction,
            },
            "remote_compaction_v2",
        )),
    )
    .await??;
    let mut compacted = None;
    let mut compacted_count = 0usize;
    let mut completed = false;
    let mut token_usage = None;
    loop {
        let event = tokio::select! {
            () = cancellation.cancelled() => return Err(RequestFailure::Cancelled),
            event = stream.rx_event.recv() => event,
        };
        let Some(event) = event else {
            break;
        };
        let event = event
            .map_err(|error| api::map_provider_contract_error(&error, "remote_compaction_v2"))?;
        match event {
            codex_api::ResponseEvent::OutputItemDone(item) => {
                if matches!(item, ResponseItem::Compaction { .. }) {
                    compacted_count += 1;
                    compacted.get_or_insert(item);
                }
            }
            codex_api::ResponseEvent::Completed {
                token_usage: usage, ..
            } => {
                token_usage = usage;
                completed = true;
                break;
            }
            _ => {}
        }
    }
    if !completed {
        return Err(BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "remote_compaction_incomplete".to_owned(),
            message: "remote compaction ended without completion".to_owned(),
            retryable: true,
        }
        .into());
    }
    if compacted_count != 1 {
        return Err(BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "remote_compaction_invalid_output".to_owned(),
            message: "remote compaction did not return exactly one compaction item".to_owned(),
            retryable: false,
        }
        .into());
    }
    let Some(compacted) = compacted else {
        return Err(BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "remote_compaction_invalid_output".to_owned(),
            message: "remote compaction returned no compaction item".to_owned(),
            retryable: false,
        }
        .into());
    };
    let mut result = json!({
        "output": crate::remote_compaction_v2::build_compacted_history(&retained_input, compacted),
    });
    if let Some(usage) = normalized_usage_json(token_usage) {
        result
            .as_object_mut()
            .expect("remote compaction result should be an object")
            .insert("usage".to_owned(), usage);
    }
    Ok(result)
}

fn invalid_portable_summary(message: &str) -> BridgeError {
    BridgeError {
        category: ErrorCategory::ProtocolError,
        code: "portable_summary_invalid_output".to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

fn normalized_usage_json(usage: Option<TokenUsage>) -> Option<Value> {
    usage.map(|usage| {
        json!({
            "inputTokens": usage.input_tokens.max(0),
            "outputTokens": usage.output_tokens.max(0),
            "cachedInputTokens": usage.cached_input_tokens.max(0),
            "reasoningTokens": usage.reasoning_output_tokens.max(0),
        })
    })
}

fn extract_portable_summary(item: &ResponseItem) -> Result<String, BridgeError> {
    let ResponseItem::Message { role, content, .. } = item else {
        return Err(invalid_portable_summary(
            "portable context summary returned a non-message output item",
        ));
    };
    if role != "assistant" {
        return Err(invalid_portable_summary(
            "portable context summary returned a non-assistant message",
        ));
    }
    let mut summary = String::new();
    for part in content {
        let ContentItem::OutputText { text } = part else {
            return Err(invalid_portable_summary(
                "portable context summary returned a non-text message part",
            ));
        };
        summary.push_str(text);
    }
    if summary.trim().is_empty() {
        return Err(invalid_portable_summary(
            "portable context summary returned empty text",
        ));
    }
    if approx_token_count(&summary) > PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS {
        return Err(invalid_portable_summary(
            "portable context summary exceeded the output limit",
        ));
    }
    Ok(summary)
}

fn invalid_params(message: &str) -> BridgeError {
    BridgeError {
        category: ErrorCategory::ProtocolError,
        code: "invalid_params".to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

fn map_emit_error(error: EmitError) -> RequestFailure {
    match error {
        EmitError::Cancelled => RequestFailure::Cancelled,
        EmitError::OutputClosed => BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "bridge_output_closed".to_owned(),
            message: "the bridge output channel closed while streaming".to_owned(),
            retryable: false,
        }
        .into(),
        EmitError::SequenceExhausted => BridgeError {
            category: ErrorCategory::ProtocolError,
            code: "event_sequence_exhausted".to_owned(),
            message: "the response produced too many bridge events".to_owned(),
            retryable: false,
        }
        .into(),
    }
}

async fn read_loop<R>(mut reader: R, output: mpsc::Sender<InputEvent>)
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let frame = match read_frame(&mut reader).await {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                let _ = output.send(InputEvent::Eof).await;
                return;
            }
            Err(ReadFrameError::Io) => {
                let _ = output.send(InputEvent::ReadFailure).await;
                return;
            }
            Err(ReadFrameError::TooLarge) => {
                let _ = output
                    .send(InputEvent::ProtocolFailure(format!(
                        "bridge frame exceeds the {MAX_FRAME_BYTES}-byte limit"
                    )))
                    .await;
                return;
            }
        };
        if frame.last() != Some(&b'\n') {
            let _ = output
                .send(InputEvent::ProtocolFailure(
                    "bridge input ended with an unterminated JSONL frame".to_owned(),
                ))
                .await;
            return;
        }
        match decode_client_frame(&frame) {
            Ok(message) => {
                if output.send(InputEvent::Message(message)).await.is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = output
                    .send(InputEvent::ProtocolFailure(error.to_string()))
                    .await;
                return;
            }
        }
    }
}

async fn read_frame<R>(reader: &mut R) -> Result<Option<Vec<u8>>, ReadFrameError>
where
    R: AsyncBufRead + Unpin,
{
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(|_| ReadFrameError::Io)?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(frame))
            };
        }
        let (length, complete) = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or((buffer.len(), false), |position| (position + 1, true));
        if frame.len() + length > MAX_FRAME_BYTES + 2 {
            return Err(ReadFrameError::TooLarge);
        }
        frame.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if complete {
            return Ok(Some(frame));
        }
    }
}

async fn write_loop<W>(mut writer: W, mut input: mpsc::Receiver<ServerMessage>) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    while let Some(message) = input.recv().await {
        let frame = encode_server_frame(&message)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        writer.write_all(&frame).await?;
        writer.flush().await?;
    }
    writer.shutdown().await
}

async fn send(output: &mpsc::Sender<ServerMessage>, message: ServerMessage) -> io::Result<()> {
    output
        .send(message)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "bridge stdout channel is closed"))
}

fn claim_request_id(seen: &mut HashSet<String>, request_id: &str) -> Result<(), RequestIdError> {
    if request_id.is_empty() || request_id.len() > MAX_REQUEST_ID_BYTES {
        Err(RequestIdError::Invalid)
    } else if seen.insert(request_id.to_owned()) {
        Ok(())
    } else {
        Err(RequestIdError::Duplicate)
    }
}

fn handshake(identity: &BuildIdentity) -> BridgeHandshake {
    let _compiled_official_modules = official::compiled_module_types();
    BridgeHandshake {
        bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
        official_codex_version: OFFICIAL_CODEX_VERSION.to_owned(),
        official_codex_tag: OFFICIAL_CODEX_TAG.to_owned(),
        official_source_commit: OFFICIAL_SOURCE_COMMIT.to_owned(),
        build_target: identity.target.clone(),
        build_source_commit: identity.source_commit.clone(),
        vendor_tree_sha256: VENDOR_TREE_SHA256.to_owned(),
        max_frame_bytes: MAX_FRAME_BYTES,
        max_pending_events: MAX_PENDING_EVENTS,
        capabilities: compiled_capabilities(),
    }
}

fn compiled_capabilities() -> Vec<BridgeCapability> {
    vec![
        BridgeCapability::ResponsesSse,
        BridgeCapability::ResponsesWebsocket,
        BridgeCapability::PortableContextSummary,
        BridgeCapability::CompactEndpoint,
        BridgeCapability::RemoteCompactionV2,
        BridgeCapability::ModelMetadata,
        BridgeCapability::UpdatePlan,
        BridgeCapability::HostedWebSearch,
        BridgeCapability::UnifiedExec,
        BridgeCapability::ShellCommand,
        BridgeCapability::ApplyPatch,
        BridgeCapability::ViewImage,
        BridgeCapability::ImageGeneration,
        BridgeCapability::StandaloneWebSearch,
    ]
}

fn protocol_error(request_id: Option<String>, code: &str, message: String) -> ServerMessage {
    ServerMessage::Error {
        request_id,
        error: BridgeError {
            category: ErrorCategory::ProtocolError,
            code: code.to_owned(),
            message,
            retryable: false,
        },
    }
}

fn invalid_request_id() -> ServerMessage {
    protocol_error(
        None,
        "invalid_request_id",
        "request ids must contain between 1 and 256 bytes".to_owned(),
    )
}

fn duplicate_request_id(request_id: String) -> ServerMessage {
    protocol_error(
        Some(request_id),
        "duplicate_request_id",
        "request ids cannot be reused on a bridge connection".to_owned(),
    )
}

fn request_id_error(error: RequestIdError, request_id: String) -> ServerMessage {
    match error {
        RequestIdError::Invalid => invalid_request_id(),
        RequestIdError::Duplicate => duplicate_request_id(request_id),
    }
}

fn parse_session_id(session_id: &str) -> Option<u64> {
    let id = session_id.parse::<u64>().ok()?;
    (id > 0).then_some(id)
}

fn unknown_session(request_id: String) -> ServerMessage {
    ServerMessage::Error {
        request_id: Some(request_id),
        error: BridgeError {
            category: ErrorCategory::NativeToolError,
            code: "unknown_session".to_owned(),
            message: "the native session is not active".to_owned(),
            retryable: false,
        },
    }
}

fn non_pty_session(request_id: String) -> ServerMessage {
    ServerMessage::Error {
        request_id: Some(request_id),
        error: session_error(
            "session_resize_unsupported",
            "the native session is not attached to a terminal",
        ),
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    use super::*;

    const FIXTURE_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64,
        0xf8, 0x0f, 0x00, 0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn process_test_timeout_ms() -> u64 {
        if cfg!(windows) { 15_000 } else { 5_000 }
    }

    async fn wait_for_file_contents(path: &Path, expected: &str) {
        tokio::time::timeout(Duration::from_millis(process_test_timeout_ms()), async {
            loop {
                if matches!(
                    tokio::fs::read_to_string(path).await,
                    Ok(contents) if contents == expected
                ) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("file should contain the expected contents before timeout");
    }

    async fn run_server(input: &str) -> Vec<ServerMessage> {
        let (mut input_client, input_server) = tokio::io::duplex(MAX_FRAME_BYTES + 2);
        let (output_server, mut output_client) = tokio::io::duplex(MAX_FRAME_BYTES + 2);
        let server = tokio::spawn(serve(
            tokio::io::BufReader::new(input_server),
            output_server,
            BuildIdentity {
                target: "x86_64-unknown-linux-musl".to_owned(),
                source_commit: "development".to_owned(),
            },
        ));

        input_client
            .write_all(input.as_bytes())
            .await
            .expect("test input should be writable");
        input_client
            .shutdown()
            .await
            .expect("test input should close");
        let mut output = Vec::new();
        output_client
            .read_to_end(&mut output)
            .await
            .expect("test output should be readable");
        server
            .await
            .expect("server task should join")
            .expect("server should complete");

        output
            .split_inclusive(|byte| *byte == b'\n')
            .map(|frame| {
                bridge_protocol::decode_server_frame(frame)
                    .expect("server output should be a valid protocol frame")
            })
            .collect()
    }

    async fn resolve_only_pending_approval(
        approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
        decision: ApprovalDecision,
    ) {
        let sender = {
            let mut approvals = approvals.lock().await;
            assert_eq!(approvals.len(), 1, "exactly one approval should be pending");
            let approval_id = approvals
                .keys()
                .next()
                .expect("approval should be registered")
                .clone();
            approvals
                .remove(&approval_id)
                .expect("approval should be registered")
        };
        sender
            .send(decision)
            .expect("approval waiter should be active");
    }

    fn assert_no_approval_messages(messages: &mut mpsc::Receiver<ServerMessage>) {
        while let Ok(message) = messages.try_recv() {
            assert!(
                !matches!(message, ServerMessage::ApprovalRequest { .. }),
                "preauthorized operations must not emit approval requests"
            );
        }
    }

    fn initialization() -> &'static str {
        concat!(
            "{\"type\":\"initialize\",\"requestId\":\"init-1\",\"protocolVersion\":5,",
            "\"client\":{\"name\":\"contract-test\",\"version\":\"0.0.0\"}}\n"
        )
    }

    #[tokio::test]
    async fn initializes_with_exact_baseline_identity_then_shuts_down() {
        let messages = run_server(&format!(
            "{}{shutdown}",
            initialization(),
            shutdown = "{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n"
        ))
        .await;

        assert_eq!(messages.len(), 2);
        let ServerMessage::Handshake { handshake, .. } = &messages[0] else {
            panic!("first server frame should be a handshake");
        };
        assert_eq!(handshake.bridge_protocol_version, BRIDGE_PROTOCOL_VERSION);
        assert_eq!(handshake.official_codex_version, OFFICIAL_CODEX_VERSION);
        assert_eq!(handshake.official_source_commit, OFFICIAL_SOURCE_COMMIT);
        assert_eq!(handshake.vendor_tree_sha256, VENDOR_TREE_SHA256);
        assert_eq!(handshake.capabilities, compiled_capabilities());
        assert!(matches!(
            &messages[1],
            ServerMessage::Result {
                status: TerminalStatus::Completed,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn rejects_a_protocol_version_mismatch_as_fatal() {
        let messages = run_server(concat!(
            "{\"type\":\"initialize\",\"requestId\":\"init-1\",\"protocolVersion\":1,",
            "\"client\":{\"name\":\"contract-test\",\"version\":\"0.0.0\"}}\n",
            "{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n"
        ))
        .await;

        assert_eq!(messages.len(), 1);
        let ServerMessage::Error { error, .. } = &messages[0] else {
            panic!("version mismatch should return an error");
        };
        assert_eq!(error.category, ErrorCategory::ProtocolError);
        assert_eq!(error.code, "protocol_version_mismatch");
    }

    #[tokio::test]
    async fn rejects_missing_unknown_and_unsupported_native_authorization() {
        let (output, _messages) = mpsc::channel(8);
        let flow = FlowController::new("request-authorization".to_owned(), output);
        let cancellation = CancellationToken::new();
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());

        for params in [
            json!({
                "tool": "shell_command",
                "command": "printf fixture",
                "workdir": ".",
                "workspaceRoots": ["."]
            }),
            json!({
                "tool": "shell_command",
                "authorization": "allow_once",
                "command": "printf fixture",
                "workdir": ".",
                "workspaceRoots": ["."]
            }),
        ] {
            let error = tools_execute(
                "request-authorization",
                params,
                &flow,
                &cancellation,
                &flow.output,
                &approvals,
                &sessions,
            )
            .await
            .expect_err("invalid authorization must fail closed");
            assert!(
                matches!(error, RequestFailure::Bridge(error) if error.code == "invalid_params")
            );
        }

        let error = tools_execute(
            "request-authorization-unsupported",
            json!({
                "tool": "future_native_tool",
                "authorization": "preauthorized"
            }),
            &flow,
            &cancellation,
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect_err("unsupported preauthorization must fail closed");
        assert!(matches!(
            error,
            RequestFailure::Bridge(error) if error.code == "preauthorization_unsupported"
        ));
        assert!(approvals.lock().await.is_empty());
    }

    #[tokio::test]
    async fn responses_require_request_scoped_connection() {
        let (output, _messages) = mpsc::channel(1);
        let flow = FlowController::new("request-1".to_owned(), output);
        let error = responses_create(
            json!({
                "request": fixture_response_request(),
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
            }),
            &flow,
            &CancellationToken::new(),
        )
        .await
        .expect_err("missing connection should fail");

        assert!(matches!(
            error,
            RequestFailure::Bridge(error) if error.code == "invalid_params"
        ));
    }

    #[tokio::test]
    async fn streams_official_sse_events_with_bounded_flow_control() {
        let (base_url, server) = spawn_fixture_http_server(
            concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\"}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-response\"}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-1".to_owned(), output));
        let cancellation = CancellationToken::new();
        let request_flow = Arc::clone(&flow);
        let request_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            responses_create(
                json!({
                    "request": fixture_response_request(),
                    "transportMode": "sse",
                    "providerSupportsWebsockets": false,
                    "connection": fixture_connection(base_url),
                }),
                &request_flow,
                &request_cancellation,
            )
            .await
        });

        let mut event_types = Vec::new();
        for sequence in 1..=2 {
            let message = messages.recv().await.expect("fixture event should arrive");
            let ServerMessage::Event {
                sequence: actual_sequence,
                event,
                ..
            } = message
            else {
                panic!("fixture output should be an event");
            };
            assert_eq!(actual_sequence, sequence);
            event_types.push(event["type"].as_str().map(str::to_owned));
            flow.acknowledge(sequence)
                .await
                .expect("fixture event should be acknowledged");
        }

        let result = request
            .await
            .expect("response request should join")
            .expect("response request should complete");
        assert_eq!(
            event_types,
            vec![
                Some("response.output_text.delta".to_owned()),
                Some("response.completed".to_owned()),
            ]
        );
        assert_eq!(result["responseId"], "fixture-response");
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    async fn falls_back_from_official_websocket_connect_to_sse() {
        let (base_url, _websocket_request, server) = spawn_websocket_fallback_server().await;
        let connection = api::connect(&fixture_connection(base_url))
            .expect("fixture API connection should build");
        let request = serde_json::from_value(fixture_response_request())
            .expect("fixture response request should be typed");
        let websocket_connect_timeout = connection.websocket_connect_timeout;
        let mut response = start_response_stream(
            request,
            ResponsesTransportMode::Auto,
            true,
            connection,
            websocket_connect_timeout,
            RemoteCompactionV2RequestMetadata {
                context: None,
                kind: RemoteCompactionV2RequestKind::Turn,
            },
            "responses_sse",
        )
        .await
        .expect("SSE fallback should connect");

        let mut completed = false;
        while let Some(event) = response.rx_event.recv().await {
            let event = event.expect("fallback event should parse");
            if matches!(event, codex_api::ResponseEvent::Completed { .. }) {
                completed = true;
                break;
            }
        }
        assert!(completed);
        server.await.expect("fallback fixture server should join");
    }

    #[tokio::test]
    async fn remote_v2_websocket_fallback_sends_codex_session_context() {
        let (base_url, websocket_request, server) = spawn_websocket_fallback_server().await;
        let connection = api::connect(&fixture_connection(base_url))
            .expect("fixture API connection should build");
        let request = serde_json::from_value(fixture_response_request())
            .expect("fixture response request should be typed");
        let websocket_connect_timeout = connection.websocket_connect_timeout;
        let context = RemoteCompactionV2Context {
            session_id: "remote-v2-session".to_owned(),
            compaction_trigger: None,
        };
        let mut response = start_response_stream(
            request,
            ResponsesTransportMode::Auto,
            true,
            connection,
            websocket_connect_timeout,
            RemoteCompactionV2RequestMetadata {
                context: Some(&context),
                kind: RemoteCompactionV2RequestKind::Turn,
            },
            "responses_sse",
        )
        .await
        .expect("SSE fallback should connect");

        let mut completed = false;
        while let Some(event) = response.rx_event.recv().await {
            if matches!(
                event.expect("fallback event should parse"),
                codex_api::ResponseEvent::Completed { .. }
            ) {
                completed = true;
                break;
            }
        }
        assert!(completed);

        let request = websocket_request
            .await
            .expect("websocket request should be captured");
        assert_eq!(
            fixture_header(&request, "session-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "thread-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "x-client-request-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "x-codex-beta-features"),
            Some("remote_compaction_v2")
        );
        assert_eq!(
            fixture_header(&request, "x-codex-window-id"),
            Some("remote-v2-session")
        );
        let turn: Value = serde_json::from_str(
            fixture_header(&request, "x-codex-turn-metadata")
                .expect("websocket request should include turn metadata"),
        )
        .expect("websocket turn metadata should be JSON");
        assert_eq!(turn["request_kind"], "turn");
        assert_eq!(turn["session_id"], "remote-v2-session");
        server.await.expect("fallback fixture server should join");
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn preserves_official_compaction_output_items() {
        let (base_url, request, server) = spawn_capturing_fixture_http_server(
            "{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}]}"
                .to_owned(),
        )
        .await;
        let result = responses_compact(
            json!({
                "request": {
                    "model": "fixture-model",
                    "input": [],
                    "instructions": "",
                    "tools": null,
                    "parallel_tool_calls": true,
                    "reasoning": null,
                    "service_tier": null,
                    "prompt_cache_key": null,
                    "text": null
                },
                "requestTimeoutMs": 1_000,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("compaction request should complete");
        assert_eq!(result.status, TerminalStatus::Completed);
        let result = result.result;

        assert_eq!(result["output"][0]["type"], "message");
        assert_eq!(result["output"][0]["role"], "assistant");
        // The pinned official CompactClient returns only Vec<ResponseItem>; it has no usage
        // envelope, so compact_endpoint must not invent token accounting fields.
        // Proof that the pinned official CompactClient contract is output-only: its
        // compact_input() returns Result<Vec<ResponseItem>, ApiError> with no usage field,
        // so completed compact_endpoint results must omit usage rather than invent it.
        assert!(result.get("usage").is_none());
        let request = request.await.expect("fixture request should be captured");
        assert_eq!(fixture_header(&request, "session-id"), None);
        assert_eq!(fixture_header(&request, "x-codex-beta-features"), None);
        let body = fixture_request_body(&request);
        assert!(body.get("client_metadata").is_none());
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn returns_a_bounded_plaintext_portable_summary_without_tools_or_remote_v2_claims() {
        let (base_url, request, server) = spawn_capturing_fixture_http_server(
            concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"portable fixture summary\"}]}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"summary-response\",\"usage\":{\"input_tokens\":7,\"input_tokens_details\":{\"cached_tokens\":2},\"output_tokens\":3,\"output_tokens_details\":{\"reasoning_tokens\":1},\"total_tokens\":10},\"output\":[]}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let result = contexts_summarize(
            json!({
                "modelId": "fixture-model",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "x" }]
                }],
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("summary request should complete");
        assert_eq!(result.status, TerminalStatus::Completed);
        let result = result.result;
        assert_eq!(result["summary"], "portable fixture summary");
        assert_eq!(result["usage"]["inputTokens"], 7);
        assert_eq!(result["usage"]["cachedInputTokens"], 2);
        assert_eq!(result["usage"]["outputTokens"], 3);
        assert_eq!(result["usage"]["reasoningTokens"], 1);

        let request = request.await.expect("fixture request should be captured");
        assert_eq!(fixture_header(&request, "session-id"), None);
        assert_eq!(fixture_header(&request, "x-codex-beta-features"), None);
        let body = fixture_request_body(&request);
        assert_eq!(body["model"], "fixture-model");
        assert_eq!(body["tool_choice"], "none");
        assert!(body.get("tools").is_none());
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("client_metadata").is_none());
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn summary_remote_v2_attribution_matches_the_compaction_prefix_policy() {
        let (base_url, request, server) = spawn_capturing_fixture_http_server(
            concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"summary with attribution\"}]}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"summary-response\",\"output\":[]}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let result = contexts_summarize(
            json!({
                "modelId": "fixture-model",
                "input": [{
                    "type": "compaction",
                    "encrypted_content": "opaque"
                }],
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
                "remoteCompactionV2Context": {
                    "sessionId": "remote-v2-session",
                    "compactionTrigger": "manual"
                },
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("summary request should complete");
        assert_eq!(result.status, TerminalStatus::Completed);

        let request = request.await.expect("fixture request should be captured");
        assert_eq!(
            fixture_header(&request, "session-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "x-codex-beta-features"),
            Some("remote_compaction_v2")
        );
        let body = fixture_request_body(&request);
        let metadata = &body["client_metadata"];
        assert_eq!(metadata["session_id"], "remote-v2-session");
        let turn: Value = serde_json::from_str(
            metadata["x-codex-turn-metadata"]
                .as_str()
                .expect("turn metadata should be a string"),
        )
        .expect("turn metadata should be JSON");
        assert_eq!(turn["request_kind"], "compaction");
        assert_eq!(turn["compaction"]["trigger"], "manual");
        assert_eq!(turn["compaction"]["reason"], "user_requested");
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    async fn contexts_summarize_rejects_missing_unknown_and_invalid_parameters() {
        let cases = [
            json!({}),
            json!({
                "connection": fixture_connection("https://example.invalid/v1".to_owned()),
                "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "x" }] }]
            }),
            json!({
                "modelId": "fixture-model",
                "connection": fixture_connection("https://example.invalid/v1".to_owned()),
                "input": [],
            }),
            json!({
                "modelId": "fixture-model",
                "connection": fixture_connection("https://example.invalid/v1".to_owned()),
                "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "x" }] }],
                "unexpected": true,
            }),
        ];

        for params in cases {
            let error = contexts_summarize(params, &CancellationToken::new())
                .await
                .expect_err("invalid contexts.summarize parameters should fail");
            assert!(matches!(
                error,
                RequestFailure::Bridge(error) if error.code == "invalid_params"
            ));
        }
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn rejects_malformed_portable_summary_output() {
        let (base_url, server) = spawn_fixture_http_server(
            concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first summary\"}]}}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"second summary\"}]}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"summary-response\",\"output\":[]}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let error = contexts_summarize(
            json!({
                "modelId": "fixture-model",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "x" }]
                }],
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect_err("malformed summary output should fail");
        assert!(matches!(
            error,
            RequestFailure::Bridge(error)
                if error.code == "portable_summary_invalid_output"
                    && error.message == "portable context summary returned invalid output"
        ));
        server.await.expect("fixture server should join");
    }

    #[test]
    fn rejects_portable_summary_output_that_exceeds_the_bound() {
        let item = ResponseItem::Message {
            id: None,
            role: "assistant".to_owned(),
            content: vec![ContentItem::OutputText {
                text: "fixture ".repeat(PORTABLE_SUMMARY_MAX_OUTPUT_TOKENS),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        };
        let error =
            extract_portable_summary(&item).expect_err("oversized summary output should fail");
        assert_eq!(error.code, "portable_summary_invalid_output");
        assert_eq!(
            error.message,
            "portable context summary exceeded the output limit"
        );
    }

    #[tokio::test]
    async fn contexts_summarize_honors_cancellation() {
        let (base_url, server) = spawn_stalling_fixture_http_server().await;
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            contexts_summarize(
                json!({
                    "modelId": "fixture-model",
                    "input": [{
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "x" }]
                    }],
                    "transportMode": "sse",
                    "providerSupportsWebsockets": false,
                    "connection": fixture_connection(base_url),
                }),
                &task_cancellation,
            )
            .await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        let result = task
            .await
            .expect("summary task should join")
            .expect_err("cancelled summary should fail");
        assert!(matches!(result, RequestFailure::Cancelled));
        server.abort();
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn preserves_remote_v2_compaction_items_without_rebuilding_them() {
        let (base_url, server) = spawn_fixture_http_server(
            concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"compaction\",\"encrypted_content\":\"opaque\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"remote-compaction\"}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let result = responses_compact(
            json!({
                "implementation": "remote_v2",
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
                "request": {
                    "model": "fixture-model",
                    "input": [{
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "x" }]
                    }],
                    "instructions": "",
                    "tools": null,
                    "parallel_tool_calls": true,
                    "reasoning": null,
                    "service_tier": null,
                    "prompt_cache_key": null,
                    "text": null
                },
                "requestTimeoutMs": 1_000,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("remote compaction should complete");
        assert_eq!(result.status, TerminalStatus::Completed);
        let result = result.result;
        assert_eq!(result["output"][0]["type"], "message");
        assert_eq!(result["output"][0]["role"], "user");
        assert_eq!(result["output"][1]["type"], "compaction");
        assert_eq!(result["output"][1]["encrypted_content"], "opaque");
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn remote_v2_compaction_sends_codex_session_context() {
        let (base_url, request, server) = spawn_capturing_fixture_http_server(
            concat!(
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"compaction\",\"encrypted_content\":\"opaque\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"remote-compaction\"}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let result = responses_compact(
            json!({
                "implementation": "remote_v2",
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
                "remoteCompactionV2Context": {
                    "sessionId": "remote-v2-session",
                    "compactionTrigger": "auto"
                },
                "request": {
                    "model": "fixture-model",
                    "input": [],
                    "instructions": "",
                    "tools": null,
                    "parallel_tool_calls": true,
                    "reasoning": null,
                    "service_tier": null,
                    "prompt_cache_key": null,
                    "text": null
                },
                "requestTimeoutMs": 1_000,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("remote compaction should complete");
        assert_eq!(result.status, TerminalStatus::Completed);
        let result = result.result;
        assert_eq!(result["output"][0]["type"], "compaction");

        let request = request.await.expect("fixture request should be captured");
        assert_eq!(
            fixture_header(&request, "session-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "x-client-request-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "x-codex-beta-features"),
            Some("remote_compaction_v2")
        );
        let body = fixture_request_body(&request);
        let metadata = &body["client_metadata"];
        assert_eq!(metadata["session_id"], "remote-v2-session");
        assert_eq!(metadata["thread_id"], "remote-v2-session");
        assert_eq!(metadata["x-codex-window-id"], "remote-v2-session");
        let turn: Value = serde_json::from_str(
            metadata["x-codex-turn-metadata"]
                .as_str()
                .expect("turn metadata should be a string"),
        )
        .expect("turn metadata should be JSON");
        assert_eq!(turn["request_kind"], "compaction");
        assert_eq!(turn["compaction"]["trigger"], "auto");
        assert_eq!(turn["compaction"]["reason"], "context_limit");
        assert_eq!(
            turn["compaction"]["implementation"],
            "responses_compaction_v2"
        );
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    #[allow(clippy::large_futures)]
    async fn remote_v2_continuation_request_keeps_codex_session_context() {
        let (base_url, request, server) = spawn_capturing_fixture_http_server(
            concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"continuation\"}}\n\n",
            )
            .to_owned(),
        )
        .await;
        let (output, mut messages) = mpsc::channel(4);
        let flow = Arc::new(FlowController::new(
            "remote-v2-continuation".to_owned(),
            output,
        ));
        let cancellation = CancellationToken::new();
        let request_flow = Arc::clone(&flow);
        let request_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            responses_create(
                json!({
                    "request": fixture_response_request(),
                    "transportMode": "sse",
                    "providerSupportsWebsockets": false,
                    "remoteCompactionV2Context": { "sessionId": "remote-v2-session" },
                    "connection": fixture_connection(base_url),
                }),
                &request_flow,
                &request_cancellation,
            )
            .await
        });
        let ServerMessage::Event { sequence, .. } = messages
            .recv()
            .await
            .expect("completion event should be emitted")
        else {
            panic!("fixture should emit a response event");
        };
        flow.acknowledge(sequence)
            .await
            .expect("completion event should be acknowledged");
        task.await
            .expect("continuation request should join")
            .expect("continuation request should complete");

        let request = request.await.expect("fixture request should be captured");
        assert_eq!(
            fixture_header(&request, "session-id"),
            Some("remote-v2-session")
        );
        assert_eq!(
            fixture_header(&request, "x-codex-window-id"),
            Some("remote-v2-session")
        );
        let body = fixture_request_body(&request);
        let turn: Value = serde_json::from_str(
            body["client_metadata"]["x-codex-turn-metadata"]
                .as_str()
                .expect("turn metadata should be a string"),
        )
        .expect("turn metadata should be JSON");
        assert_eq!(turn["request_kind"], "turn");
        assert_eq!(turn["session_id"], "remote-v2-session");
        assert!(turn.get("compaction").is_none());
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    async fn remote_v2_compaction_honors_the_request_deadline() {
        let (base_url, server) = spawn_stalling_fixture_http_server().await;
        let result = responses_compact(
            json!({
                "implementation": "remote_v2",
                "transportMode": "sse",
                "providerSupportsWebsockets": false,
                "request": {
                    "model": "fixture-model",
                    "input": [],
                    "instructions": "",
                    "tools": null,
                    "parallel_tool_calls": true,
                    "reasoning": null,
                    "service_tier": null,
                    "prompt_cache_key": null,
                    "text": null
                },
                "requestTimeoutMs": 25,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("stalled remote compaction should return a timeout status");
        assert_eq!(result.status, TerminalStatus::TimedOut);
        assert_eq!(result.result, json!({}));
        server.abort();
    }

    #[tokio::test]
    async fn compact_endpoint_honors_the_request_deadline() {
        let (base_url, server) = spawn_stalling_fixture_http_server().await;
        let result = responses_compact(
            json!({
                "request": {
                    "model": "fixture-model",
                    "input": [],
                    "instructions": "",
                    "tools": null,
                    "parallel_tool_calls": true,
                    "reasoning": null,
                    "service_tier": null,
                    "prompt_cache_key": null,
                    "text": null
                },
                "requestTimeoutMs": 25,
                "connection": fixture_connection(base_url),
            }),
            &CancellationToken::new(),
        )
        .await
        .expect("stalled compact endpoint should return a timeout status");
        assert_eq!(result.status, TerminalStatus::TimedOut);
        assert_eq!(result.result, json!({}));
        server.abort();
    }

    #[test]
    fn portable_summary_timeout_matches_the_maximum_compaction_deadline() {
        assert_eq!(PORTABLE_SUMMARY_TIMEOUT_MS, 600_000);
    }

    #[test]
    fn resolves_pinned_model_metadata_without_network_or_authentication() {
        let result = models_resolve(
            json!({ "modelId": "unknown-fixture-model" }),
            &CancellationToken::new(),
        )
        .expect("model metadata should resolve");

        assert_eq!(result["model"]["slug"], "unknown-fixture-model");
        assert_eq!(result["shellSurface"], "shell-command");
        assert_eq!(result["model"]["used_fallback_model_metadata"], Value::Null);
        assert!(result.get("provider").is_none());
    }

    #[test]
    fn resolves_official_shell_and_web_tool_contracts() {
        let model = fixture_model("unified_exec", false);
        let hosted = tools_resolve(json!({
            "model": model,
            "webSearchMode": "indexed",
            "providerContract": complete_provider_contract(true, false, false, false),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
            "sessions": { "enabled": true, "executorAvailable": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect("hosted tool surface should resolve");

        let names = hosted["modelTools"]
            .as_array()
            .expect("model tools should be an array")
            .iter()
            .filter_map(|tool| tool["name"].as_str().or_else(|| tool["type"].as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["update_plan", "exec_command", "write_stdin", "web_search"]
        );
        assert_eq!(hosted["dispatchTools"][0]["name"], "shell_command");
        assert_eq!(hosted["shellSurface"], "unified-exec");
        assert_eq!(hosted["webSurface"], "hosted");

        let standalone = tools_resolve(json!({
            "model": fixture_model("shell_command", true),
            "webSearchMode": "live",
            "providerContract": complete_provider_contract(true, true, false, true),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": true },
            "sessions": { "enabled": true, "executorAvailable": true },
            "shell": { "allowLoginShell": false, "execPermissionApprovalsEnabled": false },
        }))
        .expect("standalone tool surface should resolve");
        assert_eq!(standalone["modelTools"][1]["name"], "shell_command");
        assert_eq!(standalone["modelTools"][2]["name"], "exec_command");
        assert_eq!(standalone["modelTools"][3]["name"], "write_stdin");
        assert_eq!(standalone["sessionSurface"], "supplemental");
        assert_eq!(standalone["webSurface"], "standalone");
        assert_eq!(standalone["modelTools"].as_array().map(Vec::len), Some(5));
    }

    #[tokio::test]
    async fn executes_a_command_only_after_pi_approval_and_workspace_check() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-1".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-1",
                json!({
                    "tool": "shell_command",
                    "authorization": "require_approval",
                    "command": "printf fixture",
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace.to_string_lossy()],
                    "timeoutMs": 10_000,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages.recv().await.expect("approval should be emitted");
        let ServerMessage::ApprovalRequest { approval, .. } = approval else {
            panic!("approval should be emitted");
        };
        let expected_shell = resolve_supported_shell(None).expect("default shell");
        assert_eq!(
            approval.summary,
            format!("{expected_shell}: printf fixture")
        );
        assert_eq!(approval.details["shell"], expected_shell);
        assert_eq!(approval.details["command"], "printf fixture");
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let event = messages
            .recv()
            .await
            .expect("command output should be emitted");
        assert!(matches!(event, ServerMessage::Event { .. }));
        let result = request
            .await
            .expect("command task should join")
            .expect("command should complete");
        assert_eq!(result.status, TerminalStatus::Completed);
        assert_eq!(result.result["exitCode"], 0);
        assert!(
            result.result["output"]
                .as_str()
                .unwrap_or_default()
                .contains("fixture")
        );
    }

    #[tokio::test]
    async fn preauthorized_shell_tools_skip_approval_state_and_frames() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();

        for tool in ["exec_command", "shell_command"] {
            let (output, mut messages) = mpsc::channel(8);
            let flow = FlowController::new(format!("request-bypass-{tool}"), output);
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let params = if tool == "exec_command" {
                json!({
                    "tool": tool,
                    "authorization": "preauthorized",
                    "cmd": "printf fixture",
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace.to_string_lossy()],
                    "yield_time_ms": 10_000,
                    "allow_background_sessions": false,
                })
            } else {
                json!({
                    "tool": tool,
                    "authorization": "preauthorized",
                    "command": "printf fixture",
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace.to_string_lossy()],
                    "timeoutMs": 10_000,
                })
            };
            let result = tools_execute(
                &format!("request-bypass-{tool}"),
                params,
                &flow,
                &CancellationToken::new(),
                &flow.output,
                &approvals,
                &sessions,
            )
            .await
            .expect("preauthorized shell tool should complete");
            assert_eq!(result.status, TerminalStatus::Completed);
            assert!(
                result.result["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("fixture")
            );
            assert_no_approval_messages(&mut messages);
            assert!(approvals.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn preauthorized_shell_result_matches_prompt_approved_result() {
        async fn run(
            authorization: NativeAuthorization,
            request_id: &str,
            workspace: &Path,
        ) -> Result<RequestSuccess, RequestFailure> {
            let (output, mut messages) = mpsc::channel(8);
            let flow = Arc::new(FlowController::new(request_id.to_owned(), output));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let task_flow = Arc::clone(&flow);
            let task_approvals = Arc::clone(&approvals);
            let task_sessions = Arc::clone(&sessions);
            let task_authorization = authorization;
            let task_request_id = request_id.to_owned();
            let task_workspace = workspace.to_path_buf();
            let task_workspace_root = workspace.to_path_buf();
            let request = tokio::spawn(async move {
                tools_execute(
                    &task_request_id,
                    json!({
                        "tool": "shell_command",
                        "authorization": task_authorization,
                        "command": "printf fixture",
                        "workdir": task_workspace,
                        "workspaceRoots": [task_workspace_root],
                        "timeoutMs": 10_000,
                    }),
                    &task_flow,
                    &CancellationToken::new(),
                    &task_flow.output,
                    &task_approvals,
                    &task_sessions,
                )
                .await
            });
            if authorization == NativeAuthorization::RequireApproval {
                assert!(matches!(
                    messages.recv().await,
                    Some(ServerMessage::ApprovalRequest { .. })
                ));
                resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
            }
            let result = request.await.expect("shell task should join")?;
            assert_no_approval_messages(&mut messages);
            assert!(approvals.lock().await.is_empty());
            Ok(result)
        }

        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let prompt = run(
            NativeAuthorization::RequireApproval,
            "request-prompt-result",
            &workspace,
        )
        .await
        .expect("prompt shell should complete");
        let bypass = run(
            NativeAuthorization::Preauthorized,
            "request-bypass-result",
            &workspace,
        )
        .await
        .expect("preauthorized shell should complete");

        assert_eq!(bypass.status, prompt.status);
        assert_eq!(bypass.result["exitCode"], prompt.result["exitCode"]);
        assert_eq!(bypass.result["output"], prompt.result["output"]);
    }

    #[tokio::test]
    async fn rejects_python_as_shell_before_approval() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-python-shell".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let result = tools_execute(
            "request-python-shell",
            json!({
                "tool": "exec_command",
                "authorization": "require_approval",
                "cmd": "print('nope')",
                "shell": "python",
                "workdir": workspace_text,
                "workspaceRoots": [workspace.to_string_lossy()],
                "yield_time_ms": 250,
                "login": false,
            }),
            &flow,
            &cancellation,
            &flow.output,
            &approvals,
            &sessions,
        )
        .await;
        assert!(
            messages.try_recv().is_err(),
            "unsupported shells must not request approval"
        );
        let err = match result {
            Err(RequestFailure::Bridge(error)) => error,
            other => panic!("expected unsupported shell error, got {other:?}"),
        };
        assert_eq!(err.code, "unsupported_shell");
    }

    #[tokio::test]
    async fn executes_standard_unix_shell_paths() {
        if cfg!(windows) {
            return;
        }
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        for shell in ["/bin/sh", "/bin/bash"] {
            if !Path::new(shell).exists() {
                continue;
            }
            let (output, mut messages) = mpsc::channel(8);
            let flow = Arc::new(FlowController::new(format!("request-{shell}"), output));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let cancellation = CancellationToken::new();
            let task_flow = Arc::clone(&flow);
            let task_approvals = Arc::clone(&approvals);
            let task_sessions = Arc::clone(&sessions);
            let task_cancellation = cancellation.clone();
            let request_id = format!("request-{shell}");
            let request = tokio::spawn({
                let request_id = request_id.clone();
                let workspace_text = workspace_text.clone();
                let workspace = workspace.clone();
                async move {
                    tools_execute(
                        &request_id,
                        json!({
                            "tool": "exec_command",
                            "authorization": "require_approval",
                            "cmd": "printf fixture",
                            "shell": shell,
                            "workdir": workspace_text,
                            "workspaceRoots": [workspace.to_string_lossy()],
                            "yield_time_ms": 1_000,
                            "login": false,
                        }),
                        &task_flow,
                        &task_cancellation,
                        &task_flow.output,
                        &task_approvals,
                        &task_sessions,
                    )
                    .await
                }
            });
            let approval = messages.recv().await.expect("approval should be emitted");
            let ServerMessage::ApprovalRequest { approval, .. } = approval else {
                panic!("approval should be emitted");
            };
            let expected_shell = resolve_supported_shell(Some(shell.to_owned()))
                .expect("standard shell should resolve");
            assert_eq!(approval.details["shell"], expected_shell);
            assert!(approval.summary.starts_with(&format!("{expected_shell}:")));
            resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
            let result = request
                .await
                .expect("command task should join")
                .expect("command should complete");
            assert_eq!(result.status, TerminalStatus::Completed);
            assert!(
                result.result["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("fixture")
            );
        }
    }

    #[tokio::test]
    async fn applies_an_approved_patch_with_the_official_parser() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-patch-fixture-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        tokio::fs::write(workspace.join("fixture.txt"), "before\n")
            .await
            .expect("fixture file should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-patch".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_workspace_root = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-patch",
                json!({
                    "tool": "apply_patch",
                    "authorization": "require_approval",
                    "input": "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** Add File: added.txt\n+added\n*** End Patch",
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace_root],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages.recv().await.expect("approval should be emitted");
        assert!(matches!(
            approval,
            ServerMessage::ApprovalRequest {
                approval: ApprovalRequest {
                    operation: ApprovalOperation::Patch,
                    ..
                },
                ..
            }
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("patch task should join")
            .expect("patch should apply");
        assert_eq!(
            tokio::fs::read_to_string(workspace.join("fixture.txt"))
                .await
                .expect("updated file should be readable"),
            "after\n"
        );
        assert_eq!(result.result["added"][0], "added.txt");
        assert!(
            result.result["output"]
                .as_str()
                .unwrap_or_default()
                .contains("Modified: fixture.txt")
        );
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn accepts_workspace_absolute_patch_paths_and_returns_relative_paths() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-absolute-patch-fixture-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let source = workspace.join("source.txt");
        let destination = workspace.join("moved.txt");
        let added = workspace.join("added.txt");
        let deleted = workspace.join("deleted.txt");
        tokio::fs::write(&source, "before\n")
            .await
            .expect("source fixture should be written");
        tokio::fs::write(&deleted, "delete\n")
            .await
            .expect("delete fixture should be written");
        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n@@\n-before\n+after\n*** Add File: {}\n+added\n*** Add File: relative.txt\n+relative\n*** Delete File: {}\n*** End Patch",
            source.display(),
            destination.display(),
            added.display(),
            deleted.display()
        );
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-absolute-patch".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_workspace_root = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-absolute-patch",
                json!({
                    "tool": "apply_patch",
                    "authorization": "require_approval",
                    "input": patch,
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace_root],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages.recv().await.expect("approval should be emitted");
        let ServerMessage::ApprovalRequest { approval, .. } = approval else {
            panic!("approval should be emitted");
        };
        assert_eq!(
            approval.details["paths"],
            json!([
                "source.txt",
                "moved.txt",
                "added.txt",
                "relative.txt",
                "deleted.txt"
            ])
        );
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("patch task should join")
            .expect("patch should apply");

        assert_eq!(result.result["added"], json!(["added.txt", "relative.txt"]));
        assert_eq!(result.result["modified"], json!(["source.txt"]));
        assert_eq!(result.result["deleted"], json!(["deleted.txt"]));
        assert_eq!(
            result.result["output"],
            "Done!\nAdded: added.txt\nAdded: relative.txt\nModified: source.txt\nDeleted: deleted.txt"
        );
        assert_eq!(
            tokio::fs::read_to_string(&destination)
                .await
                .expect("moved file should be readable"),
            "after\n"
        );
        assert!(!source.exists());
        assert!(!deleted.exists());
        assert_eq!(
            tokio::fs::read_to_string(&added)
                .await
                .expect("added file should be readable"),
            "added\n"
        );
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn rejects_absolute_patch_paths_outside_workspace_before_approval() {
        let root = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-absolute-patch-escape-{}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside.txt");
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-absolute-patch-escape".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let result = tools_execute(
            "request-absolute-patch-escape",
            json!({
                "tool": "apply_patch",
                "authorization": "require_approval",
                "input": format!(
                    "*** Begin Patch\n*** Add File: {}\n+escape\n*** End Patch",
                    outside.display()
                ),
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await;

        assert!(matches!(
            result,
            Err(RequestFailure::Bridge(error)) if error.code == "workspace_escape"
        ));
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        assert!(!outside.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_absolute_patch_paths_that_escape_through_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-absolute-patch-symlink-{}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        let link = workspace.join("link");
        let target = link.join("escape.txt");
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("workspace should be created");
        tokio::fs::create_dir_all(&outside)
            .await
            .expect("outside directory should be created");
        symlink(&outside, &link).expect("fixture symlink should be created");
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-absolute-patch-symlink".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let result = tools_execute(
            "request-absolute-patch-symlink",
            json!({
                "tool": "apply_patch",
                "authorization": "require_approval",
                "input": format!(
                    "*** Begin Patch\n*** Add File: {}\n+escape\n*** End Patch",
                    target.display()
                ),
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await;

        assert!(matches!(
            result,
            Err(RequestFailure::Bridge(error)) if error.code == "workspace_escape"
        ));
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        assert!(!outside.join("escape.txt").exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn preauthorized_patch_skips_approval_state_after_path_validation() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-bypass-patch-fixture-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        tokio::fs::write(workspace.join("fixture.txt"), "before\n")
            .await
            .expect("fixture file should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-bypass-patch".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let patch = format!(
            "*** Begin Patch\n*** Update File: {}\n@@\n-before\n+after\n*** End Patch",
            workspace.join("fixture.txt").display()
        );
        let result = tools_execute(
            "request-bypass-patch",
            json!({
                "tool": "apply_patch",
                "authorization": "preauthorized",
                "input": patch,
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized patch should apply");

        assert_eq!(result.result["modified"][0], "fixture.txt");
        assert_eq!(
            tokio::fs::read_to_string(workspace.join("fixture.txt"))
                .await
                .expect("updated file should be readable"),
            "after\n"
        );
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn keeps_unified_exec_sessions_for_write_and_poll() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-session".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let command = if cfg!(windows) {
            "$line = [Console]::In.ReadLine(); Write-Output $line"
        } else {
            "read line; printf '%s' \"$line\""
        };
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let initial = tokio::spawn(async move {
            tools_execute(
                "request-session",
                json!({
                    "tool": "exec_command",
                    "authorization": "require_approval",
                    "cmd": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace.to_string_lossy()],
                    "tty": false,
                    "yield_time_ms": 250,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let initial = initial
            .await
            .expect("initial command should join")
            .expect("initial command should yield");
        let session_id = initial.result["session_id"]
            .as_u64()
            .expect("running command should return a session id");

        let write_flow = Arc::clone(&flow);
        let write_approvals = Arc::clone(&approvals);
        let write_sessions = Arc::clone(&sessions);
        let write_cancellation = cancellation.clone();
        let write = tokio::spawn(async move {
            tools_execute(
                "request-poll",
                json!({
                    "tool": "write_stdin",
                    "authorization": "require_approval",
                    "session_id": session_id,
                    "chars": "fixture\n",
                    "yield_time_ms": process_test_timeout_ms(),
                }),
                &write_flow,
                &write_cancellation,
                &write_flow.output,
                &write_approvals,
                &write_sessions,
            )
            .await
        });
        let write_approval = messages
            .recv()
            .await
            .expect("write_stdin approval should be emitted");
        match write_approval {
            ServerMessage::ApprovalRequest { approval, .. } => {
                assert_eq!(approval.operation, ApprovalOperation::Command);
                assert_eq!(approval.summary, "fixture\\n");
                assert_eq!(approval.details["sessionId"], json!(session_id.to_string()));
                assert_eq!(approval.details["inputPreview"], json!("fixture\\n"));
                assert_eq!(approval.details["inputTruncated"], false);
            }
            other => panic!("expected write_stdin approval, got {other:?}"),
        }
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let polled = write
            .await
            .expect("session write should join")
            .expect("session write should complete");
        assert_eq!(polled.result["exit_code"], 0);
        assert!(
            polled.result["output"]
                .as_str()
                .unwrap_or_default()
                .contains("fixture")
        );
        assert!(sessions.get(&session_id.to_string()).await.is_none());
    }

    #[tokio::test]
    async fn preauthorized_session_writes_skip_approval_state() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(16);
        let flow = FlowController::new("request-bypass-session".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let command = if cfg!(windows) {
            "$line = [Console]::In.ReadLine(); Write-Output $line"
        } else {
            "read line; printf '%s' \"$line\""
        };
        let initial = tools_execute(
            "request-bypass-session-start",
            json!({
                "tool": "exec_command",
                "authorization": "preauthorized",
                "cmd": command,
                "workdir": workspace_text,
                "workspaceRoots": [workspace.to_string_lossy()],
                "yield_time_ms": 250,
                "allow_background_sessions": true,
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized command should yield a session");
        let session_number = initial.result["session_id"]
            .as_u64()
            .expect("running command should return a session id");
        let session_id = session_number.to_string();
        let (_, session) = sessions
            .get(&session_id)
            .await
            .expect("session should remain active");
        let cancelled_write = CancellationToken::new();
        cancelled_write.cancel();
        let cancelled = write_session_stdin(
            "request-bypass-control-write-cancelled",
            &session_id,
            NativeAuthorization::Preauthorized,
            "should-not-be-written\n".to_owned(),
            &session,
            &flow.output,
            &approvals,
            &cancelled_write,
        )
        .await;
        assert!(matches!(cancelled, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        let direct_write = write_session_stdin(
            "request-bypass-control-write",
            &session_id,
            NativeAuthorization::Preauthorized,
            "fixture\n".to_owned(),
            &session,
            &flow.output,
            &approvals,
            &CancellationToken::new(),
        )
        .await
        .expect("preauthorized control write should complete");
        assert_eq!(direct_write["sessionId"], session_id);
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());

        let poll = tools_execute(
            "request-bypass-session-poll",
            json!({
                "tool": "write_stdin",
                "authorization": "preauthorized",
                "session_id": session_number,
                "chars": "",
                "yield_time_ms": process_test_timeout_ms(),
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized session poll should complete");
        assert_eq!(poll.result["exit_code"], 0);
        assert!(
            poll.result["output"]
                .as_str()
                .unwrap_or_default()
                .contains("fixture")
        );
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
    }

    #[tokio::test]
    async fn preauthorized_write_stdin_skips_approval_state() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(16);
        let flow = FlowController::new("request-bypass-write-stdin".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let command = if cfg!(windows) {
            "$line = [Console]::In.ReadLine(); Write-Output $line"
        } else {
            "read line; printf '%s' \"$line\""
        };
        let initial = tools_execute(
            "request-bypass-write-stdin-start",
            json!({
                "tool": "exec_command",
                "authorization": "preauthorized",
                "cmd": command,
                "workdir": workspace_text,
                "workspaceRoots": [workspace.to_string_lossy()],
                "yield_time_ms": 250,
                "allow_background_sessions": true,
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized command should yield a session");
        let session_id = initial.result["session_id"]
            .as_u64()
            .expect("running command should return a session id");

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let cancelled_result = tools_execute(
            "request-bypass-write-stdin-cancelled",
            json!({
                "tool": "write_stdin",
                "authorization": "preauthorized",
                "session_id": session_id,
                "chars": "should-not-be-written\n",
                "yield_time_ms": process_test_timeout_ms(),
            }),
            &flow,
            &cancelled,
            &flow.output,
            &approvals,
            &sessions,
        )
        .await;
        assert!(matches!(cancelled_result, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());

        let result = tools_execute(
            "request-bypass-write-stdin",
            json!({
                "tool": "write_stdin",
                "authorization": "preauthorized",
                "session_id": session_id,
                "chars": "fixture\n",
                "yield_time_ms": process_test_timeout_ms(),
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized write_stdin should complete");

        assert_eq!(result.status, TerminalStatus::Completed);
        assert_eq!(result.result["exit_code"], 0);
        assert!(
            result.result["output"]
                .as_str()
                .unwrap_or_default()
                .contains("fixture")
        );
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        assert!(sessions.get(&session_id.to_string()).await.is_none());
    }

    #[tokio::test]
    async fn reads_an_approved_workspace_image_with_the_official_image_adapter() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-image-fixture-{}",
            std::process::id()
        ));
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let image_path = workspace.join("fixture.png");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-image".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-image",
                json!({
                    "tool": "view_image",
                    "authorization": "require_approval",
                    "path": image_path,
                    "detail": "original",
                    "workspaceRoots": [task_workspace],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest {
                approval: ApprovalRequest {
                    operation: ApprovalOperation::Filesystem,
                    ..
                },
                ..
            })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("image task should join")
            .expect("image should load");
        assert_eq!(result.result["detail"], "original");
        assert!(
            result.result["image_url"]
                .as_str()
                .unwrap_or_default()
                .starts_with("data:image/png;base64,")
        );
        tokio::fs::remove_dir_all(workspace)
            .await
            .expect("fixture directory should be removed");
    }

    #[tokio::test]
    async fn rejects_an_image_that_exceeds_the_limit_while_approval_is_pending() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-image-growth-fixture-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let image_path = workspace.join("fixture.png");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-growing-image".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_image_path = image_path.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-growing-image",
                json!({
                    "tool": "view_image",
                    "authorization": "require_approval",
                    "path": task_image_path,
                    "detail": "original",
                    "workspaceRoots": [task_workspace],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest {
                approval: ApprovalRequest {
                    operation: ApprovalOperation::Filesystem,
                    ..
                },
                ..
            })
        ));
        tokio::fs::OpenOptions::new()
            .write(true)
            .open(&image_path)
            .await
            .expect("fixture image should open")
            .set_len(MAX_IMAGE_SOURCE_BYTES.saturating_add(1))
            .await
            .expect("fixture image should grow");
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let error = request
            .await
            .expect("image task should join")
            .expect_err("grown image should be rejected");
        assert!(matches!(
            error,
            RequestFailure::Bridge(BridgeError { ref code, .. }) if code == "image_too_large"
        ));
        assert!(approvals.lock().await.is_empty());
        tokio::fs::remove_dir_all(workspace)
            .await
            .expect("fixture directory should be removed");
    }

    #[tokio::test]
    async fn preauthorized_view_image_skips_approval_state_after_file_validation() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-bypass-image-fixture-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let image_path = workspace.join("fixture.png");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-bypass-image".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let result = tools_execute(
            "request-bypass-image",
            json!({
                "tool": "view_image",
                "authorization": "preauthorized",
                "path": image_path,
                "detail": "original",
                "workspaceRoots": [workspace],
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized image read should complete");
        assert_eq!(result.result["detail"], "original");
        assert!(
            result.result["image_url"]
                .as_str()
                .unwrap_or_default()
                .starts_with("data:image/png;base64,")
        );
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn generates_an_image_with_the_official_typed_client() {
        let (base_url, server) = spawn_fixture_http_server(
            json!({
                "created": 1,
                "data": [{ "b64_json": "ZmFrZQ==" }],
                "background": "auto",
                "quality": "auto",
                "size": "auto"
            })
            .to_string(),
        )
        .await;
        let workspace = std::env::current_dir().expect("fixture workdir should resolve");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-imagegen".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-imagegen",
                json!({
                    "tool": "image_gen.imagegen",
                    "authorization": "require_approval",
                    "prompt": "fixture image",
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace],
                    "connection": fixture_connection(base_url),
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages
            .recv()
            .await
            .expect("network approval should be emitted");
        assert!(matches!(
            approval,
            ServerMessage::ApprovalRequest {
                approval: ApprovalRequest {
                    operation: ApprovalOperation::Network,
                    ..
                },
                ..
            }
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("image generation task should join")
            .expect("image generation should complete");
        assert_eq!(result.status, TerminalStatus::Completed);
        assert_eq!(result.result["image_url"], "data:image/png;base64,ZmFrZQ==");
        assert_eq!(result.result["revised_prompt"], "fixture image");
        server.await.expect("fixture server should join");
    }

    #[tokio::test]
    async fn preauthorized_image_generation_skips_file_and_network_approvals() {
        let (base_url, server) = spawn_fixture_http_server(
            json!({
                "created": 1,
                "data": [{ "b64_json": "ZmFrZQ==" }]
            })
            .to_string(),
        )
        .await;
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-bypass-imagegen-fixture-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let image_path = workspace.join("reference.png");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-bypass-imagegen".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let result = tools_execute(
            "request-bypass-imagegen",
            json!({
                "tool": "image_gen.imagegen",
                "authorization": "preauthorized",
                "prompt": "fixture image",
                "referencedImagePaths": [image_path],
                "workdir": workspace,
                "workspaceRoots": [workspace],
                "connection": fixture_connection(base_url),
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized image generation should complete");
        assert_eq!(result.result["image_url"], "data:image/png;base64,ZmFrZQ==");
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        server.await.expect("fixture server should join");
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn runs_standalone_web_search_with_the_official_search_client() {
        let (base_url, server) = spawn_fixture_http_server(
            json!({ "encrypted_output": "opaque", "output": "fixture search" }).to_string(),
        )
        .await;
        let workspace = std::env::current_dir().expect("fixture workdir should resolve");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-web".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-web",
                json!({
                    "tool": "web.run",
                    "authorization": "require_approval",
                    "commands": { "search_query": [{ "q": "fixture" }] },
                    "conversationItems": [],
                    "model": "fixture-model",
                    "requestSessionId": "fixture-session",
                    "webSearchMode": "indexed",
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace],
                    "connection": fixture_connection(base_url),
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages
            .recv()
            .await
            .expect("network approval should be emitted");
        assert!(matches!(
            approval,
            ServerMessage::ApprovalRequest {
                approval: ApprovalRequest {
                    operation: ApprovalOperation::Network,
                    ..
                },
                ..
            }
        ));
        if let ServerMessage::ApprovalRequest { approval, .. } = &approval {
            assert_eq!(
                approval.available_decisions,
                ApprovalDecision::ADVERTISED.to_vec()
            );
        }
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("web search task should join")
            .expect("web search should complete");
        assert_eq!(result.result["output"], "fixture search");
        server.abort();
    }

    #[tokio::test]
    async fn preauthorized_web_search_skips_network_approval_state() {
        let (base_url, server) = spawn_fixture_http_server(
            json!({ "encrypted_output": "opaque", "output": "fixture search" }).to_string(),
        )
        .await;
        let workspace = std::env::current_dir().expect("fixture workdir should resolve");
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-bypass-web".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let result = tools_execute(
            "request-bypass-web",
            json!({
                "tool": "web.run",
                "authorization": "preauthorized",
                "commands": { "search_query": [{ "q": "fixture" }] },
                "conversationItems": [],
                "model": "fixture-model",
                "requestSessionId": "fixture-session",
                "webSearchMode": "indexed",
                "workdir": workspace,
                "workspaceRoots": [workspace],
                "connection": fixture_connection(base_url),
            }),
            &flow,
            &CancellationToken::new(),
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("preauthorized web search should complete");
        assert_eq!(result.result["output"], "fixture search");
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn preauthorized_cancellation_blocks_image_and_web_network_calls() {
        let (base_url, hits, server) = spawn_counting_fixture_http_server().await;
        let workspace = std::env::current_dir().expect("fixture workdir should resolve");
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let (image_output, mut image_messages) = mpsc::channel(8);
        let image_flow = FlowController::new(
            "request-bypass-cancel-image-network".to_owned(),
            image_output,
        );
        let image_approvals = Arc::new(Mutex::new(HashMap::new()));
        let image_sessions = Arc::new(NativeSessions::default());
        let image = tools_execute(
            "request-bypass-cancel-image-network",
            json!({
                "tool": "image_gen.imagegen",
                "authorization": "preauthorized",
                "prompt": "fixture image",
                "workdir": workspace,
                "workspaceRoots": [workspace],
                "connection": fixture_connection(base_url.clone()),
            }),
            &image_flow,
            &cancellation,
            &image_flow.output,
            &image_approvals,
            &image_sessions,
        )
        .await;
        assert!(matches!(image, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut image_messages);
        assert!(image_approvals.lock().await.is_empty());

        let (web_output, mut web_messages) = mpsc::channel(8);
        let web_flow =
            FlowController::new("request-bypass-cancel-web-network".to_owned(), web_output);
        let web_approvals = Arc::new(Mutex::new(HashMap::new()));
        let web_sessions = Arc::new(NativeSessions::default());
        let web = tools_execute(
            "request-bypass-cancel-web-network",
            json!({
                "tool": "web.run",
                "authorization": "preauthorized",
                "commands": { "search_query": [{ "q": "fixture" }] },
                "conversationItems": [],
                "model": "fixture-model",
                "requestSessionId": "fixture-session",
                "webSearchMode": "indexed",
                "workdir": workspace,
                "workspaceRoots": [workspace],
                "connection": fixture_connection(base_url),
            }),
            &web_flow,
            &cancellation,
            &web_flow.output,
            &web_approvals,
            &web_sessions,
        )
        .await;
        assert!(matches!(web, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut web_messages);
        assert!(web_approvals.lock().await.is_empty());
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[test]
    fn shell_surface_matrix_covers_official_config_shell_tool_types() {
        for (shell_type, expected_surface, expected_visible, expected_dispatch) in [
            (
                "unified_exec",
                "unified-exec",
                vec!["update_plan", "exec_command", "write_stdin"],
                Some("shell_command"),
            ),
            (
                "default",
                "shell-command",
                vec!["update_plan", "shell_command"],
                None,
            ),
            (
                "local",
                "shell-command",
                vec!["update_plan", "shell_command"],
                None,
            ),
            (
                "shell_command",
                "shell-command",
                vec!["update_plan", "shell_command"],
                None,
            ),
            ("disabled", "disabled", vec!["update_plan"], None),
        ] {
            let resolved = tools_resolve(json!({
                "model": fixture_model(shell_type, false),
                "webSearchMode": "disabled",
                "providerContract": complete_provider_contract(false, false, false, false),
                "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
                "sessions": { "enabled": false, "executorAvailable": true },
                "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
            }))
            .expect("shell matrix entry should resolve");
            assert_eq!(resolved["shellSurface"], expected_surface);
            let names = resolved["modelTools"]
                .as_array()
                .expect("model tools")
                .iter()
                .filter_map(|tool| tool["name"].as_str().or_else(|| tool["type"].as_str()))
                .collect::<Vec<_>>();
            assert_eq!(names, expected_visible, "shell type {shell_type}");
            match expected_dispatch {
                Some(name) => assert_eq!(resolved["dispatchTools"][0]["name"], name),
                None => assert_eq!(resolved["dispatchTools"].as_array().map(Vec::len), Some(0)),
            }
        }
    }

    #[test]
    fn web_surface_matrix_covers_disabled_standalone_hosted_and_unsupported() {
        let disabled = tools_resolve(json!({
            "model": fixture_model("shell_command", false),
            "webSearchMode": "disabled",
            "providerContract": complete_provider_contract(true, true, false, true),
            "standaloneWebSearch": { "featureEnabled": true, "executorAvailable": true },
            "sessions": { "enabled": false, "executorAvailable": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect("disabled web surface should resolve");
        assert_eq!(disabled["webSurface"], "disabled");

        let standalone = tools_resolve(json!({
            "model": fixture_model("shell_command", true),
            "webSearchMode": "live",
            "providerContract": complete_provider_contract(true, true, false, true),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": true },
            "sessions": { "enabled": false, "executorAvailable": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect("standalone web surface should resolve");
        assert_eq!(standalone["webSurface"], "standalone");

        let hosted = tools_resolve(json!({
            "model": fixture_model("shell_command", false),
            "webSearchMode": "indexed",
            "providerContract": complete_provider_contract(true, false, false, false),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
            "sessions": { "enabled": false, "executorAvailable": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect("hosted web surface should resolve");
        assert_eq!(hosted["webSurface"], "hosted");

        let unsupported = tools_resolve(json!({
            "model": fixture_model("shell_command", false),
            "webSearchMode": "cached",
            "providerContract": complete_provider_contract(false, false, false, false),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
            "sessions": { "enabled": false, "executorAvailable": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect("unsupported web surface should resolve");
        assert_eq!(unsupported["webSurface"], "unsupported");
    }

    #[test]
    fn supplements_shell_command_with_managed_session_contracts() {
        let resolved = tools_resolve(json!({
            "model": fixture_model("shell_command", false),
            "webSearchMode": "disabled",
            "providerContract": complete_provider_contract(false, false, false, false),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
            "sessions": { "enabled": true, "executorAvailable": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect("supplemental sessions should resolve");
        let names = resolved["modelTools"]
            .as_array()
            .expect("model tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "update_plan",
                "shell_command",
                "exec_command",
                "write_stdin"
            ]
        );
        assert_eq!(resolved["sessionSurface"], "supplemental");
        assert_eq!(resolved["capabilities"]["sessions"]["status"], "available");
        assert_eq!(
            resolved["localToolNames"],
            json!([
                "update_plan",
                "shell_command",
                "exec_command",
                "write_stdin"
            ])
        );
    }

    #[test]
    fn session_resolver_fields_fail_closed() {
        let base = json!({
            "model": fixture_model("shell_command", false),
            "webSearchMode": "disabled",
            "providerContract": complete_provider_contract(false, false, false, false),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
            "sessions": { "enabled": true, "executorAvailable": false },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        });
        let error = tools_resolve(base).expect_err("missing session executor must fail");
        assert!(matches!(
            error,
            RequestFailure::Bridge(error) if error.code == "session_executor_unavailable"
        ));

        let unknown = tools_resolve(json!({
            "model": fixture_model("shell_command", false),
            "webSearchMode": "disabled",
            "providerContract": complete_provider_contract(false, false, false, false),
            "standaloneWebSearch": { "featureEnabled": false, "executorAvailable": false },
            "sessions": { "enabled": false, "executorAvailable": true, "future": true },
            "shell": { "allowLoginShell": true, "execPermissionApprovalsEnabled": false },
        }))
        .expect_err("unknown protocol-v4 session fields must fail");
        assert!(matches!(
            unknown,
            RequestFailure::Bridge(error) if error.code == "invalid_params"
        ));
    }

    #[test]
    fn login_shell_semantics_follow_official_defaults() {
        assert!(resolve_use_login_shell(None, true).expect("default login"));
        assert!(!resolve_use_login_shell(Some(false), true).expect("explicit non-login"));
        assert!(!resolve_use_login_shell(None, false).expect("disabled default"));
        let err = resolve_use_login_shell(Some(true), false).expect_err("login disabled");
        assert_eq!(err.code, "login_shell_disabled");

        #[cfg(not(windows))]
        {
            let (program, args) = build_shell_invocation("/bin/bash", "true".to_owned(), true);
            assert_eq!(program, "/bin/bash");
            assert_eq!(args, vec!["-lc".to_owned(), "true".to_owned()]);
            let (_, non_login) = build_shell_invocation("/bin/bash", "true".to_owned(), false);
            assert_eq!(non_login, vec!["-c".to_owned(), "true".to_owned()]);
        }

        #[cfg(windows)]
        {
            let (program, args) = build_shell_invocation("powershell.exe", "true".to_owned(), true);
            assert_eq!(program, "powershell.exe");
            assert_eq!(args, vec!["-Command".to_owned(), "true".to_owned()]);
            let (_, non_login) = build_shell_invocation("powershell.exe", "true".to_owned(), false);
            assert_eq!(
                non_login,
                vec![
                    "-NoProfile".to_owned(),
                    "-Command".to_owned(),
                    "true".to_owned()
                ]
            );
            let (_, cmd_args) = build_shell_invocation("cmd.exe", "ver".to_owned(), false);
            assert_eq!(cmd_args, vec!["/c".to_owned(), "ver".to_owned()]);
        }
    }

    #[test]
    fn rejects_non_shell_programs_and_accepts_standard_shell_paths() {
        for program in [
            "python",
            "python3",
            "/usr/bin/python3",
            "node",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\python.exe",
            "bash -c evil",
            "./bash",
            "../bash",
            "/tmp/bash",
            "/var/tmp/bash",
        ] {
            let err = resolve_supported_shell(Some(program.to_owned()))
                .expect_err("non-shell programs must be rejected");
            assert_eq!(err.code, "unsupported_shell", "{program}");
        }

        #[cfg(not(windows))]
        {
            for program in ["/bin/sh", "/bin/bash", "sh", "bash"] {
                if program.contains('/') && !Path::new(program).exists() {
                    continue;
                }
                let resolved =
                    resolve_supported_shell(Some(program.to_owned())).unwrap_or_else(|error| {
                        panic!("standard shell should resolve: {program} ({error:?})")
                    });
                assert!(
                    resolve_host_shell_program(&resolved).is_ok(),
                    "resolved shell must remain supported: {resolved}"
                );
                assert!(
                    Path::new(&resolved).is_absolute(),
                    "resolved shell must be absolute: {resolved}"
                );
                let stem = supported_shell_stem(&resolved).expect("stem");
                assert!(
                    matches!(stem.as_str(), "sh" | "bash" | "dash"),
                    "unexpected shell stem {stem} for {program} -> {resolved}"
                );
            }
        }

        #[cfg(windows)]
        {
            for program in ["powershell.exe", "pwsh", "cmd.exe"] {
                if let Ok(resolved) = resolve_supported_shell(Some(program.to_owned())) {
                    assert!(
                        resolve_host_shell_program(&resolved).is_ok(),
                        "resolved shell must remain supported: {resolved}"
                    );
                    assert!(
                        Path::new(&resolved).is_absolute(),
                        "resolved shell must be absolute: {resolved}"
                    );
                }
            }
        }

        let resolved_default = resolve_supported_shell(None).expect("default shell");
        assert!(
            resolve_host_shell_program(&resolved_default).is_ok(),
            "default shell must be supported: {resolved_default}"
        );
        assert!(
            Path::new(&resolved_default).is_absolute(),
            "default shell must resolve to an absolute host path: {resolved_default}"
        );
    }

    #[test]
    fn max_output_tokens_truncates_with_original_token_count() {
        let large = "abcdefghij".repeat(20);
        let (output, original) = truncate_command_output(&large, 2);
        assert!(original.is_some());
        assert!(output.contains("Warning: truncated output"));
        assert!(output.len() < large.len());
        let (kept, none) = truncate_command_output("short", 1_000);
        assert_eq!(kept, "short");
        assert_eq!(none, None);
    }

    #[tokio::test]
    async fn rejects_workspace_escape_before_approval() {
        let workspace = std::env::current_dir().expect("workspace");
        let outside = std::env::temp_dir();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-escape".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let result = tools_execute(
            "request-escape",
            json!({
                "tool": "shell_command",
                "authorization": "require_approval",
                "command": "printf fixture",
                "workdir": outside,
                "workspaceRoots": [workspace],
                "timeoutMs": 1_000,
            }),
            &flow,
            &cancellation,
            &flow.output,
            &approvals,
            &sessions,
        )
        .await;
        assert!(
            messages.try_recv().is_err(),
            "escape must not request approval"
        );
        let err = match result {
            Err(RequestFailure::Bridge(error)) => error,
            other => panic!("expected workspace escape error, got {other:?}"),
        };
        assert_eq!(err.code, "workspace_escape");
    }

    #[tokio::test]
    async fn preauthorized_workspace_escape_still_fails_before_side_effect() {
        let workspace = std::env::current_dir().expect("workspace");
        let outside = std::env::temp_dir();
        let (output, mut messages) = mpsc::channel(8);
        let flow = FlowController::new("request-bypass-escape".to_owned(), output);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let result = tools_execute(
            "request-bypass-escape",
            json!({
                "tool": "shell_command",
                "authorization": "preauthorized",
                "command": "printf fixture",
                "workdir": outside,
                "workspaceRoots": [workspace],
                "timeoutMs": 1_000,
            }),
            &flow,
            &cancellation,
            &flow.output,
            &approvals,
            &sessions,
        )
        .await;
        assert!(matches!(
            result,
            Err(RequestFailure::Bridge(error)) if error.code == "workspace_escape"
        ));
        assert_no_approval_messages(&mut messages);
        assert!(approvals.lock().await.is_empty());

        let (patch_output, mut patch_messages) = mpsc::channel(8);
        let patch_flow =
            FlowController::new("request-bypass-patch-escape".to_owned(), patch_output);
        let patch_approvals = Arc::new(Mutex::new(HashMap::new()));
        let patch_sessions = Arc::new(NativeSessions::default());
        let patch = tools_execute(
            "request-bypass-patch-escape",
            json!({
                "tool": "apply_patch",
                "authorization": "preauthorized",
                "input": "*** Begin Patch\n*** Add File: ../escape.txt\n+escape\n*** End Patch",
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &patch_flow,
            &CancellationToken::new(),
            &patch_flow.output,
            &patch_approvals,
            &patch_sessions,
        )
        .await;
        assert!(matches!(
            patch,
            Err(RequestFailure::Bridge(error)) if error.code == "invalid_patch_path"
        ));
        assert_no_approval_messages(&mut patch_messages);
        assert!(patch_approvals.lock().await.is_empty());
    }

    #[tokio::test]
    async fn preauthorized_cancellation_blocks_shell_patch_and_image_side_effects() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-bypass-cancel-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("workspace should be created");
        let target = workspace.join("fixture.txt");
        let image = workspace.join("fixture.png");
        tokio::fs::write(&target, "before\n")
            .await
            .expect("patch target should be written");
        tokio::fs::write(&image, FIXTURE_PNG)
            .await
            .expect("image fixture should be written");

        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let (shell_output, mut shell_messages) = mpsc::channel(8);
        let shell_flow =
            FlowController::new("request-bypass-cancel-shell".to_owned(), shell_output);
        let shell_approvals = Arc::new(Mutex::new(HashMap::new()));
        let shell_sessions = Arc::new(NativeSessions::default());
        let shell = tools_execute(
            "request-bypass-cancel-shell",
            json!({
                "tool": "shell_command",
                "authorization": "preauthorized",
                "command": "printf should-not-run",
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &shell_flow,
            &cancellation,
            &shell_flow.output,
            &shell_approvals,
            &shell_sessions,
        )
        .await;
        assert!(matches!(shell, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut shell_messages);
        assert!(shell_approvals.lock().await.is_empty());
        assert!(shell_sessions.entries.lock().await.is_empty());

        let (patch_output, mut patch_messages) = mpsc::channel(8);
        let patch_flow =
            FlowController::new("request-bypass-cancel-patch".to_owned(), patch_output);
        let patch_approvals = Arc::new(Mutex::new(HashMap::new()));
        let patch_sessions = Arc::new(NativeSessions::default());
        let patch = tools_execute(
            "request-bypass-cancel-patch",
            json!({
                "tool": "apply_patch",
                "authorization": "preauthorized",
                "input": "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** End Patch",
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &patch_flow,
            &cancellation,
            &patch_flow.output,
            &patch_approvals,
            &patch_sessions,
        )
        .await;
        assert!(matches!(patch, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut patch_messages);
        assert_eq!(
            tokio::fs::read_to_string(&target).await.expect("target"),
            "before\n"
        );

        let (image_output, mut image_messages) = mpsc::channel(8);
        let image_flow =
            FlowController::new("request-bypass-cancel-image".to_owned(), image_output);
        let image_approvals = Arc::new(Mutex::new(HashMap::new()));
        let image_sessions = Arc::new(NativeSessions::default());
        let image_result = tools_execute(
            "request-bypass-cancel-image",
            json!({
                "tool": "view_image",
                "authorization": "preauthorized",
                "path": image,
                "workdir": workspace,
                "workspaceRoots": [workspace],
            }),
            &image_flow,
            &cancellation,
            &image_flow.output,
            &image_approvals,
            &image_sessions,
        )
        .await;
        assert!(matches!(image_result, Err(RequestFailure::Cancelled)));
        assert_no_approval_messages(&mut image_messages);
        assert!(image_approvals.lock().await.is_empty());

        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn declines_and_cancels_command_approvals() {
        let workspace = std::env::current_dir().expect("workspace");
        let workspace_text = workspace.to_string_lossy().into_owned();
        for (decision, expected) in [
            (ApprovalDecision::Decline, "approval_declined"),
            (ApprovalDecision::Cancel, "cancelled"),
        ] {
            let (output, mut messages) = mpsc::channel(8);
            let flow = Arc::new(FlowController::new(format!("request-{expected}"), output));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let cancellation = CancellationToken::new();
            let task_flow = Arc::clone(&flow);
            let task_approvals = Arc::clone(&approvals);
            let task_sessions = Arc::clone(&sessions);
            let task_cancellation = cancellation.clone();
            let request_id = format!("request-{expected}");
            let request = tokio::spawn({
                let request_id = request_id.clone();
                let workspace_text = workspace_text.clone();
                let workspace = workspace.clone();
                async move {
                    tools_execute(
                        &request_id,
                        json!({
                            "tool": "shell_command",
                            "authorization": "require_approval",
                            "command": "printf fixture",
                            "workdir": workspace_text,
                            "workspaceRoots": [workspace],
                            "timeoutMs": 1_000,
                        }),
                        &task_flow,
                        &task_cancellation,
                        &task_flow.output,
                        &task_approvals,
                        &task_sessions,
                    )
                    .await
                }
            });
            assert!(matches!(
                messages.recv().await,
                Some(ServerMessage::ApprovalRequest { .. })
            ));
            resolve_only_pending_approval(&approvals, decision).await;
            let result = request.await.expect("join");
            match expected {
                "approval_declined" => {
                    let err = match result {
                        Err(RequestFailure::Bridge(error)) => error,
                        other => panic!("expected decline, got {other:?}"),
                    };
                    assert_eq!(err.code, "approval_declined");
                }
                "cancelled" => assert!(matches!(result, Err(RequestFailure::Cancelled))),
                _ => unreachable!(),
            }
        }
    }

    #[tokio::test]
    async fn truncates_shell_output_to_max_output_tokens() {
        let workspace = std::env::current_dir().expect("workspace");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-truncate".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let command = if cfg!(windows) {
            "Write-Output ('x' * 200)"
        } else {
            "printf '%s' \"$(printf 'x%.0s' {1..200})\""
        };
        let request = tokio::spawn(async move {
            tools_execute(
                "request-truncate",
                json!({
                    "tool": "shell_command",
                    "authorization": "require_approval",
                    "command": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace],
                    "timeoutMs": 10_000,
                    "max_output_tokens": 2,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("join")
            .expect("command should complete");
        let text = result.result["output"].as_str().unwrap_or_default();
        assert!(text.contains("Warning: truncated output") || result.result["truncated"] == true);
        assert!(result.result.get("original_token_count").is_some());
    }

    #[tokio::test]
    async fn request_cancel_terminates_process_tree_and_returns_aborted() {
        let workspace = std::env::current_dir().expect("workspace");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-cancel-process".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let started = Instant::now();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-cancel-process",
                json!({
                    "tool": "shell_command",
                    "authorization": "require_approval",
                    "command": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace],
                    "timeoutMs": 60_000,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        // Let the process start, then cancel the in-flight request token.
        tokio::time::sleep(Duration::from_millis(150)).await;
        cancellation.cancel();
        let result = request.await.expect("join");
        assert!(matches!(result, Err(RequestFailure::Cancelled)));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "request cancel must terminate the process tree promptly"
        );
        assert!(
            approvals.lock().await.is_empty(),
            "approval map must be empty after cancel"
        );
        assert!(
            sessions.entries.lock().await.is_empty(),
            "cancelled shell_command must not retain a session"
        );
    }

    #[tokio::test]
    async fn cancel_during_approval_cleans_map_and_does_not_mutate_patch() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-patch-cancel-before-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let target = workspace.join("fixture.txt");
        tokio::fs::write(&target, "before\n")
            .await
            .expect("fixture file should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-patch-cancel-before".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_workspace_root = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-patch-cancel-before",
                json!({
                    "tool": "apply_patch",
                    "authorization": "require_approval",
                    "input": "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** End Patch",
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace_root],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        assert!(
            !approvals.lock().await.is_empty(),
            "cancelled approval should be registered"
        );
        cancellation.cancel();
        let result = request.await.expect("join");
        assert!(matches!(result, Err(RequestFailure::Cancelled)));
        assert!(
            approvals.lock().await.is_empty(),
            "cancel during approval must remove the map entry"
        );
        assert_eq!(
            tokio::fs::read_to_string(&target)
                .await
                .expect("fixture should remain readable"),
            "before\n"
        );
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn apply_patch_after_commit_waits_for_actual_outcome_despite_cancel() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-patch-cancel-after-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        tokio::fs::write(workspace.join("fixture.txt"), "before\n")
            .await
            .expect("fixture file should be written");
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-patch-cancel-after".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_workspace_root = workspace.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-patch-cancel-after",
                json!({
                    "tool": "apply_patch",
                    "authorization": "require_approval",
                    "input": "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** End Patch",
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace_root],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        // Cancel only after the approval decision so the apply can cross the
        // commit point. Once the blocking apply begins, the request must report
        // the real outcome rather than aborted-with-mutation.
        tokio::task::yield_now().await;
        cancellation.cancel();
        let result = request.await.expect("join");
        let mutated = tokio::fs::read_to_string(workspace.join("fixture.txt"))
            .await
            .expect("fixture should remain readable")
            == "after\n";
        match result {
            Ok(success) => {
                assert!(
                    mutated,
                    "completed apply_patch must have mutated the workspace"
                );
                assert_eq!(success.status, TerminalStatus::Completed);
            }
            Err(RequestFailure::Cancelled) => {
                assert!(
                    !mutated,
                    "aborted apply_patch must not claim cancel after mutation"
                );
            }
            other => panic!("unexpected apply_patch cancel race outcome: {other:?}"),
        }
        assert!(approvals.lock().await.is_empty());
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn late_approval_decision_after_cancel_completes_as_expired_noop() {
        let (output_tx, _output_rx) = mpsc::channel(8);
        let mut state = ConnectionState::new(
            output_tx,
            BuildIdentity {
                target: "x86_64-unknown-linux-musl".to_owned(),
                source_commit: "development".to_owned(),
            },
        );
        // No active approval map entry: simulates cancel cleanup that already ran.
        state
            .resolve_approval(
                "decision-late".to_owned(),
                "approval-expired".to_owned(),
                ApprovalDecision::AllowOnce,
            )
            .await
            .expect("late approval must not fail the connection");
        assert!(state.approvals.lock().await.is_empty());
    }

    #[tokio::test]
    async fn approvals_use_unique_server_generated_ids() {
        let (output, mut messages) = mpsc::channel(4);
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let first_approvals = Arc::clone(&approvals);
        let first_output = output.clone();
        let first = tokio::spawn(async move {
            await_approval(
                "x",
                ApprovalOperation::Command,
                "first".to_owned(),
                json!({}),
                "declined",
                &first_output,
                &first_approvals,
                &CancellationToken::new(),
            )
            .await
        });
        let second_approvals = Arc::clone(&approvals);
        let second = tokio::spawn(async move {
            await_approval(
                "x:network",
                ApprovalOperation::Network,
                "second".to_owned(),
                json!({}),
                "declined",
                &output,
                &second_approvals,
                &CancellationToken::new(),
            )
            .await
        });

        let mut ids = Vec::new();
        for _ in 0..2 {
            let ServerMessage::ApprovalRequest { approval, .. } =
                messages.recv().await.expect("approval should be emitted")
            else {
                panic!("expected approval request");
            };
            assert!(approval.approval_id.starts_with("approval-"));
            ids.push(approval.approval_id);
        }
        assert_ne!(ids[0], ids[1]);
        assert!(!ids.iter().any(|id| id == "x" || id == "x:network"));
        for id in ids {
            approvals
                .lock()
                .await
                .remove(&id)
                .expect("approval should be registered")
                .send(ApprovalDecision::AllowOnce)
                .expect("approval waiter should be active");
        }
        first
            .await
            .expect("first approval task should join")
            .expect("first approval should complete");
        second
            .await
            .expect("second approval task should join")
            .expect("second approval should complete");
    }

    #[test]
    fn bounds_aggregate_referenced_image_memory() {
        let mut raw = 0_u64;
        assert!(reserve_reference_bytes(&mut raw, MAX_IMAGE_REFERENCE_BYTES));
        assert!(!reserve_reference_bytes(&mut raw, 1));

        let mut encoded = 0_usize;
        assert!(reserve_reference_data_url_bytes(
            &mut encoded,
            MAX_IMAGE_REFERENCE_DATA_URL_BYTES
        ));
        assert!(!reserve_reference_data_url_bytes(&mut encoded, 1));
    }

    #[tokio::test]
    async fn cancellation_interrupts_external_awaits() {
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            await_with_cancellation(&task_cancellation, std::future::pending::<()>()).await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        assert!(matches!(
            task.await.expect("cancellable task should join"),
            Err(RequestFailure::Cancelled)
        ));
    }

    #[tokio::test]
    async fn shutdown_aborts_requests_that_ignore_cancellation() {
        let (output, _messages) = mpsc::channel(1);
        let mut state = ConnectionState::new(
            output,
            BuildIdentity {
                target: "fixture-target".to_owned(),
                source_commit: "development".to_owned(),
            },
        );
        state.requests.spawn(async {
            std::future::pending::<()>().await;
            "never".to_owned()
        });
        let started = Instant::now();
        state.cancel_and_join_requests().await;
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(state.requests.is_empty());
    }

    #[tokio::test]
    async fn image_generation_decline_and_cancel_prevent_server_contact() {
        for (decision, expected) in [
            (ApprovalDecision::Decline, "approval_declined"),
            (ApprovalDecision::Cancel, "cancelled"),
        ] {
            let (base_url, hits, server) = spawn_counting_fixture_http_server().await;
            let workspace = std::env::current_dir().expect("fixture workdir should resolve");
            let (output, mut messages) = mpsc::channel(8);
            let request_id = format!("request-imagegen-{expected}");
            let flow = Arc::new(FlowController::new(request_id.clone(), output));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let cancellation = CancellationToken::new();
            let task_flow = Arc::clone(&flow);
            let task_approvals = Arc::clone(&approvals);
            let task_sessions = Arc::clone(&sessions);
            let task_cancellation = cancellation.clone();
            let task_workspace = workspace.clone();
            let task_request_id = request_id.clone();
            let request = tokio::spawn(async move {
                tools_execute(
                    &task_request_id,
                    json!({
                        "tool": "image_gen.imagegen",
                        "authorization": "require_approval",
                        "prompt": "fixture image",
                        "workdir": task_workspace,
                        "workspaceRoots": [task_workspace],
                        "connection": fixture_connection(base_url),
                    }),
                    &task_flow,
                    &task_cancellation,
                    &task_flow.output,
                    &task_approvals,
                    &task_sessions,
                )
                .await
            });
            let approval = messages
                .recv()
                .await
                .expect("network approval should be emitted");
            assert!(matches!(
                approval,
                ServerMessage::ApprovalRequest {
                    approval: ApprovalRequest {
                        operation: ApprovalOperation::Network,
                        ..
                    },
                    ..
                }
            ));
            resolve_only_pending_approval(&approvals, decision).await;
            let result = request.await.expect("image generation task should join");
            match expected {
                "approval_declined" => {
                    let err = match result {
                        Err(RequestFailure::Bridge(error)) => error,
                        other => panic!("expected decline, got {other:?}"),
                    };
                    assert_eq!(err.code, "approval_declined");
                }
                "cancelled" => assert!(matches!(result, Err(RequestFailure::Cancelled))),
                _ => unreachable!(),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(
                hits.load(Ordering::SeqCst),
                0,
                "declined or cancelled image generation must not contact the Images API"
            );
            server.abort();
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn image_generation_requires_filesystem_and_network_approvals_for_references() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-imagegen-ref-{}",
            std::process::id()
        ));
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let image_path = workspace.join("nested").join("fixture.png");
        tokio::fs::create_dir_all(image_path.parent().expect("parent"))
            .await
            .expect("nested directory should be created");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");
        let (base_url, hits, server) = spawn_counting_fixture_http_server().await;
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-imagegen-ref".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_image = image_path.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-imagegen-ref",
                json!({
                    "tool": "image_gen.imagegen",
                    "authorization": "require_approval",
                    "prompt": "fixture image",
                    "referencedImagePaths": [task_image],
                    "workdir": task_workspace,
                    "workspaceRoots": [task_workspace],
                    "connection": fixture_connection(base_url),
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let filesystem = messages
            .recv()
            .await
            .expect("filesystem approval should be emitted");
        match filesystem {
            ServerMessage::ApprovalRequest { approval, .. } => {
                assert_eq!(approval.operation, ApprovalOperation::Filesystem);
                let paths = approval.details["paths"]
                    .as_array()
                    .expect("paths detail should be present");
                assert_eq!(paths.len(), 1);
                let path = paths[0].as_str().expect("path detail should be a string");
                assert_eq!(path, "nested/fixture.png");
                assert!(!Path::new(path).is_absolute());
            }
            other => panic!("expected filesystem approval, got {other:?}"),
        }
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let network = messages
            .recv()
            .await
            .expect("network approval should be emitted");
        assert!(matches!(
            network,
            ServerMessage::ApprovalRequest {
                approval: ApprovalRequest {
                    operation: ApprovalOperation::Network,
                    ..
                },
                ..
            }
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::Decline).await;
        let result = request.await.expect("image generation task should join");
        let err = match result {
            Err(RequestFailure::Bridge(error)) => error,
            other => panic!("expected network decline, got {other:?}"),
        };
        assert_eq!(err.code, "approval_declined");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "filesystem-approved image generation must still not contact the server after network decline"
        );
        server.abort();
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn command_and_image_approvals_use_workspace_relative_paths() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-approval-paths-{}",
            std::process::id()
        ));
        tokio::fs::create_dir_all(workspace.join("nested"))
            .await
            .expect("fixture directory should be created");
        let image_path = workspace.join("nested").join("fixture.png");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");

        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-relative-cmd".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let command = tokio::spawn(async move {
            tools_execute(
                "request-relative-cmd",
                json!({
                    "tool": "shell_command",
                    "authorization": "require_approval",
                    "command": "printf fixture",
                    "workdir": task_workspace.join("nested"),
                    "workspaceRoots": [task_workspace],
                    "timeoutMs": 1_000,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages
            .recv()
            .await
            .expect("command approval should be emitted");
        match approval {
            ServerMessage::ApprovalRequest { approval, .. } => {
                assert_eq!(approval.operation, ApprovalOperation::Command);
                let expected_shell = resolve_supported_shell(None).expect("default shell");
                assert_eq!(
                    approval.summary,
                    format!("{expected_shell}: printf fixture")
                );
                assert_eq!(approval.details["shell"], expected_shell);
                assert_eq!(approval.details["command"], "printf fixture");
                let workdir = approval.details["workdir"]
                    .as_str()
                    .expect("workdir detail should be present");
                assert_eq!(workdir, "nested");
                assert!(!Path::new(workdir).is_absolute());
            }
            other => panic!("expected command approval, got {other:?}"),
        }
        resolve_only_pending_approval(&approvals, ApprovalDecision::Decline).await;
        let _ = command.await.expect("command task should join");

        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-relative-image".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let task_image = image_path.clone();
        let image = tokio::spawn(async move {
            tools_execute(
                "request-relative-image",
                json!({
                    "tool": "view_image",
                    "authorization": "require_approval",
                    "path": task_image,
                    "detail": "original",
                    "workspaceRoots": [task_workspace],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages
            .recv()
            .await
            .expect("image approval should be emitted");
        match approval {
            ServerMessage::ApprovalRequest { approval, .. } => {
                assert_eq!(approval.operation, ApprovalOperation::Filesystem);
                let path = approval.details["path"]
                    .as_str()
                    .expect("path detail should be present");
                assert_eq!(path, "nested/fixture.png");
                assert!(!Path::new(path).is_absolute());
            }
            other => panic!("expected filesystem approval, got {other:?}"),
        }
        resolve_only_pending_approval(&approvals, ApprovalDecision::Decline).await;
        let _ = image.await.expect("image task should join");
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn empty_write_stdin_poll_does_not_request_approval() {
        let workspace = std::env::current_dir().expect("workspace");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-empty-poll-start".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let start = tokio::spawn(async move {
            tools_execute(
                "request-empty-poll-start",
                json!({
                    "tool": "exec_command",
                    "authorization": "require_approval",
                    "cmd": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace],
                    "tty": false,
                    "yield_time_ms": 250,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let initial = start.await.expect("join").expect("yield");
        let session_id = initial.result["session_id"].as_u64().expect("session id");

        let poll = tools_execute(
            "request-empty-poll",
            json!({
                "tool": "write_stdin",
                "authorization": "require_approval",
                "session_id": session_id,
                "chars": "",
                "yield_time_ms": 50,
            }),
            &flow,
            &cancellation,
            &flow.output,
            &approvals,
            &sessions,
        )
        .await
        .expect("empty poll should complete without approval");
        assert_eq!(poll.result["session_id"], session_id);
        assert!(
            messages.try_recv().is_err(),
            "empty write_stdin poll must not emit an approval request"
        );
        assert!(sessions.get(&session_id.to_string()).await.is_some());
        sessions
            .remove(session_id)
            .await
            .expect("session should still be active")
            .process
            .request_terminate();
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn write_stdin_decline_and_cancel_prevent_process_mutation() {
        for (label, decision, expected) in [
            ("decline", ApprovalDecision::Decline, "approval_declined"),
            ("cancel", ApprovalDecision::Cancel, "cancelled"),
        ] {
            let workspace = std::env::temp_dir().join(format!(
                "pi-codex-adaptor-write-stdin-{label}-{}",
                std::process::id()
            ));
            let _ = tokio::fs::remove_dir_all(&workspace).await;
            tokio::fs::create_dir_all(&workspace)
                .await
                .expect("fixture directory should be created");
            let marker = workspace.join("marker.txt");
            let workspace_text = workspace.to_string_lossy().into_owned();
            let (output, mut messages) = mpsc::channel(8);
            let start_id = format!("request-write-{label}-start");
            let write_id = format!("request-write-{label}");
            let flow = Arc::new(FlowController::new(start_id.clone(), output));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let cancellation = CancellationToken::new();
            let command = if cfg!(windows) {
                "$line = [Console]::In.ReadLine(); Set-Content -Path marker.txt -Value $line -NoNewline"
            } else {
                "read line; printf '%s' \"$line\" > marker.txt"
            };
            let task_flow = Arc::clone(&flow);
            let task_approvals = Arc::clone(&approvals);
            let task_sessions = Arc::clone(&sessions);
            let task_cancellation = cancellation.clone();
            let task_workspace = workspace.clone();
            let task_start_id = start_id.clone();
            let start = tokio::spawn(async move {
                tools_execute(
                    &task_start_id,
                    json!({
                        "tool": "exec_command",
                        "authorization": "require_approval",
                        "cmd": command,
                        "workdir": workspace_text,
                        "workspaceRoots": [task_workspace],
                        "tty": false,
                        "yield_time_ms": 250,
                        "login": false,
                    }),
                    &task_flow,
                    &task_cancellation,
                    &task_flow.output,
                    &task_approvals,
                    &task_sessions,
                )
                .await
            });
            assert!(matches!(
                messages.recv().await,
                Some(ServerMessage::ApprovalRequest { .. })
            ));
            resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
            let initial = start.await.expect("join").expect("yield");
            let session_id = initial.result["session_id"].as_u64().expect("session id");

            let secret = format!("SECRET_SESSION_INPUT_{}", label.to_ascii_uppercase());
            let write_flow = Arc::clone(&flow);
            let write_approvals = Arc::clone(&approvals);
            let write_sessions = Arc::clone(&sessions);
            let write_cancellation = cancellation.clone();
            let task_write_id = write_id.clone();
            let task_secret = secret.clone();
            let write = tokio::spawn(async move {
                tools_execute(
                    &task_write_id,
                    json!({
                        "tool": "write_stdin",
                        "authorization": "require_approval",
                        "session_id": session_id,
                        "chars": format!("{task_secret}\n"),
                        "yield_time_ms": 5_000,
                    }),
                    &write_flow,
                    &write_cancellation,
                    &write_flow.output,
                    &write_approvals,
                    &write_sessions,
                )
                .await
            });
            let approval = messages
                .recv()
                .await
                .expect("write_stdin approval should be emitted before mutation");
            match approval {
                ServerMessage::ApprovalRequest { approval, .. } => {
                    assert_eq!(approval.operation, ApprovalOperation::Command);
                    assert_eq!(approval.details["sessionId"], json!(session_id.to_string()));
                    assert_eq!(
                        approval.details["inputPreview"],
                        json!(format!("{secret}\\n"))
                    );
                    assert_eq!(approval.summary, format!("{secret}\\n"));
                    assert_eq!(approval.details["inputTruncated"], false);
                }
                other => panic!("expected write_stdin approval, got {other:?}"),
            }
            assert!(
                !marker.exists(),
                "process must not receive stdin before approval"
            );

            resolve_only_pending_approval(&approvals, decision).await;
            let outcome = write.await.expect("join");
            match (expected, outcome) {
                ("approval_declined", Err(RequestFailure::Bridge(error))) => {
                    assert_eq!(error.code, "approval_declined");
                    assert!(
                        !error.message.contains(&secret),
                        "declined errors must not leak session input"
                    );
                }
                ("cancelled", Err(RequestFailure::Cancelled)) => {}
                (_, other) => panic!("unexpected {label} outcome: {other:?}"),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(
                !marker.exists(),
                "{label} write_stdin must not mutate the process"
            );
            assert!(sessions.get(&session_id.to_string()).await.is_some());
            sessions
                .remove(session_id)
                .await
                .expect("session should remain until explicit cleanup")
                .process
                .request_terminate();
            let _ = tokio::fs::remove_dir_all(workspace).await;
        }
    }

    #[test]
    fn bounds_session_input_preview_for_approval_display() {
        let long = "x".repeat(SESSION_INPUT_PREVIEW_MAX_CHARS + 32);
        let (preview, truncated) = bounded_session_input_preview(&long);
        assert!(truncated);
        assert!(preview.ends_with('…'));
        assert_eq!(preview.chars().count(), SESSION_INPUT_PREVIEW_MAX_CHARS + 1);
        let (escaped, _) = bounded_session_input_preview("a\nb\tc\u{1}");
        assert_eq!(escaped, "a\\nb\\tc\\u{1}");
    }

    #[tokio::test]
    async fn write_stdin_cancellation_terminates_and_removes_session() {
        let workspace = std::env::current_dir().expect("workspace");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-write-stdin-cancel".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-write-stdin-cancel",
                json!({
                    "tool": "exec_command",
                    "authorization": "require_approval",
                    "cmd": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace],
                    "tty": false,
                    "yield_time_ms": 250,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let initial = request.await.expect("join").expect("yield");
        let session_id = initial.result["session_id"].as_u64().expect("session id");
        assert!(sessions.get(&session_id.to_string()).await.is_some());

        let poll_cancellation = CancellationToken::new();
        let poll_flow = Arc::clone(&flow);
        let poll_approvals = Arc::clone(&approvals);
        let poll_sessions = Arc::clone(&sessions);
        let poll_token = poll_cancellation.clone();
        let poll = tokio::spawn(async move {
            tools_execute(
                "request-write-stdin-poll",
                json!({
                    "tool": "write_stdin",
                    "authorization": "require_approval",
                    "session_id": session_id,
                    "chars": "",
                    "yield_time_ms": 30_000,
                }),
                &poll_flow,
                &poll_token,
                &poll_flow.output,
                &poll_approvals,
                &poll_sessions,
            )
            .await
        });
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        poll_cancellation.cancel();
        let result = poll.await.expect("write_stdin task should join");
        assert!(matches!(result, Err(RequestFailure::Cancelled)));
        assert!(
            sessions.get(&session_id.to_string()).await.is_none(),
            "cancelled write_stdin must remove the session"
        );
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn session_write_requests_approval_before_process_mutation() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-session-write-approve-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let marker = workspace.join("marker.txt");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-session-write-start".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let command = if cfg!(windows) {
            "$line = [Console]::In.ReadLine(); Set-Content -Path marker.txt -Value $line -NoNewline"
        } else {
            "read line; printf '%s' \"$line\" > marker.txt"
        };
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workspace = workspace.clone();
        let start = tokio::spawn(async move {
            tools_execute(
                "request-session-write-start",
                json!({
                    "tool": "exec_command",
                    "authorization": "require_approval",
                    "cmd": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [task_workspace],
                    "tty": false,
                    "yield_time_ms": 250,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let initial = start.await.expect("join").expect("yield");
        let session_id = initial.result["session_id"]
            .as_u64()
            .expect("session id")
            .to_string();
        let (_, session) = sessions
            .get(&session_id)
            .await
            .expect("session should remain active");

        let secret = "SECRET_CONTROL_FRAME_INPUT";
        let write_approvals = Arc::clone(&approvals);
        let write_cancellation = CancellationToken::new();
        let write_output = flow.output.clone();
        let write = tokio::spawn({
            let session = Arc::clone(&session);
            let session_id = session_id.clone();
            async move {
                write_session_stdin(
                    "request-session-write",
                    &session_id,
                    NativeAuthorization::RequireApproval,
                    format!("{secret}\n"),
                    &session,
                    &write_output,
                    &write_approvals,
                    &write_cancellation,
                )
                .await
            }
        });
        let approval = messages
            .recv()
            .await
            .expect("session_write approval should be emitted before mutation");
        match approval {
            ServerMessage::ApprovalRequest { approval, .. } => {
                assert_eq!(approval.operation, ApprovalOperation::Command);
                assert_eq!(approval.details["sessionId"], json!(session_id));
                assert_eq!(
                    approval.details["inputPreview"],
                    json!(format!("{secret}\\n"))
                );
                assert_eq!(approval.summary, format!("{secret}\\n"));
                assert_eq!(approval.details["inputTruncated"], false);
            }
            other => panic!("expected session_write approval, got {other:?}"),
        }
        assert!(
            !marker.exists(),
            "process must not receive stdin before session_write approval"
        );
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = write
            .await
            .expect("join")
            .expect("session write should complete");
        assert_eq!(result["sessionId"], session_id);
        wait_for_file_contents(&marker, secret).await;
        sessions
            .remove(session_id.parse().expect("numeric session"))
            .await
            .expect("session cleanup")
            .process
            .request_terminate();
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn session_write_decline_and_cancel_prevent_process_mutation() {
        for (label, decision, expected) in [
            ("decline", ApprovalDecision::Decline, "approval_declined"),
            ("cancel", ApprovalDecision::Cancel, "cancelled"),
        ] {
            let workspace = std::env::temp_dir().join(format!(
                "pi-codex-adaptor-session-write-{label}-{}",
                std::process::id()
            ));
            let _ = tokio::fs::remove_dir_all(&workspace).await;
            tokio::fs::create_dir_all(&workspace)
                .await
                .expect("fixture directory should be created");
            let marker = workspace.join("marker.txt");
            let workspace_text = workspace.to_string_lossy().into_owned();
            let (output, mut messages) = mpsc::channel(8);
            let start_id = format!("request-session-write-{label}-start");
            let write_id = format!("request-session-write-{label}");
            let flow = Arc::new(FlowController::new(start_id.clone(), output));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let cancellation = CancellationToken::new();
            let command = if cfg!(windows) {
                "$line = [Console]::In.ReadLine(); Set-Content -Path marker.txt -Value $line -NoNewline"
            } else {
                "read line; printf '%s' \"$line\" > marker.txt"
            };
            let task_flow = Arc::clone(&flow);
            let task_approvals = Arc::clone(&approvals);
            let task_sessions = Arc::clone(&sessions);
            let task_cancellation = cancellation.clone();
            let task_workspace = workspace.clone();
            let task_start_id = start_id.clone();
            let start = tokio::spawn(async move {
                tools_execute(
                    &task_start_id,
                    json!({
                        "tool": "exec_command",
                        "authorization": "require_approval",
                        "cmd": command,
                        "workdir": workspace_text,
                        "workspaceRoots": [task_workspace],
                        "tty": false,
                        "yield_time_ms": 250,
                        "login": false,
                    }),
                    &task_flow,
                    &task_cancellation,
                    &task_flow.output,
                    &task_approvals,
                    &task_sessions,
                )
                .await
            });
            assert!(matches!(
                messages.recv().await,
                Some(ServerMessage::ApprovalRequest { .. })
            ));
            resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
            let initial = start.await.expect("join").expect("yield");
            let session_id = initial.result["session_id"]
                .as_u64()
                .expect("session id")
                .to_string();
            let (_, session) = sessions
                .get(&session_id)
                .await
                .expect("session should remain active");

            let secret = format!("SECRET_SESSION_WRITE_{}", label.to_ascii_uppercase());
            let write_approvals = Arc::clone(&approvals);
            let write_cancellation = CancellationToken::new();
            let write_output = flow.output.clone();
            let task_write_id = write_id.clone();
            let task_secret = secret.clone();
            let task_session_id = session_id.clone();
            let write = tokio::spawn(async move {
                write_session_stdin(
                    &task_write_id,
                    &task_session_id,
                    NativeAuthorization::RequireApproval,
                    format!("{task_secret}\n"),
                    &session,
                    &write_output,
                    &write_approvals,
                    &write_cancellation,
                )
                .await
            });
            let approval = messages
                .recv()
                .await
                .expect("session_write approval should be emitted before mutation");
            match approval {
                ServerMessage::ApprovalRequest { approval, .. } => {
                    assert_eq!(approval.operation, ApprovalOperation::Command);
                    assert_eq!(approval.details["sessionId"], json!(session_id));
                    assert_eq!(
                        approval.details["inputPreview"],
                        json!(format!("{secret}\\n"))
                    );
                }
                other => panic!("expected session_write approval, got {other:?}"),
            }
            assert!(
                !marker.exists(),
                "process must not receive stdin before session_write decision"
            );
            resolve_only_pending_approval(&approvals, decision).await;
            let outcome = write.await.expect("join");
            match (expected, outcome) {
                ("approval_declined", Err(RequestFailure::Bridge(error))) => {
                    assert_eq!(error.code, "approval_declined");
                    assert!(
                        !error.message.contains(&secret),
                        "declined errors must not leak session input"
                    );
                }
                ("cancelled", Err(RequestFailure::Cancelled)) => {}
                (_, other) => panic!("unexpected {label} outcome: {other:?}"),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(
                !marker.exists(),
                "{label} session_write must not mutate the process"
            );
            sessions
                .remove(session_id.parse().expect("numeric session"))
                .await
                .expect("session should remain until explicit cleanup")
                .process
                .request_terminate();
            let _ = tokio::fs::remove_dir_all(workspace).await;
        }
    }

    #[tokio::test]
    async fn empty_session_write_does_not_request_approval() {
        let workspace = std::env::current_dir().expect("workspace");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-empty-session-write-start".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let start = tokio::spawn(async move {
            tools_execute(
                "request-empty-session-write-start",
                json!({
                    "tool": "exec_command",
                    "authorization": "require_approval",
                    "cmd": command,
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace],
                    "tty": false,
                    "yield_time_ms": 250,
                    "login": false,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let initial = start.await.expect("join").expect("yield");
        let session_id = initial.result["session_id"]
            .as_u64()
            .expect("session id")
            .to_string();
        let (_, session) = sessions
            .get(&session_id)
            .await
            .expect("session should remain active");
        let result = write_session_stdin(
            "request-empty-session-write",
            &session_id,
            NativeAuthorization::RequireApproval,
            String::new(),
            &session,
            &flow.output,
            &approvals,
            &cancellation,
        )
        .await
        .expect("empty session write should complete without approval");
        assert_eq!(result["sessionId"], session_id);
        assert!(
            messages.try_recv().is_err(),
            "empty session_write must not emit an approval request"
        );
        sessions
            .remove(session_id.parse().expect("numeric session"))
            .await
            .expect("session cleanup")
            .process
            .request_terminate();
    }

    #[tokio::test]
    async fn rejects_workspace_relative_and_tmp_shell_executables() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-malicious-shell-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("fixture directory should be created");
        let workspace_bash = workspace.join("bash");
        tokio::fs::write(&workspace_bash, b"#!/bin/sh\necho compromised\n")
            .await
            .expect("workspace bash decoy should be written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&workspace_bash)
                .expect("metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&workspace_bash, permissions).expect("chmod");
        }
        let tmp_bash =
            std::env::temp_dir().join(format!("pi-codex-adaptor-tmp-bash-{}", std::process::id()));
        tokio::fs::write(&tmp_bash, b"#!/bin/sh\necho compromised\n")
            .await
            .expect("tmp bash decoy should be written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&tmp_bash)
                .expect("metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&tmp_bash, permissions).expect("chmod");
        }

        for program in [
            "./bash".to_owned(),
            workspace_bash.to_string_lossy().into_owned(),
            tmp_bash.to_string_lossy().into_owned(),
            "/tmp/bash".to_owned(),
        ] {
            let err = resolve_supported_shell(Some(program.clone()))
                .expect_err("malicious shell paths must be rejected");
            assert_eq!(err.code, "unsupported_shell", "{program}");
        }

        let real = resolve_supported_shell(Some("bash".to_owned()))
            .or_else(|_| resolve_supported_shell(Some("sh".to_owned())))
            .expect("a real host shell should resolve");
        assert!(Path::new(&real).is_absolute());
        assert!(resolve_host_shell_program(&real).is_ok());

        let _ = tokio::fs::remove_file(tmp_bash).await;
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[test]
    #[cfg(not(windows))]
    fn shell_resolution_uses_only_fixed_system_directories() {
        assert_eq!(
            trusted_shell_directories(),
            ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
                .into_iter()
                .map(PathBuf::from)
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn view_image_resolves_relative_paths_against_tool_workdir_not_bridge_cwd() {
        let bridge_cwd = std::env::current_dir().expect("bridge cwd");
        let tool_workdir = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-view-image-workdir-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&tool_workdir).await;
        tokio::fs::create_dir_all(&tool_workdir)
            .await
            .expect("tool workdir should be created");
        let image_path = tool_workdir.join("fixture.png");
        tokio::fs::write(&image_path, FIXTURE_PNG)
            .await
            .expect("fixture image should be written");
        // A same-named file under bridge CWD must not be selected for relative paths.
        let cwd_decoy = bridge_cwd.join(format!(
            "pi-codex-adaptor-view-image-cwd-decoy-{}.png",
            std::process::id()
        ));
        let _ = tokio::fs::remove_file(&cwd_decoy).await;

        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-relative-view-image".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let task_workdir = tool_workdir.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-relative-view-image",
                json!({
                    "tool": "view_image",
                    "authorization": "require_approval",
                    "path": "fixture.png",
                    "detail": "original",
                    "workdir": task_workdir,
                    "workspaceRoots": [task_workdir],
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages
            .recv()
            .await
            .expect("image approval should be emitted");
        match approval {
            ServerMessage::ApprovalRequest { approval, .. } => {
                assert_eq!(approval.operation, ApprovalOperation::Filesystem);
                assert_eq!(approval.details["path"], "fixture.png");
            }
            other => panic!("expected filesystem approval, got {other:?}"),
        }
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowOnce).await;
        let result = request
            .await
            .expect("join")
            .expect("relative view_image should resolve against tool workdir");
        assert_eq!(result.result["detail"], "original");
        assert!(
            result.result["image_url"]
                .as_str()
                .unwrap_or_default()
                .starts_with("data:image/")
        );
        let _ = tokio::fs::remove_dir_all(tool_workdir).await;
    }

    #[tokio::test]
    async fn view_image_rejects_workspace_escape_for_relative_and_absolute_paths() {
        let workspace = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-view-image-escape-{}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "pi-codex-adaptor-view-image-outside-{}",
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        let _ = tokio::fs::remove_dir_all(&outside).await;
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("workspace should be created");
        tokio::fs::create_dir_all(&outside)
            .await
            .expect("outside dir should be created");
        let outside_image = outside.join("secret.png");
        tokio::fs::write(&outside_image, FIXTURE_PNG)
            .await
            .expect("outside image should be written");

        for (label, path) in [
            (
                "relative-escape",
                format!(
                    "../{}/secret.png",
                    outside.file_name().unwrap().to_string_lossy()
                ),
            ),
            (
                "absolute-escape",
                outside_image.to_string_lossy().into_owned(),
            ),
        ] {
            let (output, mut messages) = mpsc::channel(8);
            let flow = Arc::new(FlowController::new(
                format!("request-view-escape-{label}"),
                output,
            ));
            let approvals = Arc::new(Mutex::new(HashMap::new()));
            let sessions = Arc::new(NativeSessions::default());
            let cancellation = CancellationToken::new();
            let result = tools_execute(
                &format!("request-view-escape-{label}"),
                json!({
                    "tool": "view_image",
                    "authorization": "require_approval",
                    "path": path,
                    "detail": "high",
                    "workdir": workspace,
                    "workspaceRoots": [workspace],
                }),
                &flow,
                &cancellation,
                &flow.output,
                &approvals,
                &sessions,
            )
            .await;
            assert!(
                messages.try_recv().is_err(),
                "{label} must reject before approval"
            );
            let err = match result {
                Err(RequestFailure::Bridge(error)) => error,
                other => panic!("expected workspace escape for {label}, got {other:?}"),
            };
            assert_eq!(err.code, "workspace_escape", "{label}");
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(outside).await;
    }

    fn fixture_connection(base_url: String) -> ProviderConnection {
        ProviderConnection {
            provider_id: "fixture-provider".to_owned(),
            base_url,
            headers: std::collections::BTreeMap::new(),
            authentication: bridge_protocol::ProviderAuthentication::Bearer {
                token: "not-a-credential".to_owned(),
            },
            account_id: None,
            max_retries: Some(0),
            timeout_ms: Some(10_000),
            websocket_connect_timeout_ms: Some(10_000),
        }
    }

    fn fixture_response_request() -> Value {
        json!({
            "model": "fixture-model",
            "instructions": "",
            "input": [],
            "tools": null,
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "reasoning": null,
            "store": false,
            "stream": true,
            "include": [],
        })
    }

    fn fixture_model(shell_type: &str, use_responses_lite: bool) -> ModelInfo {
        serde_json::from_value(json!({
            "slug": "fixture-model",
            "display_name": "Fixture model",
            "description": null,
            "default_reasoning_level": null,
            "supported_reasoning_levels": [],
            "shell_type": shell_type,
            "visibility": "list",
            "supported_in_api": true,
            "priority": 1,
            "availability_nux": null,
            "upgrade": null,
            "base_instructions": "",
            "supports_reasoning_summaries": false,
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": null,
            "truncation_policy": { "mode": "bytes", "limit": 10_000 },
            "supports_parallel_tool_calls": false,
            "experimental_supported_tools": [],
            "use_responses_lite": use_responses_lite,
        }))
        .expect("fixture model should use the official metadata schema")
    }

    #[allow(clippy::fn_params_excessive_bools)]
    fn complete_provider_contract(
        hosted_web_search: bool,
        namespace_tools: bool,
        images_api: bool,
        search_api: bool,
    ) -> Value {
        json!({
            "responsesSse": true,
            "responsesWebsocket": "official-only",
            "remoteCompactionV2": true,
            "compactEndpoint": true,
            "namespaceTools": namespace_tools,
            "imagesApi": images_api,
            "searchApi": search_api,
            "hostedWebSearch": hosted_web_search,
        })
    }

    async fn spawn_fixture_http_server(body: String) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture listener should bind");
        let address = listener
            .local_addr()
            .expect("fixture listener should have an address");
        let content_type = if body.starts_with("event:") {
            "text/event-stream"
        } else {
            "application/json"
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("fixture request should connect");
            let mut request = vec![0_u8; 16 * 1024];
            let length = stream
                .read(&mut request)
                .await
                .expect("fixture request should be readable");
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(request.starts_with("POST /v1/") || request.starts_with("GET /v1/"));
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("fixture response should be writable");
            stream
                .shutdown()
                .await
                .expect("fixture response should close");
        });
        (format!("http://{address}/v1"), server)
    }

    async fn spawn_capturing_fixture_http_server(
        body: String,
    ) -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture listener should bind");
        let address = listener
            .local_addr()
            .expect("fixture listener should have an address");
        let content_type = if body.starts_with("event:") {
            "text/event-stream"
        } else {
            "application/json"
        };
        let (sender, receiver) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("fixture request should connect");
            let mut request = vec![0_u8; 16 * 1024];
            let length = stream
                .read(&mut request)
                .await
                .expect("fixture request should be readable");
            let request = String::from_utf8(request[..length].to_vec())
                .expect("fixture request should be UTF-8");
            sender
                .send(request)
                .expect("fixture request should be captured");
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("fixture response should be writable");
            stream
                .shutdown()
                .await
                .expect("fixture response should close");
        });
        (format!("http://{address}/v1"), receiver, server)
    }

    fn fixture_header<'a>(request: &'a str, expected_name: &str) -> Option<&'a str> {
        request
            .split("\r\n")
            .take_while(|line| !line.is_empty())
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case(expected_name)
                    .then_some(value.trim())
            })
    }

    fn fixture_request_body(request: &str) -> Value {
        let (_, body) = request
            .split_once("\r\n\r\n")
            .expect("fixture request should have a body");
        serde_json::from_str(body).expect("fixture request body should be JSON")
    }

    async fn spawn_stalling_fixture_http_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("stalling fixture listener should bind");
        let address = listener
            .local_addr()
            .expect("stalling fixture listener should have an address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("stalling fixture request should connect");
            let mut request = vec![0_u8; 16 * 1024];
            let _ = stream
                .read(&mut request)
                .await
                .expect("stalling fixture request should be readable");
            std::future::pending::<()>().await;
        });
        (format!("http://{address}/v1"), server)
    }

    async fn spawn_counting_fixture_http_server()
    -> (String, Arc<AtomicU64>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("counting fixture listener should bind");
        let address = listener
            .local_addr()
            .expect("counting fixture listener should have an address");
        let hits = Arc::new(AtomicU64::new(0));
        let hit_counter = Arc::clone(&hits);
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                hit_counter.fetch_add(1, Ordering::SeqCst);
                let mut request = vec![0_u8; 16 * 1024];
                let _ = stream.read(&mut request).await;
                let response = b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                let _ = stream.write_all(response).await;
                let _ = stream.shutdown().await;
            }
        });
        (format!("http://{address}/v1"), hits, server)
    }

    async fn spawn_websocket_fallback_server() -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fallback listener should bind");
        let address = listener
            .local_addr()
            .expect("fallback listener should have an address");
        let (sender, receiver) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut websocket, _) = listener
                .accept()
                .await
                .expect("websocket probe should connect");
            let mut request = vec![0_u8; 16 * 1024];
            let length = websocket
                .read(&mut request)
                .await
                .expect("websocket probe should be readable");
            let websocket_request = String::from_utf8(request[..length].to_vec())
                .expect("websocket request should be UTF-8");
            assert!(websocket_request.starts_with("GET /v1/responses"));
            let _ = sender.send(websocket_request);
            websocket
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await
                .expect("websocket rejection should be writable");
            websocket
                .shutdown()
                .await
                .expect("websocket rejection should close");

            let body = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fallback-response\"}}\n\n",
            );
            let (mut sse, _) = listener
                .accept()
                .await
                .expect("SSE fallback should connect");
            let length = sse
                .read(&mut request)
                .await
                .expect("SSE request should be readable");
            assert!(String::from_utf8_lossy(&request[..length]).starts_with("POST /v1/responses"));
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sse.write_all(response.as_bytes())
                .await
                .expect("SSE fallback response should be writable");
            sse.shutdown()
                .await
                .expect("SSE fallback response should close");
        });
        (format!("http://{address}/v1"), receiver, server)
    }

    #[tokio::test]
    async fn advertises_approval_decisions_in_decline_cancel_allow_once_order() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new("request-order".to_owned(), output));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-order",
                json!({
                    "tool": "shell_command",
                    "authorization": "require_approval",
                    "command": "printf fixture",
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace.to_string_lossy()],
                    "timeoutMs": 10_000,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        let approval = messages.recv().await.expect("approval should be emitted");
        let ServerMessage::ApprovalRequest { approval, .. } = approval else {
            panic!("first message should be an approval request");
        };
        assert_eq!(
            approval.available_decisions,
            vec![
                ApprovalDecision::Decline,
                ApprovalDecision::Cancel,
                ApprovalDecision::AllowOnce,
            ]
        );
        assert!(
            !approval
                .available_decisions
                .contains(&ApprovalDecision::AllowSession)
        );
        cancellation.cancel();
        let result = request.await.expect("command task should join");
        assert!(matches!(result, Err(RequestFailure::Cancelled)));
    }

    #[tokio::test]
    async fn rejects_unadvertised_allow_session_instead_of_allowing() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (output, mut messages) = mpsc::channel(8);
        let flow = Arc::new(FlowController::new(
            "request-session-decision".to_owned(),
            output,
        ));
        let approvals = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(NativeSessions::default());
        let cancellation = CancellationToken::new();
        let task_flow = Arc::clone(&flow);
        let task_approvals = Arc::clone(&approvals);
        let task_sessions = Arc::clone(&sessions);
        let task_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            tools_execute(
                "request-session-decision",
                json!({
                    "tool": "shell_command",
                    "authorization": "require_approval",
                    "command": "printf fixture",
                    "workdir": workspace_text,
                    "workspaceRoots": [workspace.to_string_lossy()],
                    "timeoutMs": 10_000,
                }),
                &task_flow,
                &task_cancellation,
                &task_flow.output,
                &task_approvals,
                &task_sessions,
            )
            .await
        });
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::ApprovalRequest { .. })
        ));
        resolve_only_pending_approval(&approvals, ApprovalDecision::AllowSession).await;
        let failure = request
            .await
            .expect("command task should join")
            .expect_err("allow_session must not authorize execution");
        match failure {
            RequestFailure::Bridge(error) => {
                assert_eq!(error.code, "unadvertised_approval_decision");
            }
            other @ RequestFailure::Cancelled => {
                panic!("expected protocol rejection, got {other:?}")
            }
        }
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn rejects_allow_session_decision_frames_while_keeping_approval_pending() {
        let workspace = std::env::current_dir().expect("test workspace should resolve");
        let workspace_text = workspace.to_string_lossy().into_owned();
        let (mut input_client, input_server) = tokio::io::duplex(MAX_FRAME_BYTES + 2);
        let (output_server, mut output_client) = tokio::io::duplex(MAX_FRAME_BYTES + 2);
        let server = tokio::spawn(serve(
            tokio::io::BufReader::new(input_server),
            output_server,
            BuildIdentity {
                target: "x86_64-unknown-linux-musl".to_owned(),
                source_commit: "development".to_owned(),
            },
        ));

        let execute = serde_json::to_string(&json!({
            "type": "request",
            "requestId": "request-1",
            "method": "tools.execute",
            "params": {
                "tool": "shell_command",
                "authorization": "require_approval",
                "command": "printf fixture",
                "workdir": workspace_text,
                "workspaceRoots": [workspace.to_string_lossy()],
                "timeoutMs": 10_000,
            }
        }))
        .expect("execute frame should serialize");
        input_client
            .write_all(format!("{}{execute}\n", initialization()).as_bytes())
            .await
            .expect("interactive input should write");

        let mut output = Vec::new();
        let mut buffer = [0_u8; 4096];
        let mut messages = Vec::new();
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(process_test_timeout_ms());
        while tokio::time::Instant::now() < deadline
            && !messages
                .iter()
                .any(|message| matches!(message, ServerMessage::ApprovalRequest { .. }))
        {
            let read =
                tokio::time::timeout(Duration::from_millis(250), output_client.read(&mut buffer))
                    .await;
            let Ok(Ok(count)) = read else {
                continue;
            };
            if count == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            messages = output
                .split_inclusive(|byte| *byte == b'\n')
                .filter_map(|frame| bridge_protocol::decode_server_frame(frame).ok())
                .collect();
        }
        assert!(
            messages
                .iter()
                .any(|message| matches!(message, ServerMessage::ApprovalRequest { .. })),
            "approval request should be emitted"
        );
        let approval_id = messages
            .iter()
            .find_map(|message| match message {
                ServerMessage::ApprovalRequest { approval, .. } => {
                    Some(approval.approval_id.clone())
                }
                _ => None,
            })
            .expect("approval id should be emitted");

        let allow_session = serde_json::to_string(&json!({
            "type": "approval_decision",
            "requestId": "decision-session",
            "approvalId": approval_id.clone(),
            "decision": "allow_session",
        }))
        .expect("allow_session decision should serialize");
        input_client
            .write_all(format!("{allow_session}\n").as_bytes())
            .await
            .expect("allow_session decision should write");

        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(process_test_timeout_ms());
        while tokio::time::Instant::now() < deadline
            && !messages.iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::Error { error, .. }
                        if error.code == "unadvertised_approval_decision"
                )
            })
        {
            let read =
                tokio::time::timeout(Duration::from_millis(250), output_client.read(&mut buffer))
                    .await;
            let Ok(Ok(count)) = read else {
                continue;
            };
            if count == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            messages = output
                .split_inclusive(|byte| *byte == b'\n')
                .filter_map(|frame| bridge_protocol::decode_server_frame(frame).ok())
                .collect();
        }
        assert!(
            messages.iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::Error { error, .. }
                        if error.code == "unadvertised_approval_decision"
                )
            }),
            "allow_session decision should be rejected"
        );

        let allow_once = serde_json::to_string(&json!({
            "type": "approval_decision",
            "requestId": "decision-allow",
            "approvalId": approval_id,
            "decision": "allow_once",
        }))
        .expect("allow_once decision should serialize");
        input_client
            .write_all(format!("{allow_once}\n").as_bytes())
            .await
            .expect("valid decision should write");

        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(process_test_timeout_ms());
        while tokio::time::Instant::now() < deadline
            && !(messages.iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::Result {
                        request_id,
                        status: TerminalStatus::Completed,
                        ..
                    } if request_id == "request-1"
                )
            }) && messages.iter().any(|message| {
                matches!(
                    message,
                    ServerMessage::Result {
                        request_id,
                        status: TerminalStatus::Completed,
                        ..
                    } if request_id == "decision-allow"
                )
            }))
        {
            let read =
                tokio::time::timeout(Duration::from_millis(250), output_client.read(&mut buffer))
                    .await;
            let Ok(Ok(count)) = read else {
                continue;
            };
            if count == 0 {
                break;
            }
            output.extend_from_slice(&buffer[..count]);
            messages = output
                .split_inclusive(|byte| *byte == b'\n')
                .filter_map(|frame| bridge_protocol::decode_server_frame(frame).ok())
                .collect();
        }

        input_client
            .write_all(
                br#"{"type":"shutdown","requestId":"shutdown-1"}
"#,
            )
            .await
            .expect("shutdown should write");
        input_client
            .shutdown()
            .await
            .expect("interactive input should close");
        let mut trailing = Vec::new();
        output_client
            .read_to_end(&mut trailing)
            .await
            .expect("interactive output should finish");
        output.extend_from_slice(&trailing);
        server
            .await
            .expect("server task should join")
            .expect("server should complete");

        messages = output
            .split_inclusive(|byte| *byte == b'\n')
            .filter_map(|frame| bridge_protocol::decode_server_frame(frame).ok())
            .collect();
        assert!(messages.iter().any(|message| matches!(
            message,
            ServerMessage::Result {
                request_id,
                status: TerminalStatus::Completed,
                ..
            } if request_id == "request-1"
        )));
        assert!(messages.iter().any(|message| matches!(
            message,
            ServerMessage::Result {
                request_id,
                status: TerminalStatus::Completed,
                ..
            } if request_id == "decision-allow"
        )));
    }

    #[tokio::test]
    async fn rejects_malformed_secret_bearing_frames_with_stable_safe_messages() {
        let secret = "fixture-secret-sentinel";
        let malformed = format!(
            "{{\"type\":\"initialize\",\"requestId\":\"init-1\",\"protocolVersion\":5,\"client\":{{\"name\":\"contract-test\",\"version\":\"0.0.0\"}},\"extra\":true,\"opaque\":\"{secret}\"}}\n"
        );
        let messages = run_server(&malformed).await;
        assert_eq!(messages.len(), 1);
        let ServerMessage::Error { request_id, error } = &messages[0] else {
            panic!("malformed secret-bearing frame should return a protocol error");
        };
        assert!(request_id.is_none());
        assert_eq!(error.code, "invalid_frame");
        assert_eq!(error.message, "bridge frame does not match protocol v5");
        assert!(!error.message.contains(secret));
        assert!(!error.message.contains("fixture-secret-sentinel"));
        assert!(!format!("{messages:?}").contains(secret));
    }

    #[tokio::test]
    async fn valid_initialize_and_shutdown_path_remains_unchanged() {
        let messages = run_server(&format!(
            "{}{shutdown}",
            initialization(),
            shutdown = "{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n"
        ))
        .await;
        assert_eq!(messages.len(), 2);
        assert!(matches!(messages[0], ServerMessage::Handshake { .. }));
        assert!(matches!(
            messages[1],
            ServerMessage::Result {
                status: TerminalStatus::Completed,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn requires_initialization_before_other_frames() {
        let messages = run_server("{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n").await;

        assert_eq!(messages.len(), 1);
        let ServerMessage::Error { error, .. } = &messages[0] else {
            panic!("missing initialization should return an error");
        };
        assert_eq!(error.code, "initialization_required");
    }

    #[tokio::test]
    async fn multiplexes_diagnostic_requests_by_id() {
        let messages = run_server(&format!(
            "{}{first}{second}{shutdown}",
            initialization(),
            first = "{\"type\":\"request\",\"requestId\":\"request-1\",\"method\":\"diagnostics.read\",\"params\":{}}\n",
            second = "{\"type\":\"request\",\"requestId\":\"request-2\",\"method\":\"diagnostics.read\",\"params\":{}}\n",
            shutdown = "{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n",
        ))
        .await;

        let result_ids = messages
            .iter()
            .filter_map(|message| match message {
                ServerMessage::Result { request_id, .. } => Some(request_id.as_str()),
                _ => None,
            })
            .collect::<HashSet<_>>();
        assert!(result_ids.contains("request-1"));
        assert!(result_ids.contains("request-2"));
        assert!(result_ids.contains("shutdown-1"));
    }

    #[tokio::test]
    async fn rejects_duplicate_request_ids() {
        let messages = run_server(&format!(
            "{}{first}{second}{shutdown}",
            initialization(),
            first = "{\"type\":\"request\",\"requestId\":\"request-1\",\"method\":\"diagnostics.read\",\"params\":{}}\n",
            second = "{\"type\":\"request\",\"requestId\":\"request-1\",\"method\":\"diagnostics.read\",\"params\":{}}\n",
            shutdown = "{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n",
        ))
        .await;

        assert!(messages.iter().any(|message| matches!(
            message,
            ServerMessage::Error { error, .. } if error.code == "duplicate_request_id"
        )));
    }

    #[tokio::test]
    async fn closes_a_connection_at_the_request_id_limit() {
        let (output, mut messages) = mpsc::channel(2);
        let mut state = ConnectionState::new(
            output,
            BuildIdentity {
                target: "fixture-target".to_owned(),
                source_commit: "development".to_owned(),
            },
        );
        state.initialized = true;
        state
            .seen_request_ids
            .extend((0..MAX_REQUEST_IDS_PER_CONNECTION).map(|index| format!("request-{index}")));

        let control = state
            .handle_message(ClientMessage::Shutdown {
                request_id: "one-too-many".to_owned(),
            })
            .await
            .expect("request limit should be handled");
        assert!(matches!(control, ConnectionControl::Stop(None)));
        assert!(matches!(
            messages.recv().await,
            Some(ServerMessage::Error { error, .. }) if error.code == "request_limit_exceeded"
        ));
        assert!(!state.seen_request_ids.contains("one-too-many"));
    }

    #[tokio::test]
    async fn rejects_invalid_request_ids_without_reflecting_them() {
        let invalid_id = "private-sentinel".repeat(20);
        let request = serde_json::to_string(&json!({
            "type": "request",
            "requestId": invalid_id,
            "method": "diagnostics.read",
            "params": {},
        }))
        .expect("test request should serialize");
        let input = format!(
            "{}{request}\n{shutdown}",
            initialization(),
            shutdown = "{\"type\":\"shutdown\",\"requestId\":\"shutdown-1\"}\n",
        );
        let messages = run_server(&input).await;

        let invalid_error = messages.iter().find_map(|message| match message {
            ServerMessage::Error { request_id, error } if error.code == "invalid_request_id" => {
                Some((request_id, error))
            }
            _ => None,
        });
        let Some((request_id, error)) = invalid_error else {
            panic!("invalid request id should return an error");
        };
        assert!(request_id.is_none());
        assert!(!error.message.contains("private-sentinel"));
    }

    #[tokio::test]
    async fn rejects_oversized_input_before_json_parsing() {
        let input = vec![b'x'; MAX_FRAME_BYTES + 3];
        let mut reader = tokio::io::BufReader::new(input.as_slice());

        assert!(matches!(
            read_frame(&mut reader).await,
            Err(ReadFrameError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn enforces_acknowledged_event_backpressure() {
        let (output, mut receiver) = mpsc::channel(512);
        let flow = Arc::new(FlowController::new("request-1".to_owned(), output));
        let cancellation = CancellationToken::new();

        for value in 0..MAX_PENDING_EVENTS {
            flow.emit(json!({ "value": value }), &cancellation)
                .await
                .expect("events within capacity should emit");
        }
        let blocked_flow = Arc::clone(&flow);
        let blocked_cancellation = cancellation.clone();
        let blocked = tokio::spawn(async move {
            blocked_flow
                .emit(json!({ "value": "blocked" }), &blocked_cancellation)
                .await
        });

        for _ in 0..MAX_PENDING_EVENTS {
            assert!(matches!(
                receiver.recv().await,
                Some(ServerMessage::Event { .. })
            ));
        }
        assert!(matches!(
            receiver.recv().await,
            Some(ServerMessage::Backpressure {
                state: BackpressureState::Paused,
                ..
            })
        ));
        assert!(!blocked.is_finished());

        flow.acknowledge(1)
            .await
            .expect("valid acknowledgement should resume flow");
        assert!(matches!(
            receiver.recv().await,
            Some(ServerMessage::Backpressure {
                state: BackpressureState::Resumed,
                ..
            })
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(ServerMessage::Event { sequence: 257, .. })
        ));
        assert_eq!(
            blocked.await.expect("blocked event task should join").ok(),
            Some(257)
        );
    }

    #[tokio::test]
    async fn cancellation_unblocks_a_backpressured_event() {
        let (output, _receiver) = mpsc::channel(512);
        let flow = Arc::new(FlowController::new("request-1".to_owned(), output));
        let cancellation = CancellationToken::new();

        for value in 0..MAX_PENDING_EVENTS {
            flow.emit(json!({ "value": value }), &cancellation)
                .await
                .expect("events within capacity should emit");
        }
        let blocked_flow = Arc::clone(&flow);
        let blocked_cancellation = cancellation.clone();
        let blocked = tokio::spawn(async move {
            blocked_flow
                .emit(json!({ "value": "blocked" }), &blocked_cancellation)
                .await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();

        assert!(matches!(
            blocked.await.expect("blocked event task should join"),
            Err(EmitError::Cancelled)
        ));
    }
}

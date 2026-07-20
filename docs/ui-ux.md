# Terminal UI Contract

`/codex` opens a short-lived settings overlay. It is not a dashboard. The overlay has four sections:
General, Tools, OpenAI, and Diagnostics. Tool progress and results remain inline in Pi's conversation.

At 100 columns or more, navigation and settings use two columns. From 60 through 99 columns, sections
become a top tab row over a single settings column. Below 60 columns, section selection and content
use separate screens. Resize preserves the section, focus, scroll position, and draft.

Settings are edited as a draft and saved as one validated transaction. `Ctrl+S` validates and writes
atomically. Leaving with unsaved changes offers Continue editing, Discard changes, and Save, with
Continue editing selected by default. `R` opens an explicit reset-to-defaults confirmation with Cancel
selected by default. Unsupported capability-dependent settings include a textual reason; color is never
the only state signal.

The overlay resolves the current effective capability snapshot before rendering. Background sessions
are editable on bundled shell-command models and report the supplemental surface in status and
diagnostics. When auto compact limit is stored as `model`, the row displays the official resolved
numeric threshold without replacing the stored sentinel. Save resolves and validates the candidate
snapshot before persistence, and the same cached snapshot drives the subsequent active-tool refresh.

Provider and model selection changes switch the active tool profile and rebuild the corresponding
prompt/tool status. Codex core isolation and reversible Pi restoration are lifecycle behavior, not a
new user setting.

The OpenAI section's manual compaction action is manual Pi compaction. It uses a fixed shim summary
that states the provider performed compaction and keeps the returned version `2` opaque details for
provider-bound replay. The UI never attempts to decrypt, summarize, or display the encrypted content.
Inline automatic compaction is silent at the UI layer: it continues the current provider request,
adds no synthetic message or continuation turn, and persists only a hidden opaque `CustomEntry`.

The Tools category includes an `Approval policy` enum with `prompt` and `bypass`. Prompt is the safe
default. Cycling from prompt to bypass opens a confirmation with Cancel focused by default. The
confirmation states that native commands run with the user's permissions and that workspace roots do
not sandbox shell behavior. Cancel leaves the draft unchanged; enabling bypass marks the draft dirty
and emits one warning. Switching back to prompt needs no confirmation. A saved bypass policy adds
`!bypass` to the compact adaptor status only when status output is enabled, and emits one warning at
session startup. The status starts with `Codex`, then includes only active `exec` or `sh`, `bg` or
`bg+`, and `web` surfaces; disabled, unavailable, and unsupported surfaces are omitted. Direct valid
file configuration is supported, including headless sessions; bypass does not create per-tool-call
notifications.

Approval prompts owned by the terminal UI default to Decline, then Cancel, then Allow once. Headless
prompt mode does not open an overlay, animate, or wait for input and is never inferred to mean bypass.
Diagnostics have a stable plain text or machine-readable form and exclude user content and secrets.
Overlay disposal aborts in-flight UI tasks and ignores late updates.

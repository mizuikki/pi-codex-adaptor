# Terminal UI Contract

`/codex` opens a short-lived settings overlay. It is not a dashboard. The overlay has four sections:
General, Tools, OpenAI, and Diagnostics. Tool progress and results remain inline in Pi's conversation.

At 100 columns or more, navigation and settings use two columns. From 60 through 99 columns, sections
become a top tab row over a single settings column. Below 60 columns, section selection and content
use separate screens. Resize preserves the section, focus, scroll position, and draft.

When a setting opens a Pi-owned confirmation or text-input dialog, the settings overlay temporarily
hides so the host editor control remains visible. After submission or cancellation, the same live
overlay is restored and focused with its draft and navigation state intact. Disposing the overlay
aborts the dialog handoff and does not restore it.

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
Manual compaction keeps Pi's existing compaction-summary presentation.

Inline automatic compaction remains silent in the live provider flow: it continues the current
provider request and adds no synthetic conversational message or continuation turn. The durable
checkpoint is still a hidden opaque `CustomEntry`. When Pi renders that custom entry, the adaptor
projects exactly one information row:

```text
• Context compacted
```

Only the leading `•` is dimmed; the message uses normal transcript styling. The row has no tool
gutter, lifecycle state, expansion, token count, checkpoint identifier, or opaque content.

Managed Codex tools render as compact unframed transcript rows owned by
`src/ui/terminal/codex-tool-renderer.ts`. Each row uses the renderer-owned single-column glyphs `•`,
`│`, and `└`, with explicit English state words for running, completed, failed, timed-out, and
aborted outcomes. `context.isError` forces a textual failure label even when `details.status` is
absent. Collapsed command output shows at most five logical lines plus an ASCII
`... N lines omitted` row; Pi's existing tool expansion action reveals the complete native-bounded
output. Headers clip and detail lines wrap to the current terminal width so gutters stay aligned.
After execution starts, the result slot owns the single lifecycle header so live stacking and HTML
export never show both `Running` and `Ran` for one tool call. The UI never displays raw patch input,
image-generation prompts or revised prompts, raw web responses, credentials, or arbitrary argument
objects. Final command rows prefer `details.output` so model-visible JSON metadata suffixes stay out
of the human transcript while model-facing tool content remains unchanged.

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

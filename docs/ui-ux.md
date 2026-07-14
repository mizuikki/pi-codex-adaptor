# Terminal UI Contract

`/codex` opens a short-lived settings overlay. It is not a dashboard. The overlay has four sections:
General, Tools, OpenAI, and Diagnostics. Tool progress and results remain inline in Pi's conversation.

At 100 columns or more, navigation and settings use two columns. From 60 through 99 columns, sections
become a top tab row over a single settings column. Below 60 columns, section selection and content
use separate screens. Resize preserves the section, focus, scroll position, and draft.

Settings are edited as a draft and saved as one validated transaction. `Ctrl+S` validates and writes
atomically. Leaving with unsaved changes offers Continue editing, Discard changes, and Save, with
Continue editing selected by default. Unsupported capability-dependent settings include a textual
reason; color is never the only state signal.

Headless mode does not open an overlay, animate, or wait for input. Diagnostics have a stable plain
text or machine-readable form and exclude user content and secrets.

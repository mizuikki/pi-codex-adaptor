# ADR 0010: Responsive Terminal Experience

- Status: Accepted
- Date: 2026-07-14

## Context

Configuration is a short-lived workflow, while tool progress belongs to the active Pi conversation.
The interface must remain usable across wide, narrow, monochrome, and headless terminals.

## Decision

Use `/codex` for one responsive settings overlay with General, Tools, OpenAI, and Diagnostics sections.
Use two-column, tabbed single-column, or section-detail layouts based on available width. Keep tool
approvals, execution state, plan updates, and results inline in Pi's conversation.

Edit settings as a draft and save them as one validated atomic transaction. Use textual state labels in
addition to theme colors. Headless mode returns stable plain text or machine-readable diagnostics and
never waits for interactive input.

## Consequences

- The product has no persistent dashboard or separate live-session viewport.
- Resize, focus, scroll, async cleanup, disabled reasons, and error states require UI tests.
- Diagnostics exclude credentials, prompts, messages, opaque compaction items, and absolute user paths.

# Terminal UI

The `/codex` settings overlay, pure application view models, and UI-owned approval helpers live here.

## Layouts

| Width | Layout |
| --- | --- |
| `>= 100` | Wide two-column navigation and settings list with focused-item description |
| `60-99` | Medium top category tabs over a single settings column |
| `< 60` | Narrow two-step flow: category picker, then one section |

Resize preserves category, focus, draft, and dialog state. Rendering stays monochrome-safe: no ANSI
color codes, textual status labels such as `[modified]`, `[ok]`, `[error]`, and `[disabled]`.

## Keyboard

Contextual shortcuts appear in the footer. Full help opens with `?`.

- `Up`/`Down` or `j`/`k`: move
- `[`/`]` or Left/Right: switch category outside narrow detail
- `Tab`: switch wide layout region
- `Space`: toggle booleans
- `Enter`: activate enum, action, narrow section, or dialog choice
- `Ctrl+S`: validate and save the draft
- `R`: explicit reset-to-defaults confirmation (default focus Cancel)
- `Esc`: back, cancel dialog, dirty-close prompt, or close
- Dirty close defaults to Continue editing

## Approval

`approval-model.ts` keeps Decline focused by default and places Allow last so UI-owned approval
prompts never preselect a permissive choice. Session write approvals surface the session id and a
bounded input preview. `requestCodexApproval` races an optional request `AbortSignal` and disposes the overlay
fail-closed so a cancelled tool never sends a late decision. `ApprovalOverlay.dispose()` resolves fail-closed exactly once (cancel) so
teardown and input races cannot hang or double-resolve.

## Inline renderers

`codex-tool-renderer.ts` owns compact managed-tool presentation. Integration registration selects a
presentation kind; the renderer owns call/result composition so each tool call has one lifecycle
header. Args-only rows use `renderCall`; after execution starts, `renderResult` owns the running or
terminal header (including HTML export contexts that always call `renderCall` with `isPartial:
true`). Structural glyphs `•`, `│`, and `└` are renderer-owned constants styled through Pi theme
roles. Presentation is width-aware: headers are clipped and detail wraps stay under the gutter.
`context.isError` maps to textual failure labels. Omission text uses ASCII `...`.

`codex-compaction-entry.ts` is a separate entry renderer for persisted automatic checkpoints. It
projects the single information line `• Context compacted` and does not share managed-tool gutters,
lifecycle composition, or expansion behavior. Manual compaction presentation remains Pi-owned.

Rendering is monochrome-safe: state words distinguish outcomes without relying on color alone.

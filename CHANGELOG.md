# Changelog

## 0.1.5 — 2026-06-18

### Added
- Model switcher: dropdown in the stats bar to view available models and switch
  providers/models at runtime (`/api/models`, `/api/model`, `get_available_models`,
  `set_model` RPC)
- Session switcher: dropdown to list sessions discovered from jsonl files, switch
  to a different session, or create a new session (`/api/sessions`, `/api/session`,
  `/api/session/new`, `new_session` / `switch_session` RPC)
- Thinking level selector: dropdown to set the thinking/reasoning level from off
  to xhigh, with per-model capability detection (`/api/thinking-level`,
  `set_thinking_level` RPC)
- `server/src/sessions.ts`: jsonl-based session listing with first-message preview,
  message count, and cwd-scoped filtering
- New shared types: `PiSessionInfo`, `ModelSwitchRequest`, `SessionSwitchRequest`,
  `ThinkingLevelSwitchRequest`

### Changed
- `.gitignore`: added `AGENT.md` and `CLAUDE.md`

## 0.1.4 — 2026-06-17

### Added
- Extension status display in stats bar: extension_ui_request setStatus events
  rendered inline alongside token stats, deduplicated by key

### Fixed
- Stats bar no longer flickers during active streaming (displayStats frozen state)

## 0.1.3 — 2026-06-17

### Added
- Token usage aggregation from message history and streaming events
- Context window tracking with percentage display
- SessionStats normalization for snake_case and camelCase RPC responses

### Fixed
- Message deduplication: local-only user messages replaced by server-confirmed copies
- Input box textarea now correctly auto-sizes to content height
- Race condition where refreshStats fire-and-forget caused stats to be undefined
- Auto-retry events now replace matching start event instead of creating duplicates

### Changed
- Layout switched from grid to flexbox with explicit height chain (html/body/#root)
- Timeline split into history items and live items to prevent tool event duplication
- Consecutive tool events (2+) collapsed into expandable "N tools" group card
- Tool events reconstructed from assistant content blocks on page refresh
- Streaming message_update renders throttled to ~30fps for performance
- Visible messages capped at 1000 with truncation notice
- Removed max-width constraints on assistant/tool/activity cards
- Thinking/reasoning blocks shown expanded by default
- Extracted renderTimelineItem, collapseToolGroups, messageKey helpers

## 0.1.2 — 2026-06-16

### Changed
- Renamed package to @watercol/pi-web-ui
- Added *.tgz to .gitignore, removed committed tgz files

## 0.1.0 — 2026-06-16

### Added
- Web-based TUI for pi coding agent
- SSE real-time streaming of pi RPC events
- REST API for prompt submission and abort
- Markdown rendering for agent messages
- Tool execution visualization (start/update/end)
- Compaction progress indicators
- Activity timeline view
- Queue state display (steering + follow-up)
- pi binary detection on startup with helpful error messages
- npm package distribution (zero runtime dependencies)

# Changelog

## 0.4.0 — 2026-06-30

### Added
- File sidebar: right-side panel showing workspace files with directory-first
  alphabetical sorting, directory expand/collapse, and file tree structure
- File preview: click any file to preview its content; supports text files,
  images (png/jpg/gif/webp/svg), and markdown rendering
- Draggable separator: resizable sidebar (200px–800px) with visual hover
  feedback and linear drag response
- Sidebar collapse/expand: toggle button to hide/show the sidebar while
  preserving the separator for quick re-expand
- Refresh button to reload the file list on demand
- New backend endpoints: `/api/file-content` and `/api/file-raw` with path
  validation ensuring workspace-scoped access

### Changed
- Sidebar collapse and refresh interactions polished for smoother UX

## 0.3.1 — 2026-06-29

### Added
- Dev mode file watcher: `--dev-watch` flag starts `vite build --watch` in the
  background so web asset changes are picked up automatically during development

### Changed
- Sub-node expand component: improved display logic and styling for expanded
  tool/thinking details
- Tool result details: removed collapsible toggle and improved argument parsing
  for a cleaner display
- Sub-node detail styles updated for better visual consistency

### Fixed
- Trace component performance: optimized rendering and animation to reduce
  stutter during rapid trace updates

## 0.3.0 — 2026-06-23

### Added
- Slash command menu: `/api/commands` endpoint retrieves commands registered
  on Pi; front-end command palette groups commands by source (builtin/extension/prompt/skill)
  with inline execution
- Git branch display: `server/src/git-branch.ts` reads the current git branch
  and shows it in the topbar alongside the working directory
- File picker for `@` references: `/api/files` endpoint recursively walks the
  project tree (depth limit 10, ignores `.git`/`node_modules` etc.); front-end
  shows a dropdown when `@` is typed in the input box
- Interactive dialog system (`interactive-dialog.tsx`): modal overlay for
  `extension_ui_request` events with options list, keyboard navigation, widget
  text display, and required/optional dismiss semantics
- Built-in command API endpoints: `/api/compact`, `/api/export`, `/api/copy`,
  `/api/session/name`, `/api/session/clone`, `/api/fork/messages`, `/api/fork`
- New shared types: `PiSlashCommand`, `FileEntry`; `gitBranch` field on `PiState`

### Fixed
- `@` file path directive: fixed recursive directory traversal so nested files
  are properly discovered and displayed

### Changed
- Input box now supports `@` to pick files and `/` to invoke command palette
- Extension UI response flow now uses a proper modal dialog instead of inline
  bubbles, with keyboard navigation and confirmation buttons

## 0.2.2 — 2026-06-20

### Added
- SSE message_update coalescing: buffers rapid streaming events and flushes every
  200ms, cutting SSE traffic by ~92% (~5 events/s instead of 60+)
- Toast notification stack for activity events (retries, thinking level changes,
  extension errors, compaction results) with auto-dismiss, replace groups, and
  cascade-dismiss semantics
- `useDeferredValue` on the streaming message to keep scrolling and tool updates
  responsive during high-frequency LLM output

### Changed
- Activity events (retries, notifications, errors) now appear as toasts in the
  top-right corner instead of inline timeline bubbles
- Compaction progress shown via the Stream status badge rather than a separate
  `compaction-notice` element

### Removed
- Inline activity bubble components (`ActivityBubble`, `NoticeBubble`,
  `ExtensionUiBubble`, `RawEventBubble`) — superseded by the toast stack
- `activity` variant from the `TimelineItem` union type
- Vertical connector line (`path-line`) inside the session-path message list

### Fixed
- `fetchState` used a stale closure for `displayStats` fallback; switched to
  functional updater

## 0.2.1 — 2026-06-20

### Added
- README: added Pi Web UI screenshot
- README: added CHANGELOG link
- CHANGELOG.md included in the published npm package

## 0.2.0 — 2026-06-20

### Added
- Dual-layer path trace view: session-level solid vertical lines + trace-level dashed lines,
  node dot color indicates status (amber=in-progress, green=completed, red=error),
  with text summary on the right
- `PathNode`: Layer 1 node wrapper, manages dot and card layout uniformly
- `TraceCard`: foldable trace card embedding Layer 2 sub-path view
- `SubPath`: Layer 2 sub-path container with dashed vertical line and auto-merge for
  consecutive completed tools
- `SubNode`: Layer 2 thinking/tool entry node, expandable for details
- `SubGroup`: collapse group for 2+ consecutive completed tools
- `traceEntryStatusColor` / `traceOverallStatus`: path trace color utility functions
- Web test infrastructure (jsdom + @testing-library/react), 19 behavior tests

### Removed
- `TraceBubble`: replaced by `TraceCard` + `SubPath`
- `CompactToolGroup`: replaced by `SubGroup`
- `renderMergedEntries`: merge logic moved into `SubPath`

### Changed
- Styles fully simplified: removed card backgrounds/rounded borders, switched to
  plain text + left border + dot, giving a clean modern look
- `message-list` → `session-path`: new path trace layout container
- `StreamingAssistantCard`: internal trace now uses `TraceCard` + `PathNode`
- `renderTimelineItem`: each timeline entry wrapped in `PathNode` for consistent
  path trace styling
- Shared types (`ExecutionTrace`, `TraceEntry`, `TimelineItem`) extracted as exports
- `parseJsonlSession` / `writeJsonlRecord` moved to `pi-rpc-client.ts`, removed
  `server/src/jsonl.ts`

### Fixed
- Long text streaming stutter: adaptive throttling (short text 32ms → long text 150ms),
  dynamically adjusts refresh rate based on text length
- Invalid `setStreamingMessage` calls: added text hash guard, only triggers re-render
  when text actually changes
- `Markdown` component duplicate parsing: ref cache skips redundant `marked.parse()`
  for identical text
- Pure-thinking (no tool) traces now show green on completion instead of getting
  stuck on amber
- `traceShapeKey` computed only when necessary

## 0.1.6 — 2026-06-19

### Added
- Execution trace: assistant thinking blocks and tool calls merged into a structured
  trace card with foldable sections and live streaming status
- `CompactToolGroup`: completed tools collapsed into a one-line summary in the
  streaming trace to reduce visual noise
- `ToolExecutionBubble` collapsed mode: complete non-error tools shown as a
  single-line `<details>` expandable
- Server error handling: graceful `EADDRINUSE` error with actionable port-change
  hint; correct port display when binding to port 0
- `hasAssistantDisplayContent`: helper to filter out pure-trace assistant messages
  from duplicative rendering

### Changed
- `StreamingAssistantBubble` replaced by `StreamingAssistantCard` with integrated
  trace header (thinking + tool counts, live status icon)
- Streaming text throttle (~30fps) now exempts trace shape changes, keeping
  thinking/tool order immediately up-to-date
- Successful auto-retry notices auto-dismiss after 5 seconds
- Pending `willRetry` cards cleaned up when actual retry flow starts

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

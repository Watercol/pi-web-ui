# Changelog

## 0.2.0 — 2026-06-20

### Added
- 双层路径图 trace 展示：会话级实线竖线 + trace 内部虚线，节点圆点颜色表示状态
  （琥珀=进行中，绿色=已完成，红色=异常），右侧附文字摘要
- `PathNode`：Layer 1 节点包裹器，统一管理圆点和卡片布局
- `TraceCard`：可折叠 trace 卡片，内嵌 Layer 2 子路径图
- `SubPath`：Layer 2 子路径容器，虚线竖线 + 连续完成工具自动合并
- `SubNode`：Layer 2 thinking / tool 条目节点，可展开查看详情
- `SubGroup`：≥2 个连续已完成 tool 的合并折叠组
- `traceEntryStatusColor` / `traceOverallStatus`：路径图颜色判定工具函数
- Web 端测试基础设施（jsdom + @testing-library/react），19 个行为测试

### Removed
- `TraceBubble`：替换为 `TraceCard` + `SubPath`
- `CompactToolGroup`：替换为 `SubGroup`
- `renderMergedEntries`：合并逻辑移入 `SubPath`

### Changed
- 样式全面简化：移除消息卡片的背景/圆角边框，改为纯文字 + 左边线 + 圆点，简洁现代
- `message-list` → `session-path`：新的路径图布局容器
- `StreamingAssistantCard`：内部 trace 改用 `TraceCard` + `PathNode` 包裹
- `renderTimelineItem`：每种时间线条目包裹 `PathNode` 以统一路径图样式
- 提取共享类型（`ExecutionTrace`、`TraceEntry`、`TimelineItem`）为导出类型
- `parseJsonlSession` / `writeJsonlRecord` 移至 `pi-rpc-client.ts`，删除 `server/src/jsonl.ts`

### Fixed
- 长文本流式卡顿：自适应节流（短文本 32ms → 长文本 150ms），根据文本长度动态调整刷新率
- 无效 `setStreamingMessage` 调用：新增 text hash 守卫，仅文本实际变化时触发重渲染
- `Markdown` 组件重复解析：Ref 缓存跳过相同文本的冗余 `marked.parse()`
- 纯 thinking（无 tool）trace 完成时显示绿色而非卡在黄色
- `traceShapeKey` 仅在必要时计算

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

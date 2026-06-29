import type { ActivityEvent, AgentMessage, ContentBlock, JsonValue, PiModel, PiRpcEvent, PiSessionInfo, PiState, StreamingMessage, ToolExecutionEvent } from "../../../shared/src/index.js";

// ============================================================================
// Constants & helpers extracted from main.tsx
// ============================================================================

const COMPOSER_MAX_VIEWPORT_RATIO = 0.5;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

export function resizeComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const maxHeight = Math.max(46, window.innerHeight * COMPOSER_MAX_VIEWPORT_RATIO);
  const nextHeight = Math.min(el.scrollHeight, maxHeight);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function modelDisplayName(model: PiModel): string {
  return model.displayName || model.name || model.id || `${model.provider || "model"}`;
}

export function modelKey(model: PiModel): string {
  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
  return `${provider}/${id}`;
}

export function thinkingLevelLabel(level: string): string {
  return level === "xhigh" ? "X High" : level.charAt(0).toUpperCase() + level.slice(1);
}

export function supportedThinkingLevels(model: PiModel | null): ThinkingLevel[] {
  if (!model) return ["off", "minimal", "low", "medium", "high"];
  if (model.reasoning === false) return ["off"];

  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" && !Array.isArray(model.thinkingLevelMap)
    ? model.thinkingLevelMap as Record<string, JsonValue | undefined>
    : undefined;

  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

export function sessionDisplayName(session: PiSessionInfo): string {
  return session.name || session.firstMessage || session.id || "New session";
}

export function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

export const MAX_VISIBLE_MESSAGES = 1000;
const MAX_STORED_MESSAGES = MAX_VISIBLE_MESSAGES * 2;

export const emptyState: PiState = {
  cwd: "",
  piBin: "",
  model: null,
  isStreaming: false,
  processRunning: false
};

// Shared types for trace/timeline helpers (exported for tests)
export type ExecutionTrace = {
  id: string;
  entries: TraceEntry[];
  active?: boolean;
};

export type TraceEntry =
  | { kind: "thinking"; block: ContentBlock; key: string }
  | { kind: "tool"; event: ToolExecutionEvent; key: string };

export type TimelineItem =
  | { kind: "message"; message: AgentMessage }
  | { kind: "trace"; trace: ExecutionTrace }
  | { kind: "toolEvent"; event: ToolExecutionEvent }
  | { kind: "toolGroup"; events: { kind: "toolEvent"; event: ToolExecutionEvent }[] };

export function formatArgSummary(args: JsonValue | undefined): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  const [k, v] = entries[0];
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `${k}: ${s.length > 80 ? s.slice(0, 77) + "..." : s}`;
}

export function extractText(message: AgentMessage): string {
  const direct = message.content ?? message.text ?? message.message;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) {
    return direct
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }
  if (direct !== undefined) return JSON.stringify(direct, null, 2);
  return JSON.stringify(message, null, 2);
}

export function extractContentBlocks(message: AgentMessage): ContentBlock[] {
  const content = message.content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return { type: "text", text: item } satisfies ContentBlock;
      if (item && typeof item === "object") {
        const block = item as Record<string, unknown>;
        const blockType = String(block.type || "text");
        if (blockType === "thinking" && typeof block.thinking === "string") {
          return { type: "thinking", thinking: block.thinking } satisfies ContentBlock;
        }
        if (blockType === "text" && typeof block.text === "string") {
          return { type: "text", text: block.text } satisfies ContentBlock;
        }
        if (blockType === "toolCall" && typeof block.name === "string" && typeof block.id === "string") {
          // Session 文件中参数存储在 arguments 字段，streaming 消息中在 input 字段
          const args = (block.input as JsonValue) ?? (block.arguments as JsonValue) ?? null;
          return { type: "toolCall", name: block.name, id: block.id, input: args, arguments: args } satisfies ContentBlock;
        }
        if (blockType === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
          return { type: "image", data: block.data, mimeType: block.mimeType } satisfies ContentBlock;
        }
        return { type: "text", text: typeof block.text === "string" ? block.text : JSON.stringify(block) } satisfies ContentBlock;
      }
      return { type: "text", text: JSON.stringify(item) } satisfies ContentBlock;
    });
  }
  const text = extractText(message);
  return text ? [{ type: "text", text }] : [];
}

export function buildStreamingTrace(message: StreamingMessage, toolEvents: ToolExecutionEvent[]): ExecutionTrace {
  const toolCallIds = new Set<string>();
  const toolMap = new Map<string, ToolExecutionEvent>();
  const entries: TraceEntry[] = [];

  for (const tool of toolEvents) {
    if (tool.toolCallId) toolMap.set(tool.toolCallId, tool);
  }

  for (const [blockIndex, block] of message.content.entries()) {
    if (block.type === "thinking") {
      entries.push({ kind: "thinking", block, key: `thinking-${blockIndex}` });
      continue;
    }
    if (block.type !== "toolCall" || !block.id || !block.name) continue;

    const toolCallId = String(block.id);
    toolCallIds.add(toolCallId);
    const pendingTool: ToolExecutionEvent = {
      toolCallId,
      toolName: String(block.name),
      args: (block.input ?? block.arguments ?? undefined) as JsonValue | undefined,
      timestamp: message.timestamp,
      status: "pending"
    };
    entries.push({
      kind: "tool",
      key: `tool-${toolCallId}`,
      event: { ...pendingTool, ...toolMap.get(toolCallId) }
    });
  }

  for (const tool of toolEvents) {
    if (toolCallIds.has(tool.toolCallId)) continue;
    entries.push({ kind: "tool", event: tool, key: `tool-live-${tool.toolCallId}` });
  }

  return {
    id: message.id || String(message.timestamp || "streaming"),
    entries,
    active: true
  };
}

export function traceShapeKey(blocks: ContentBlock[]): string {
  return blocks
    .map((block, index) => {
      if (block.type === "thinking") return `thinking:${index}:${block.thinking?.length ?? 0}`;
      if (block.type === "toolCall") return `tool:${block.id || index}:${block.name || ""}`;
      return "";
    })
    .filter(Boolean)
    .join("|");
}

export function hasAssistantDisplayContent(message: AgentMessage): boolean {
  if (message.errorMessage) return true;
  return extractContentBlocks(message).some((block) =>
    block.type === "text" && Boolean(block.text?.trim()) ||
    block.type === "image" ||
    !["thinking", "toolCall"].includes(block.type)
  );
}

export function collapseToolGroups(items: TimelineItem[]): TimelineItem[] {
  const collapsed: TimelineItem[] = [];
  let toolGroup: { kind: "toolEvent"; event: ToolExecutionEvent }[] = [];

  for (const item of items) {
    if (item.kind === "toolEvent") {
      toolGroup.push(item);
      continue;
    }

    flushToolGroup(collapsed, toolGroup);
    toolGroup = [];
    collapsed.push(item);
  }

  flushToolGroup(collapsed, toolGroup);
  return collapsed;
}

function flushToolGroup(target: TimelineItem[], toolGroup: { kind: "toolEvent"; event: ToolExecutionEvent }[]) {
  if (toolGroup.length >= 2) {
    target.push({ kind: "toolGroup", events: toolGroup });
  } else if (toolGroup.length === 1 && toolGroup[0]) {
    target.push(toolGroup[0]);
  }
}

export function mergeMessages(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  if (current.length === 0) return dedupeMessages(incoming);

  const result = [...current];
  const seen = new Set(result.map((message, index) => messageKey(message, index)));

  for (const message of incoming) {
    const key = messageKey(message);
    if (seen.has(key)) continue;

    const localDuplicateIndex = findLocalUserDuplicate(result, message);
    if (localDuplicateIndex >= 0) {
      const previousKey = messageKey(result[localDuplicateIndex]!, localDuplicateIndex);
      result[localDuplicateIndex] = message;
      seen.delete(previousKey);
      seen.add(key);
      continue;
    }

    result.push(message);
    seen.add(key);
  }

  return dedupeMessages(result).slice(-MAX_STORED_MESSAGES);
}

function dedupeMessages(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    const key = messageKey(message, result.length);
    if (seen.has(key)) continue;

    const localDuplicateIndex = findLocalUserDuplicate(result, message);
    if (localDuplicateIndex >= 0) {
      const previousKey = messageKey(result[localDuplicateIndex]!, localDuplicateIndex);
      result[localDuplicateIndex] = message;
      seen.delete(previousKey);
    } else {
      result.push(message);
    }
    seen.add(messageKey(message, result.length - 1));
  }

  return result;
}

function findLocalUserDuplicate(messages: AgentMessage[], incoming: AgentMessage): number {
  if (incoming.role !== "user" || Boolean(incoming.localOnly)) return -1;
  const incomingText = extractText(incoming);
  if (!incomingText) return -1;

  return messages.findIndex((message) =>
    message.role === "user" &&
    Boolean(message.localOnly) &&
    extractText(message) === incomingText
  );
}

export function messageKey(message: AgentMessage, fallbackIndex = -1): string {
  if (typeof message.id === "string") return `id:${message.id}`;
  if (typeof message.responseId === "string") return `response:${message.responseId}`;
  if (typeof message.timestamp === "number") return `timestamp:${message.timestamp}:${message.role ?? message.type ?? ""}:${extractText(message)}`;
  return `content:${message.role ?? message.type ?? ""}:${extractText(message)}:${fallbackIndex}`;
}

export function shouldDisplayActivity(event: ActivityEvent): boolean {
  return event.type !== "turn_start" && event.type !== "turn_end";
}

export function summarizeContentBlocks(blocks: ContentBlock[]): string {
  const firstText = blocks.find((block) => block.type === "text" && block.text?.trim());
  if (firstText?.text) {
    const compact = firstText.text.replace(/\s+/g, " ").trim();
    return compact.length > 96 ? `${compact.slice(0, 96)}...` : compact;
  }
  if (blocks.some((block) => block.type === "image")) return "Image result";
  if (blocks.length > 0) return `${blocks.length} result block${blocks.length === 1 ? "" : "s"}`;
  return "";
}

/** Return an individual trace entry node's status color key for the path diagram. */
export function traceEntryStatusColor(entry: TraceEntry): "thinking" | "pending" | "running" | "complete" | "error" {
  if (entry.kind === "thinking") return "thinking";
  const tool = entry.event;
  if (tool.isError) return "error";
  if (tool.status === "complete" || (!tool.status && tool.result)) return "complete";
  if (tool.status === "running") return "running";
  return "pending";
}

/** Return the overall trace card color key (Layer 1 dot). */
export function traceOverallStatus(
  entries: TraceEntry[],
  active: boolean
): "active" | "complete" | "error" {
  if (active) return "active";
  const hasError = entries.some((e) => e.kind === "tool" && e.event.isError);
  if (hasError) return "error";
  const toolEntries = entries.filter((e) => e.kind === "tool");
  // Thinking-only traces become complete once the stream ends (active=false).
  if (toolEntries.length === 0) {
    return entries.length > 0 ? "complete" : "active";
  }
  const allDone = toolEntries.every((e) => {
    const t = e.event;
    return t.status === "complete" || (!t.status && !!t.result);
  });
  return allDone ? "complete" : "active";
}

const STATUS_ORDER: Record<string, number> = { pending: 0, running: 1, complete: 2 };

export function appendToolEvent(current: ToolExecutionEvent[], event: ToolExecutionEvent): ToolExecutionEvent[] {
  const idx = current.findIndex((existing) => existing.toolCallId === event.toolCallId);
  if (idx >= 0) {
    const updated = [...current];
    const existing = current[idx]!;
    // Preserve the more advanced status; apply all other new properties on top
    const mergedStatus = (STATUS_ORDER[event.status ?? ""] ?? -1) >= (STATUS_ORDER[existing.status ?? ""] ?? -1)
      ? event.status
      : existing.status;
    updated[idx] = { ...existing, ...event, status: mergedStatus, timestamp: existing.timestamp ?? event.timestamp };
    return updated;
  }
  return [...current, event];
}

export function isUnknownDisplayEvent(event: PiRpcEvent): boolean {
  const shown = new Set(["agent_start", "agent_end", "turn_start", "turn_end",
    "message_start", "message_update", "message_end", "message_complete", "message_partial",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "compaction_start", "compaction_end", "compaction_snapshot",
    "queue_update", "queue_message",
    "thinking_level_changed", "session_info_changed",
    "auto_retry_start", "auto_retry_end", "response", "error"]);
  return !shown.has(event.type) && event.type !== "extension_ui_request";
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function stripAnsiDisplay(text: string): string {
  // Strip SGR (Select Graphic Rendition) sequences: ESC[ param ; param m
  // Also handles OSC 133 terminal markers
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\]133;[ABC]\x07/g, "");
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export type { ThinkingLevel };
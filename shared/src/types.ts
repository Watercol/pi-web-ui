export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type PiRpcCommand = {
  id?: string;
  type: string;
  [key: string]: JsonValue | undefined;
};

export type PiRpcResponse<T = JsonValue> = {
  id?: string;
  type: "response";
  command?: string;
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
};

export type PiRpcEvent = {
  type: string;
  [key: string]: JsonValue | undefined;
};

export type PiModel = {
  id?: string;
  name?: string;
  provider?: string;
  displayName?: string;
  [key: string]: JsonValue | undefined;
};

export type SessionStats = {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
};

export type PiState = {
  cwd: string;
  gitBranch?: string | null;
  piBin: string;
  model: PiModel | null;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  processRunning: boolean;
  lastError?: string;
  autoCompactionEnabled?: boolean;
  stats?: SessionStats;
};

export type PiSessionInfo = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
};

export type AgentMessage = {
  id?: string;
  role?: string;
  type?: string;
  content?: JsonValue;
  text?: string;
  message?: string;
  [key: string]: JsonValue | undefined;
};

export type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  redacted?: boolean;
  name?: string;
  id?: string;
  input?: JsonValue;
  arguments?: JsonValue;
  data?: string;
  mimeType?: string;
  [key: string]: JsonValue | undefined;
};

export type StreamingMessage = {
  id?: string;
  role?: string;
  content: ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
};

export type ToolExecutionEvent = {
  toolCallId: string;
  toolName: string;
  args?: JsonValue;
  isError?: boolean;
  timestamp?: number;
  status?: "pending" | "running" | "complete";
  partialResult?: { content: ContentBlock[]; details?: JsonValue };
  result?: { content: ContentBlock[]; details?: JsonValue };
};

export type QueueState = {
  steering: string[];
  followUp: string[];
};

export type ActivityEvent =
  | { id: string; type: "turn_start"; timestamp: number }
  | { id: string; type: "turn_end"; timestamp: number; message?: AgentMessage; toolResults?: AgentMessage[] }
  | { id: string; type: "thinking_level_changed"; timestamp: number; level: string }
  | { id: string; type: "session_info_changed"; timestamp: number; name?: string }
  | { id: string; type: "auto_retry_start"; timestamp: number; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { id: string; type: "auto_retry_end"; timestamp: number; success: boolean; attempt: number; finalError?: string }
  | { id: string; type: "extension_ui_request"; timestamp: number; method: string; title?: string; message?: string; notifyType?: string; statusKey?: string; statusText?: string; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: string; text?: string; options?: string[]; timeout?: number }
  | { id: string; type: "extension_error"; timestamp: number; extensionPath?: string; event?: string; error?: string }
  | { id: string; type: "unknown"; timestamp: number; event: PiRpcEvent };

export type ServerEvent =
  | { type: "state"; state: PiState }
  | { type: "messages"; messages: AgentMessage[] }
  | { type: "pi_event"; event: PiRpcEvent }
  | { type: "error"; message: string }
  | { type: "connected" }
  | { type: "message_start"; message: StreamingMessage }
  | { type: "message_update"; message: StreamingMessage }
  | { type: "message_end"; message: StreamingMessage }
  | { type: "tool_start"; event: ToolExecutionEvent }
  | { type: "tool_update"; event: ToolExecutionEvent }
  | { type: "tool_end"; event: ToolExecutionEvent }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; aborted?: boolean; reason?: string; willRetry?: boolean; errorMessage?: string; summary?: string; result?: JsonValue }
  | { type: "queue_update"; queue: QueueState }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: AgentMessage[]; willRetry?: boolean }
  | { type: "activity"; event: ActivityEvent };

export type PromptRequest = {
  message: string;
};

export type ModelSwitchRequest = {
  provider: string;
  modelId: string;
};

export type SessionSwitchRequest = {
  sessionPath: string;
};

export type ThinkingLevelSwitchRequest = {
  level: string;
};

/** Slash command returned by Pi RPC get_commands */
export type PiSlashCommand = {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  sourceInfo?: { source: string; scope: string; path?: string };
};

/** File/directory entry returned by /api/files */
export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

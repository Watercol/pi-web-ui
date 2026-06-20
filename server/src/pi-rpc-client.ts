import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ActivityEvent, AgentMessage, ContentBlock, JsonValue, PiRpcCommand, PiRpcEvent, PiRpcResponse, PiState, QueueState, SessionStats, StreamingMessage, ToolExecutionEvent } from "../../shared/src/index.js";
import { buildPiArgs, type ServerConfig } from "./config.js";

// --- JSONL parser (inlined from jsonl.ts to keep import depth ≤ 2) ---

export type JsonLineResult =
  | { ok: true; value: unknown }
  | { ok: false; line: string; error: Error };

export class JsonlParser {
  private buffer = "";

  push(chunk: string | Buffer): JsonLineResult[] {
    this.buffer += chunk.toString("utf8");
    const results: JsonLineResult[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;

      try {
        results.push({ ok: true, value: JSON.parse(line) });
      } catch (error) {
        results.push({
          ok: false,
          line,
          error: error instanceof Error ? error : new Error(String(error))
        });
      }
    }

    return results;
  }

  flush(): JsonLineResult[] {
    if (!this.buffer) return [];
    const line = this.buffer;
    this.buffer = "";
    try {
      return [{ ok: true, value: JSON.parse(line) }];
    } catch (error) {
      return [
        {
          ok: false,
          line,
          error: error instanceof Error ? error : new Error(String(error))
        }
      ];
    }
  }
}

type PendingRequest = {
  resolve: (value: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TokenStats = SessionStats["tokens"];

type UsageSummary = {
  tokens: TokenStats;
  cost: number;
  hasUsage: boolean;
};

export type PiRpcClientEvents = {
  event: [event: PiRpcEvent];
  state: [state: PiState];
  messages: [messages: AgentMessage[]];
  error: [error: Error];
  messageStart: [message: StreamingMessage];
  messageUpdate: [message: StreamingMessage];
  messageEnd: [message: StreamingMessage];
  toolStart: [event: ToolExecutionEvent];
  toolUpdate: [event: ToolExecutionEvent];
  toolEnd: [event: ToolExecutionEvent];
  compactionStart: [reason?: string];
  compactionEnd: [event: { aborted?: boolean; reason?: string; willRetry?: boolean; errorMessage?: string; summary?: string; result?: JsonValue }];
  queueUpdate: [queue: QueueState];
  agentStart: [];
  agentEnd: [messages?: AgentMessage[], willRetry?: boolean];
  activity: [event: ActivityEvent];
};

export class PiRpcClient extends EventEmitter<PiRpcClientEvents> {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly parser = new JsonlParser();
  private requestCounter = 0;
  private lastStateData: Partial<PiState> = {};
  private messages: AgentMessage[] = [];
  private readonly streamingUsageMessages = new Map<string, AgentMessage>();
  private lastError: string | undefined;

  constructor(private readonly config: ServerConfig) {
    super();
  }

  start(): void {
    if (this.child) return;

    const args = buildPiArgs(this.config);
    const child = spawn(this.config.piBin, args, {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.child = child;

    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stdin.on("error", (error) => {
      this.rejectAll(error);
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.setError(stripAnsi(message));
    });
    child.on("error", (error) => {
      this.setError(`Failed to start Pi RPC process: ${error.message}`);
      this.rejectAll(error);
      this.emitState();
    });
    child.on("exit", (code, signal) => {
      const reason = `Pi RPC process exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
      this.child = undefined;
      this.setError(reason);
      this.rejectAll(new Error(reason));
      this.emitState();
    });

    this.emitState();
    void this.refreshState().catch(() => undefined);
    void this.refreshMessages().catch(() => undefined);
  }

  stop(): void {
    if (!this.child) return;
    this.child.kill();
  }

  private lastStats: SessionStats | undefined;

  getState(): PiState {
    return {
      cwd: this.config.cwd,
      piBin: this.config.piBin,
      model: this.lastStateData.model ?? null,
      thinkingLevel: this.lastStateData.thinkingLevel,
      isStreaming: Boolean(this.lastStateData.isStreaming),
      isCompacting: this.lastStateData.isCompacting,
      sessionFile: this.lastStateData.sessionFile,
      sessionId: this.lastStateData.sessionId,
      sessionName: this.lastStateData.sessionName,
      messageCount: this.lastStateData.messageCount,
      pendingMessageCount: this.lastStateData.pendingMessageCount,
      processRunning: Boolean(this.child && !this.child.killed),
      lastError: this.lastError,
      autoCompactionEnabled: this.lastStateData.autoCompactionEnabled,
      stats: this.lastStats
    };
  }

  getMessages(): AgentMessage[] {
    return this.messages;
  }

  async refreshState(): Promise<PiState> {
    const response = await this.request("get_state");
    if (response.success && response.data && typeof response.data === "object") {
      this.lastStateData = response.data as Partial<PiState>;
      this.recomputeStatsFromMessages();
      await this.refreshStats().catch(() => undefined);
      this.emitState();
    }
    return this.getState();
  }

  async getSessionStats(): Promise<SessionStats | undefined> {
    return this.lastStats;
  }

  async refreshStats(): Promise<SessionStats | undefined> {
    const response = await this.request("get_session_stats");
    if (response.success && response.data) {
      this.setStats(this.normalizeSessionStats(response.data) ?? this.lastStats);
    }
    return this.lastStats;
  }

  async refreshMessages(): Promise<AgentMessage[]> {
    const response = await this.request("get_messages");
    if (response.success && response.data && typeof response.data === "object") {
      const data = response.data as { messages?: AgentMessage[] };
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.streamingUsageMessages.clear();
      this.recomputeStatsFromMessages();
      this.emit("messages", this.messages);
    }
    return this.messages;
  }

  async prompt(message: string): Promise<PiRpcResponse> {
    const response = await this.request("prompt", { message });
    void this.refreshState().catch(() => undefined);
    return response;
  }

  async abort(): Promise<PiRpcResponse> {
    const response = await this.request("abort");
    void this.refreshState().catch(() => undefined);
    return response;
  }

  async getAvailableModels(): Promise<PiRpcResponse> {
    return this.request("get_available_models");
  }

  async setModel(provider: string, modelId: string): Promise<PiRpcResponse> {
    const response = await this.request("set_model", { provider, modelId });
    if (response.success && response.data && typeof response.data === "object") {
      this.lastStateData = { ...this.lastStateData, model: response.data as PiState["model"] };
      this.recomputeStatsFromMessages();
      this.emitState();
    } else {
      void this.refreshState().catch(() => undefined);
    }
    return response;
  }

  async setThinkingLevel(level: string): Promise<PiRpcResponse> {
    const response = await this.request("set_thinking_level", { level });
    if (response.success) {
      this.lastStateData = { ...this.lastStateData, thinkingLevel: level };
      this.emitState();
      void this.refreshState().catch(() => undefined);
    } else {
      void this.refreshState().catch(() => undefined);
    }
    return response;
  }

  async newSession(): Promise<PiRpcResponse> {
    const response = await this.request("new_session");
    await this.refreshAfterSessionChange(response);
    return response;
  }

  async switchSession(sessionPath: string): Promise<PiRpcResponse> {
    const response = await this.request("switch_session", { sessionPath });
    await this.refreshAfterSessionChange(response);
    return response;
  }

  request(type: string, payload: Record<string, JsonValue | undefined> = {}, timeoutMs = 30_000): Promise<PiRpcResponse> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("Pi RPC process is not running"));
    }

    const id = `req-${Date.now()}-${++this.requestCounter}`;
    const command: PiRpcCommand = { id, type, ...payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleStdout(chunk: Buffer): void {
    for (const result of this.parser.push(chunk)) {
      if (!result.ok) {
        this.setError(`Invalid JSON from Pi RPC: ${result.error.message}`);
        continue;
      }
      this.handleMessage(result.value);
    }
  }

  private async refreshAfterSessionChange(response: PiRpcResponse): Promise<void> {
    const data = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : undefined;
    if (!response.success || data?.cancelled === true) return;
    this.messages = [];
    this.streamingUsageMessages.clear();
    this.lastStats = undefined;
    await this.refreshState().catch(() => undefined);
    await this.refreshMessages().catch(() => undefined);
    await this.refreshStats().catch(() => undefined);
    this.emitState();
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== "object") {
      this.setError("Received non-object JSON from Pi RPC");
      return;
    }

    const message = value as PiRpcEvent | PiRpcResponse;
    if (message.type === "response") {
      this.handleResponse(message as PiRpcResponse);
      return;
    }

    this.applyEvent(message as PiRpcEvent);
    this.emit("event", message as PiRpcEvent);
  }

  private handleResponse(response: PiRpcResponse): void {
    if (response.id) {
      const pending = this.pending.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.success) pending.resolve(response);
        else pending.reject(new Error(response.error || response.message || `${response.command || "RPC"} failed`));
      }
    }
    if (!response.success) {
      if (response.command === "get_session_stats") return;
      this.setError(response.error || response.message || `${response.command || "RPC"} failed`);
    }
  }

  private applyEvent(event: PiRpcEvent): void {
    if (event.type === "agent_start") {
      this.lastStateData = { ...this.lastStateData, isStreaming: true };
      this.emitState();
      this.emit("agentStart");
    } else if (event.type === "agent_end") {
      this.lastStateData = { ...this.lastStateData, isStreaming: false };
      const messages = (event as { messages?: AgentMessage[] }).messages;
      const willRetry = Boolean(event.willRetry);
      if (Array.isArray(messages)) {
        this.messages = messages;
        this.streamingUsageMessages.clear();
        this.recomputeStatsFromMessages();
      } else {
        void this.refreshMessages().catch(() => undefined);
      }
      this.refreshStats().then(() => this.emitState()).catch(() => this.emitState());
      this.emit("agentEnd", messages, willRetry);
    } else if (event.type === "message_start") {
      const msg = this.normalizeStreamingMessage(event.message);
      if (msg) {
        this.applyUsageMessage(msg);
        this.emit("messageStart", msg);
      }
    } else if (event.type === "message_update" || event.type === "message_partial") {
      const msg = this.normalizeStreamingMessage((event as { message?: unknown }).message);
      if (msg) {
        this.applyUsageMessage(msg);
        this.emit("messageUpdate", msg);
      }
    } else if (event.type === "message_end") {
      const msg = this.normalizeStreamingMessage((event as { message?: unknown }).message);
      if (msg) {
        this.applyUsageMessage(msg);
        this.emit("messageEnd", msg);
      }
    } else if (event.type === "tool_execution_start") {
      this.emit("toolStart", {
        toolCallId: String(event.toolCallId ?? ""),
        toolName: String(event.toolName ?? ""),
        args: event.args as JsonValue | undefined,
      });
    } else if (event.type === "tool_execution_update") {
      this.emit("toolUpdate", {
        toolCallId: String(event.toolCallId ?? ""),
        toolName: String(event.toolName ?? ""),
        partialResult: this.extractContentBlocks(event.partialResult),
      });
    } else if (event.type === "tool_execution_end") {
      this.emit("toolEnd", {
        toolCallId: String(event.toolCallId ?? ""),
        toolName: String(event.toolName ?? ""),
        isError: Boolean(event.isError),
        result: this.extractContentBlocks(event.result),
      });
    } else if (event.type === "compaction_start") {
      this.lastStateData = { ...this.lastStateData, isCompacting: true };
      this.emit("compactionStart", typeof event.reason === "string" ? event.reason : undefined);
      this.emitState();
    } else if (event.type === "compaction_end") {
      this.lastStateData = { ...this.lastStateData, isCompacting: false };
      const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : undefined;
      this.emit("compactionEnd", {
        aborted: Boolean(event.aborted),
        reason: typeof event.reason === "string" ? event.reason : undefined,
        willRetry: Boolean(event.willRetry),
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
        summary: typeof result?.summary === "string" ? result.summary : typeof event.summary === "string" ? event.summary : undefined,
        result: event.result as JsonValue | undefined
      });
      this.emitState();
    } else if (event.type === "queue_update") {
      this.emit("queueUpdate", {
        steering: Array.isArray(event.steering) ? event.steering.map(String) : [],
        followUp: Array.isArray(event.followUp) ? event.followUp.map(String) : [],
      });
    } else if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
      this.setError(message);
    }
    this.applyActivityEvent(event);
  }

  private applyUsageMessage(message: StreamingMessage): void {
    if (!this.extractUsageSummary(message).hasUsage) return;
    this.streamingUsageMessages.set(this.messageStatsKey(message), message as AgentMessage);
    if (this.recomputeStatsFromMessages()) this.emitState();
  }

  private recomputeStatsFromMessages(): boolean {
    return this.setStats(this.buildStatsFromMessages());
  }

  private buildStatsFromMessages(): SessionStats | undefined {
    const messageMap = new Map<string, AgentMessage>();
    this.messages.forEach((message, index) => {
      messageMap.set(this.messageStatsKey(message, `history-${index}`), message);
    });
    for (const [key, message] of this.streamingUsageMessages) {
      messageMap.set(key, message);
    }

    const messages = [...messageMap.values()];
    const tokens: TokenStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let hasUsage = false;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;

    for (const message of messages) {
      const role = typeof message.role === "string" ? message.role : typeof message.type === "string" ? message.type : "";
      if (role === "user") userMessages += 1;
      if (role === "assistant") assistantMessages += 1;
      if (role === "toolResult") toolResults += 1;

      for (const block of this.normalizeContentBlocks(message.content)) {
        if (block.type === "toolCall") toolCalls += 1;
      }

      const usage = this.extractUsageSummary(message);
      if (!usage.hasUsage) continue;
      hasUsage = true;
      tokens.input += usage.tokens.input;
      tokens.output += usage.tokens.output;
      tokens.cacheRead += usage.tokens.cacheRead;
      tokens.cacheWrite += usage.tokens.cacheWrite;
      tokens.total += usage.tokens.total;
      cost += usage.cost;
    }

    if (tokens.total === 0) {
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    }

    const contextWindow = this.extractContextWindow();
    if (!hasUsage && !contextWindow) return undefined;

    const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    return {
      sessionFile: this.lastStateData.sessionFile,
      sessionId: this.lastStateData.sessionId || "",
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      contextUsage: contextWindow
        ? {
            tokens: promptTokens > 0 ? promptTokens : null,
            contextWindow,
            percent: promptTokens > 0 ? (promptTokens / contextWindow) * 100 : null
          }
        : undefined
    };
  }

  private setStats(stats: SessionStats | undefined): boolean {
    const next = stats ? this.withContextWindow(stats) : undefined;
    if (JSON.stringify(this.lastStats) === JSON.stringify(next)) return false;
    this.lastStats = next;
    return true;
  }

  private withContextWindow(stats: SessionStats): SessionStats {
    const contextWindow = stats.contextUsage?.contextWindow || this.extractContextWindow();
    if (!contextWindow) return stats;

    const promptTokens = stats.contextUsage?.tokens ?? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
    return {
      ...stats,
      contextUsage: {
        tokens: promptTokens > 0 ? promptTokens : null,
        contextWindow,
        percent: promptTokens > 0 ? (promptTokens / contextWindow) * 100 : null
      }
    };
  }

  private normalizeSessionStats(raw: unknown): SessionStats | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const source = raw as Record<string, unknown>;
    const stats = (source.stats && typeof source.stats === "object" ? source.stats : source) as Record<string, unknown>;
    const tokenSource = (stats.tokens && typeof stats.tokens === "object" ? stats.tokens : stats) as Record<string, unknown>;
    const usage = this.extractUsageSummary({ usage: tokenSource, cost: stats.cost } as AgentMessage);
    const contextUsage = stats.contextUsage && typeof stats.contextUsage === "object"
      ? stats.contextUsage as Record<string, unknown>
      : undefined;
    const contextWindow = toNumber(contextUsage?.contextWindow ?? contextUsage?.context_window ?? stats.contextWindow ?? stats.context_window ?? this.extractContextWindow());
    const contextTokens = toNumber(contextUsage?.tokens ?? contextUsage?.usedTokens ?? contextUsage?.used_tokens);

    if (!usage.hasUsage && !contextWindow) return undefined;
    return {
      sessionFile: typeof stats.sessionFile === "string" ? stats.sessionFile : typeof stats.session_file === "string" ? stats.session_file : this.lastStateData.sessionFile,
      sessionId: typeof stats.sessionId === "string" ? stats.sessionId : typeof stats.session_id === "string" ? stats.session_id : this.lastStateData.sessionId || "",
      userMessages: toNumber(stats.userMessages ?? stats.user_messages) ?? 0,
      assistantMessages: toNumber(stats.assistantMessages ?? stats.assistant_messages) ?? 0,
      toolCalls: toNumber(stats.toolCalls ?? stats.tool_calls) ?? 0,
      toolResults: toNumber(stats.toolResults ?? stats.tool_results) ?? 0,
      totalMessages: toNumber(stats.totalMessages ?? stats.total_messages) ?? this.messages.length,
      tokens: usage.tokens,
      cost: usage.cost,
      contextUsage: contextWindow
        ? {
            tokens: contextTokens ?? null,
            contextWindow,
            percent: toNumber(contextUsage?.percent) ?? (contextTokens ? (contextTokens / contextWindow) * 100 : null)
          }
        : undefined
    };
  }

  private extractUsageSummary(raw: unknown): UsageSummary {
    const empty: UsageSummary = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      hasUsage: false
    };
    if (!raw || typeof raw !== "object") return empty;

    const source = raw as Record<string, unknown>;
    const usage = source.usage && typeof source.usage === "object" ? source.usage as Record<string, unknown> : undefined;
    if (!usage) return empty;

    const input = toNumber(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens) ?? 0;
    const output = toNumber(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens) ?? 0;
    const cacheRead = toNumber(usage.cacheRead ?? usage.cache_read ?? usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cachedTokens ?? usage.cached_tokens) ?? 0;
    const cacheWrite = toNumber(usage.cacheWrite ?? usage.cache_write ?? usage.cacheWriteTokens ?? usage.cache_write_tokens) ?? 0;
    const total = toNumber(usage.totalTokens ?? usage.total_tokens ?? usage.total) ?? input + output + cacheRead + cacheWrite;

    return {
      tokens: { input, output, cacheRead, cacheWrite, total },
      cost: toCostNumber(usage.cost ?? source.cost),
      hasUsage: [input, output, cacheRead, cacheWrite, total].some((value) => value > 0)
    };
  }

  private extractContextWindow(): number | undefined {
    const state = this.lastStateData as Record<string, unknown>;
    const model = state.model && typeof state.model === "object" ? state.model as Record<string, unknown> : undefined;
    return toNumber(model?.contextWindow ?? model?.context_window ?? state.contextWindow ?? state.context_window);
  }

  private messageStatsKey(message: AgentMessage | StreamingMessage, fallback = "streaming"): string {
    const source = message as Record<string, unknown>;
    if (typeof source.responseId === "string") return `response:${source.responseId}`;
    if (typeof source.id === "string") return `id:${source.id}`;
    if (typeof source.timestamp === "number") return `timestamp:${source.timestamp}:${source.role ?? ""}`;
    return fallback;
  }

  private extractContentBlocks(raw: unknown): { content: ContentBlock[]; details?: JsonValue } | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const obj = raw as Record<string, unknown>;
    const content = Array.isArray(obj.content) ? obj.content.map((c: unknown) => {
      if (c && typeof c === "object") {
        const block = c as Record<string, unknown>;
        return { type: String(block.type ?? "text"), ...block } as ContentBlock;
      }
      return { type: "text", text: String(c) } satisfies ContentBlock;
    }) : [];
    return { content, details: obj.details as JsonValue | undefined };
  }

  private normalizeStreamingMessage(raw: unknown): StreamingMessage | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const message = raw as StreamingMessage & { content?: unknown };
    return {
      ...message,
      content: this.normalizeContentBlocks(message.content)
    };
  }

  private normalizeContentBlocks(raw: unknown): ContentBlock[] {
    if (typeof raw === "string") return [{ type: "text", text: raw }];
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      if (typeof item === "string") return { type: "text", text: item } satisfies ContentBlock;
      if (!item || typeof item !== "object") return { type: "text", text: String(item) } satisfies ContentBlock;
      const block = item as Record<string, unknown>;
      if (block.type === "toolCall") {
        const args = (block.arguments ?? block.input ?? null) as JsonValue;
        return {
          ...block,
          type: "toolCall",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: args,
          arguments: args
        } as ContentBlock;
      }
      return { type: String(block.type ?? "text"), ...block } as ContentBlock;
    });
  }

  private applyActivityEvent(event: PiRpcEvent): void {
    const base = { id: `${Date.now()}-${++this.requestCounter}`, timestamp: Date.now() };
    if (event.type === "turn_start") {
      this.emit("activity", { ...base, type: "turn_start" });
      return;
    }
    if (event.type === "turn_end") {
      this.emit("activity", {
        ...base,
        type: "turn_end",
        message: event.message as AgentMessage | undefined,
        toolResults: Array.isArray(event.toolResults) ? event.toolResults as AgentMessage[] : undefined
      });
      return;
    }
    if (event.type === "thinking_level_changed") {
      const level = typeof event.level === "string" ? event.level : "";
      this.lastStateData = { ...this.lastStateData, thinkingLevel: level };
      this.emitState();
      this.emit("activity", { ...base, type: "thinking_level_changed", level });
      return;
    }
    if (event.type === "session_info_changed") {
      const name = typeof event.name === "string" ? event.name : undefined;
      this.lastStateData = { ...this.lastStateData, sessionName: name };
      this.emitState();
      this.emit("activity", { ...base, type: "session_info_changed", name });
      return;
    }
    if (event.type === "auto_retry_start") {
      this.emit("activity", {
        ...base,
        type: "auto_retry_start",
        attempt: Number(event.attempt ?? 0),
        maxAttempts: Number(event.maxAttempts ?? 0),
        delayMs: Number(event.delayMs ?? 0),
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : ""
      });
      return;
    }
    if (event.type === "auto_retry_end") {
      this.emit("activity", {
        ...base,
        type: "auto_retry_end",
        success: Boolean(event.success),
        attempt: Number(event.attempt ?? 0),
        finalError: typeof event.finalError === "string" ? event.finalError : undefined
      });
      return;
    }
    if (event.type === "extension_ui_request") {
      this.emit("activity", {
        ...base,
        type: "extension_ui_request",
        method: String(event.method ?? ""),
        title: typeof event.title === "string" ? event.title : undefined,
        message: typeof event.message === "string" ? event.message : undefined,
        notifyType: typeof event.notifyType === "string" ? event.notifyType : undefined,
        statusKey: typeof event.statusKey === "string" ? event.statusKey : undefined,
        statusText: typeof event.statusText === "string" ? event.statusText : undefined,
        widgetKey: typeof event.widgetKey === "string" ? event.widgetKey : undefined,
        widgetLines: Array.isArray(event.widgetLines) ? event.widgetLines.map(String) : undefined,
        widgetPlacement: typeof event.widgetPlacement === "string" ? event.widgetPlacement : undefined,
        text: typeof event.text === "string" ? event.text : undefined,
        options: Array.isArray(event.options) ? event.options.map(String) : undefined,
        timeout: typeof event.timeout === "number" ? event.timeout : undefined
      });
      return;
    }
    if (event.type === "extension_error") {
      this.emit("activity", {
        ...base,
        type: "extension_error",
        extensionPath: typeof event.extensionPath === "string" ? event.extensionPath : undefined,
        event: typeof event.event === "string" ? event.event : undefined,
        error: typeof event.error === "string" ? event.error : JSON.stringify(event.error)
      });
    }
  }

  private setError(message: string): void {
    this.lastError = message;
    if (this.listenerCount("error") > 0) {
      this.emit("error", new Error(message));
    }
    this.emitState();
  }

  private emitState(): void {
    this.emit("state", this.getState());
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function stripAnsi(text: string): string {
  // Strip SGR (Select Graphic Rendition) sequences: ESC[ param ; param m
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\]133;[ABC]\x07/g, "");
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toCostNumber(value: unknown): number {
  if (typeof value === "object" && value !== null) {
    const cost = value as Record<string, unknown>;
    return toNumber(cost.total) ?? toNumber(cost.amount) ?? 0;
  }
  return toNumber(value) ?? 0;
}

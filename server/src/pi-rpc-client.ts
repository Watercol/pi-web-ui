import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ActivityEvent, AgentMessage, ContentBlock, JsonValue, PiRpcCommand, PiRpcEvent, PiRpcResponse, PiState, QueueState, StreamingMessage, ToolExecutionEvent } from "../../shared/src/index.js";
import { buildPiArgs, type ServerConfig } from "./config.js";
import { JsonlParser } from "./jsonl.js";

type PendingRequest = {
  resolve: (value: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
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
      lastError: this.lastError
    };
  }

  getMessages(): AgentMessage[] {
    return this.messages;
  }

  async refreshState(): Promise<PiState> {
    const response = await this.request("get_state");
    if (response.success && response.data && typeof response.data === "object") {
      this.lastStateData = response.data as Partial<PiState>;
      this.emitState();
    }
    return this.getState();
  }

  async refreshMessages(): Promise<AgentMessage[]> {
    const response = await this.request("get_messages");
    if (response.success && response.data && typeof response.data === "object") {
      const data = response.data as { messages?: AgentMessage[] };
      this.messages = Array.isArray(data.messages) ? data.messages : [];
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
      if (Array.isArray(messages)) {
        this.messages = messages;
      } else {
        void this.refreshMessages().catch(() => undefined);
      }
      this.emitState();
      this.emit("agentEnd", messages, Boolean(event.willRetry));
    } else if (event.type === "message_start") {
      const msg = this.normalizeStreamingMessage(event.message);
      if (msg) this.emit("messageStart", msg);
    } else if (event.type === "message_update" || event.type === "message_partial") {
      const msg = this.normalizeStreamingMessage((event as { message?: unknown }).message);
      if (msg) this.emit("messageUpdate", msg);
    } else if (event.type === "message_end") {
      const msg = this.normalizeStreamingMessage((event as { message?: unknown }).message);
      if (msg) this.emit("messageEnd", msg);
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

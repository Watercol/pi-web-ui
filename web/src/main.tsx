import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CircleStop, RefreshCcw, SendHorizontal, Terminal, Wrench, Monitor, FileCode, AlertTriangle, Loader2, ChevronDown, ChevronRight, Info, RotateCcw, Bell } from "lucide-react";
import type { ActivityEvent, AgentMessage, JsonValue, PiRpcEvent, PiState, ServerEvent, StreamingMessage, ToolExecutionEvent, ContentBlock, QueueState } from "../../shared/src/index.js";
import { marked } from "marked";
import "./styles.css";

type TimelineItem =
  | { kind: "message"; message: AgentMessage }
  | { kind: "toolEvent"; event: ToolExecutionEvent }
  | { kind: "activity"; event: ActivityEvent };

// ============================================================================
// State helpers
// ============================================================================
const emptyState: PiState = {
  cwd: "",
  piBin: "",
  model: null,
  isStreaming: false,
  processRunning: false
};

// ============================================================================
// Markdown renderer
// ============================================================================
marked.setOptions({ gfm: true, breaks: false });

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ============================================================================
// App root
// ============================================================================
function App() {
  const [state, setState] = useState<PiState>(emptyState);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [connected, setConnected] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const isStreamingRef = useRef(false);
  const composingRef = useRef(false);

  // --- streaming state ---
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage | undefined>();
  const [toolEvents, setToolEvents] = useState<ToolExecutionEvent[]>([]);
  const [queueState, setQueueState] = useState<QueueState>({ steering: [], followUp: [] });
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactionMessage, setCompactionMessage] = useState<string | undefined>();
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  const pushActivity = (event: ActivityEvent) => {
    setActivityEvents((prev) => [...prev, event].slice(-40));
  };

  // SSE
  useEffect(() => {
    void fetchState();
    void fetchMessages();

    const source = new EventSource("/api/events");
    source.onopen = () => {
      setConnected(true);
      setError(undefined);
    };
    source.onerror = () => {
      setConnected(false);
      setError("Event stream disconnected");
    };
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      switch (event.type) {
        case "state":
          setState(event.state);
          isStreamingRef.current = event.state.isStreaming;
          break;
        case "messages":
          setMessages(event.messages);
          break;
        case "error":
          setError(event.message);
          break;
        case "connected":
          setConnected(true);
          break;
        case "pi_event":
          if (isUnknownDisplayEvent(event.event)) {
            pushActivity({
              id: `unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              type: "unknown",
              timestamp: Date.now(),
              event: event.event
            });
          }
          break;
        case "activity":
          if (shouldDisplayActivity(event.event)) pushActivity(event.event);
          break;

        // --- streaming events ---
        case "agent_start":
          isStreamingRef.current = true;
          setStreamingMessage(undefined);
          setIsCompacting(false);
          setCompactionMessage(undefined);
          break;
        case "agent_end":
          isStreamingRef.current = false;
          setStreamingMessage(undefined);
          if (event.willRetry) {
            pushActivity({
              id: `retry-pending-${Date.now()}`,
              type: "unknown",
              timestamp: Date.now(),
              event: { type: "agent_end", willRetry: true }
            });
          }
          break;

        case "message_start":
          // Skip toolResult messages — they're already shown via ToolExecutionBubble
          if (event.message.role === "toolResult") break;
          setStreamingMessage(event.message);
          break;
        case "message_update":
          setStreamingMessage(event.message);
          // Pre-create tool execution entries for any toolCall blocks not yet tracked
          for (const block of event.message.content) {
            if (block.type === "toolCall" && block.id) {
              setToolEvents((prev) => appendToolEvent(prev, {
                toolCallId: String(block.id),
                toolName: String(block.name || "unknown"),
                args: (block.arguments ?? block.input ?? undefined) as JsonValue | undefined,
                timestamp: Date.now(),
                status: "pending"
              }));
            }
          }
          break;
        case "message_end":
          // Only persist assistant/system messages; user is added by sendPrompt(),
          // toolResult is shown via ToolExecutionBubble
          if (event.message.role === "assistant" || event.message.role === "compactionSummary" || event.message.role === "branchSummary" || event.message.role === "custom" || event.message.role === "bashExecution") {
            setMessages((prev) => [...prev, event.message as unknown as AgentMessage]);
          }
          setStreamingMessage(undefined);
          break;

        case "tool_start":
          setToolEvents((prev) => appendToolEvent(prev, { ...event.event, timestamp: Date.now(), status: "running" }));
          break;
        case "tool_update":
          setToolEvents((prev) => appendToolEvent(prev, { ...event.event, timestamp: Date.now(), status: "running" }));
          break;
        case "tool_end":
          setToolEvents((prev) => appendToolEvent(prev, { ...event.event, timestamp: Date.now(), status: "complete" }));
          break;

        case "compaction_start":
          setIsCompacting(true);
          setCompactionMessage(event.reason ? `Compacting (${event.reason})...` : "Compacting context...");
          break;
        case "compaction_end":
          setIsCompacting(false);
          setCompactionMessage(event.aborted ? "Compaction cancelled" : event.errorMessage ? `Compaction failed: ${event.errorMessage}` : event.summary ? "Context compacted" : undefined);
          break;

        case "queue_update":
          setQueueState(event.queue);
          break;
      }
    };
    return () => source.close();
  }, []);

  // Auto-scroll when messages or streaming content changes
  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamingMessage, toolEvents, activityEvents, isCompacting]);

  // Merge all event streams into a single chronological timeline
  const timeline = useMemo((): TimelineItem[] => {
    const items: TimelineItem[] = [];
    for (const message of messages) {
      items.push({ kind: "message", message });
    }
    for (const tool of toolEvents) {
      items.push({ kind: "toolEvent", event: tool });
    }
    for (const event of activityEvents) {
      items.push({ kind: "activity", event });
    }
    return items.sort((a, b) => {
      const ta = timelineTimestamp(a) ?? 0;
      const tb = timelineTimestamp(b) ?? 0;
      return ta - tb;
    });
  }, [messages, toolEvents, activityEvents]);

  async function fetchState() {
    const response = await fetch("/api/state");
    const nextState = (await response.json()) as PiState;
    isStreamingRef.current = nextState.isStreaming;
    setState(nextState);
  }

  async function fetchMessages() {
    const response = await fetch("/api/messages");
    setMessages((await response.json()) as AgentMessage[]);
  }

  async function sendPrompt() {
    const message = draft.trim();
    if (!message || state.isStreaming) return;
    setDraft("");
    setError(undefined);
    setMessages((prev) => [...prev, { role: "user", content: message, timestamp: Date.now() }]);
    shouldStickToBottomRef.current = true;
    const response = await fetch("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error || `Prompt failed with HTTP ${response.status}`);
    }
  }

  function handleMessageListScroll() {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 96;
  }

  async function abort() {
    setError(undefined);
    const response = await fetch("/api/abort", { method: "POST" });
    if (!response.ok) setError(`Abort failed with HTTP ${response.status}`);
  }

  const modelLabel = useMemo(() => {
    const model = state.model;
    if (!model) return "No model";
    return model.displayName || model.name || model.id || JSON.stringify(model);
  }, [state.model]);

  const queueCount = queueState.steering.length + queueState.followUp.length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Terminal size={20} />
          <div>
            <h1>Pi Web UI</h1>
            <p>{state.cwd || "Loading workspace"}</p>
          </div>
        </div>
        <div className="status-grid">
          <Status label="RPC" value={state.processRunning ? "running" : "stopped"} tone={state.processRunning ? "ok" : "bad"} />
          <Status label="SSE" value={connected ? "connected" : "offline"} tone={connected ? "ok" : "bad"} />
          <Status label="Model" value={modelLabel} />
          <Status label="Session" value={state.sessionName || state.sessionId || "new"} />
          <Status label="Thinking" value={state.thinkingLevel || "default"} />
          <Status label="Stream" value={state.isStreaming ? "streaming" : "idle"} tone={state.isStreaming ? "hot" : "ok"} />
        </div>
      </header>

      {(error || state.lastError) && <div className="error-bar">{error || state.lastError}</div>}

      {queueCount > 0 && (
        <div className="queue-bar">
          {queueState.steering.length > 0 && <span>{queueState.steering.length} steering</span>}
          {queueState.followUp.length > 0 && <span>{queueState.followUp.length} follow-up</span>}
        </div>
      )}

      <section ref={listRef} className="message-list" aria-live="polite" onScroll={handleMessageListScroll}>
        {timeline.length === 0 && !streamingMessage ? (
          <div className="empty-state">Start a Pi RPC chat in {state.cwd || "this workspace"}.</div>
        ) : (
          <>
            {timeline.map((item, i) => {
              if (item.kind === "message") {
                return <MessageBubble key={item.message.id || i} message={item.message} />;
              }
              if (item.kind === "toolEvent") {
                return <ToolExecutionBubble key={`${item.event.toolCallId}-${i}`} tool={item.event} />;
              }
              return <ActivityBubble key={item.event.id} event={item.event} />;
            })}

            {streamingMessage && streamingMessage.role === "assistant" && (
              <StreamingAssistantBubble message={streamingMessage} />
            )}

            {isCompacting && (
              <div className="compaction-notice">
                <Loader2 size={14} className="spinner" />
                <span>{compactionMessage || "Compacting context..."}</span>
              </div>
            )}
          </>
        )}
      </section>

      <footer className="composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
              event.preventDefault();
              void sendPrompt();
            }
          }}
          placeholder="Send a prompt to Pi"
          disabled={!state.processRunning}
        />
        {state.isStreaming ? (
          <button type="button" className="abort" onClick={() => void abort()} title="Abort current Pi operation">
            <CircleStop size={18} />
            Abort
          </button>
        ) : (
          <button type="button" onClick={() => void sendPrompt()} disabled={!draft.trim() || !state.processRunning} title="Send prompt">
            <SendHorizontal size={18} />
            Send
          </button>
        )}
        <button type="button" className="icon-button" onClick={() => void Promise.all([fetchState(), fetchMessages()])} title="Refresh state">
          <RefreshCcw size={18} />
        </button>
      </footer>
    </main>
  );
}

// ============================================================================
// Status badge
// ============================================================================
function Status({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" | "hot" }) {
  return (
    <div className={`status ${tone || ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// ============================================================================
// Message router
// ============================================================================
function MessageBubble({ message }: { message: AgentMessage }) {
  const role = message.role || message.type || "message";

  switch (role) {
    case "user":
      return <UserBubble message={message} />;
    case "assistant":
      return <AssistantBubble message={message} />;
    case "bashExecution":
      return <BashBubble message={message} />;
    case "toolResult":
      return <ToolResultBubble message={message} />;
    case "compactionSummary":
      return <CompactionSummaryBubble message={message} />;
    case "branchSummary":
      return <BranchSummaryBubble message={message} />;
    case "custom":
      return <CustomBubble message={message} />;
    default:
      return <GenericBubble message={message} />;
  }
}

// ============================================================================
// User message
// ============================================================================
function UserBubble({ message }: { message: AgentMessage }) {
  const text = extractText(message);
  return (
    <article className="message user">
      <div className="message-role">You</div>
      <div className="message-body">{text}</div>
    </article>
  );
}

// ============================================================================
// Assistant message (completed)
// ============================================================================
function AssistantBubble({ message }: { message: AgentMessage }) {
  const contentBlocks = extractContentBlocks(message);
  const [showThinking, setShowThinking] = useState(false);

  const textBlocks = contentBlocks.filter((b) => b.type === "text");
  const thinkingBlocks = contentBlocks.filter((b) => b.type === "thinking");
  const imageBlocks = contentBlocks.filter((b) => b.type === "image");
  const otherBlocks = contentBlocks.filter((b) => !["text", "thinking", "toolCall", "image"].includes(b.type));

  return (
    <article className="message assistant">
      <div className="message-role">
        <Monitor size={12} />
        Assistant
        {String(message.stopReason) === "aborted" && <span className="badge badge-warn">Aborted</span>}
        {String(message.stopReason) === "error" && <span className="badge badge-error">Error</span>}
      </div>
      <div className="message-body">
        {thinkingBlocks.length > 0 && (
          <div className="thinking-section">
            <button className="thinking-toggle" onClick={() => setShowThinking(!showThinking)}>
              {showThinking ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {showThinking ? "Hide thinking" : `Thinking (${thinkingBlocks.length} block${thinkingBlocks.length > 1 ? "s" : ""})`}
            </button>
            {showThinking && (
              <div className="thinking-content">
                {thinkingBlocks.map((b, i) => (
                  <pre key={i}>{b.thinking}</pre>
                ))}
              </div>
            )}
          </div>
        )}
        {textBlocks.map((b, i) => (
          <Markdown key={i} text={b.text || ""} />
        ))}
        {imageBlocks.length > 0 && <ResultContent blocks={imageBlocks} />}
        {otherBlocks.length > 0 && <ResultContent blocks={otherBlocks} />}
        {message.errorMessage && String(message.stopReason) !== "aborted" && (
          <div className="assistant-error">Error: {String(message.errorMessage)}</div>
        )}
      </div>
    </article>
  );
}

// ============================================================================
// Streaming assistant message
// ============================================================================
function StreamingAssistantBubble({ message }: { message: StreamingMessage }) {
  const [showThinking, setShowThinking] = useState(false);

  const textBlocks = message.content.filter((b) => b.type === "text");
  const thinkingBlocks = message.content.filter((b) => b.type === "thinking");
  const imageBlocks = message.content.filter((b) => b.type === "image");
  const otherBlocks = message.content.filter((b) => !["text", "thinking", "toolCall", "image"].includes(b.type));
  const hasToolCalls = message.content.some((b) => b.type === "toolCall");

  return (
    <article className={`message assistant streaming${hasToolCalls ? " has-tools" : ""}`}>
      <div className="message-role">
        <Loader2 size={12} className="spinner" />
        Assistant streaming...
        {message.stopReason === "aborted" && <span className="badge badge-warn">Aborted</span>}
        {message.stopReason === "error" && <span className="badge badge-error">Error</span>}
      </div>
      <div className="message-body">
        {thinkingBlocks.length > 0 && (
          <div className="thinking-section">
            <button className="thinking-toggle" onClick={() => setShowThinking(!showThinking)}>
              {showThinking ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {showThinking ? "Hide thinking" : `Thinking (${thinkingBlocks.length} block${thinkingBlocks.length > 1 ? "s" : ""})`}
            </button>
            {showThinking && (
              <div className="thinking-content">
                {thinkingBlocks.map((b, i) => (
                  <pre key={i}>{b.thinking}</pre>
                ))}
              </div>
            )}
          </div>
        )}
        {textBlocks.map((b, i) => (
          <Markdown key={i} text={b.text || ""} />
        ))}
        {imageBlocks.length > 0 && <ResultContent blocks={imageBlocks} />}
        {otherBlocks.length > 0 && <ResultContent blocks={otherBlocks} />}
        {!hasToolCalls && message.stopReason === "aborted" && (
          <div className="assistant-error">{message.errorMessage || "Operation aborted"}</div>
        )}
        {!hasToolCalls && message.stopReason === "error" && (
          <div className="assistant-error">Error: {message.errorMessage || "Unknown error"}</div>
        )}
      </div>
    </article>
  );
}

// ============================================================================
// Tool execution bubble
// ============================================================================
function ToolExecutionBubble({ tool }: { tool: ToolExecutionEvent }) {
  const ss = tool.status;
  const hasResult = !!(tool.result || tool.partialResult);
  const isPending = ss === "pending";
  const isRunning = ss === "running" || (!ss && hasResult && !tool.result);
  const isDone = ss === "complete" || (!ss && !!tool.result);
  const tone = tool.isError ? "error" : isDone ? "success" : isRunning ? "pending" : "pending";

  return (
    <article className={`message tool-execution ${tone}`}>
      <div className="message-role">
        {isRunning ? <Loader2 size={12} className="spinner" /> : isPending ? <Loader2 size={12} /> : <Wrench size={12} />}
        {tool.toolName}
        {isPending && <span className="badge badge-muted">preparing</span>}
        {isRunning && <span className="badge badge-pending">running</span>}
        {tool.isError && <span className="badge badge-error">error</span>}
        {isDone && !tool.isError && <span className="badge badge-ok">done</span>}
      </div>
      <div className="message-body">
        {tool.args && <ToolArgsTable args={tool.args} />}
        {hasResult && <ToolResultDetails blocks={tool.result?.content || tool.partialResult?.content || []} isPartial={isRunning} />}
      </div>
    </article>
  );
}

function ToolResultDetails({ blocks, isPartial }: { blocks: ContentBlock[]; isPartial?: boolean }) {
  const text = summarizeContentBlocks(blocks);
  return (
    <details className="tool-result">
      <summary>{isPartial ? "Streaming output" : text || "Result details"}</summary>
      <ResultContent blocks={blocks} />
    </details>
  );
}

function ResultContent({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === "text") {
          return <pre key={i}>{block.text}</pre>;
        }
        if (block.type === "image") {
          return <img key={i} src={`data:${block.mimeType};base64,${block.data}`} alt="Tool output image" className="tool-image" />;
        }
        if (block.type === "toolCall") {
          return <ToolCallList key={i} blocks={[block]} />;
        }
        return <pre key={i}>{JSON.stringify(block, null, 2)}</pre>;
      })}
    </>
  );
}

function ToolCallList({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="tool-call-list">
      {blocks.map((block, index) => {
        const args = "input" in block ? block.input : "arguments" in block ? block.arguments : null;
        return (
          <details key={`${block.id || index}`} className="tool-call-block">
            <summary>
              <Wrench size={12} />
              Tool call: {block.name || "unknown"}
            </summary>
            {args != null ? <ToolArgsTable args={args as JsonValue} /> : <pre className="tool-args-empty">(no arguments)</pre>}
          </details>
        );
      })}
    </div>
  );
}

// ============================================================================
// Tool arguments: key-value layout
// ============================================================================
function ToolArgsTable({ args }: { args: JsonValue }) {
  if (typeof args === "string") return <pre className="tool-args-pre">{args}</pre>;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return <pre className="tool-args-pre">{JSON.stringify(args, null, 2)}</pre>;
  }
  const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return <pre className="tool-args-empty">(no arguments)</pre>;
  return (
    <div className="tool-args-wrap">
      <div className="tool-args-label">Arguments</div>
      <div className="tool-args-rows">
        {entries.map(([key, value]) => (
          <div key={key} className="tool-arg-row">
            <span className="tool-arg-key">{key}</span>
            <span className="tool-arg-val">
              <ArgValue value={value} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArgValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="arg-nil">—</span>;
  if (typeof value === "boolean") return <span className="arg-bool">{value ? "true" : "false"}</span>;
  if (typeof value === "number") return <span className="arg-number">{value}</span>;
  if (typeof value === "string") {
    const title = value.length > 80 ? value : undefined;
    const display = value.length > 60 ? `…${value.slice(-57)}` : value;
    return <span className="arg-string" title={title}>{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="arg-nil">[]</span>;
    if (value.every((v) => typeof v === "string")) {
      return <span className="arg-strings">{value.join(", ")}</span>;
    }
    return <span className="arg-raw">{JSON.stringify(value)}</span>;
  }
  // nested object — show compact
  return <span className="arg-raw">{JSON.stringify(value)}</span>;
}

function ActivityBubble({ event }: { event: ActivityEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const meta = `${time}`;

  if (event.type === "thinking_level_changed") {
    return <NoticeBubble icon={<Info size={12} />} label="Thinking" text={`Thinking level set to ${event.level || "default"}`} meta={meta} />;
  }
  if (event.type === "session_info_changed") {
    return <NoticeBubble icon={<Info size={12} />} label="Session" text={event.name ? `Session renamed to ${event.name}` : "Session name cleared"} meta={meta} />;
  }
  if (event.type === "auto_retry_start") {
    return <NoticeBubble icon={<RotateCcw size={12} className="spinner-slow" />} label="Retry" text={`Retry ${event.attempt}/${event.maxAttempts} in ${formatMs(event.delayMs)}: ${event.errorMessage}`} meta={meta} tone="warn" />;
  }
  if (event.type === "auto_retry_end") {
    return <NoticeBubble icon={<RotateCcw size={12} />} label="Retry" text={event.success ? `Retry ${event.attempt} succeeded` : `Retry ${event.attempt} failed${event.finalError ? `: ${event.finalError}` : ""}`} meta={meta} tone={event.success ? "ok" : "error"} />;
  }
  if (event.type === "extension_ui_request") {
    return <ExtensionUiBubble event={event} meta={meta} />;
  }
  if (event.type === "extension_error") {
    return <NoticeBubble icon={<AlertTriangle size={12} />} label="Extension" text={`${event.extensionPath || "Extension"} failed${event.event ? ` during ${event.event}` : ""}: ${event.error || "Unknown error"}`} meta={meta} tone="error" />;
  }
  if (event.type === "unknown") return <RawEventBubble event={event.event} meta={meta} />;
  return <RawEventBubble event={{ type: event.type } as PiRpcEvent} meta={meta} />;
}

function NoticeBubble({ icon, label, text, meta, tone }: { icon: React.ReactNode; label: string; text: string; meta: string; tone?: "ok" | "warn" | "error" }) {
  return (
    <article className={`message activity ${tone || ""}`}>
      <div className="message-role">
        {icon}
        {label}
        <span className="activity-time">{meta}</span>
      </div>
      <div className="message-body">{text}</div>
    </article>
  );
}

function ExtensionUiBubble({ event, meta }: { event: Extract<ActivityEvent, { type: "extension_ui_request" }>; meta: string }) {
  const label = event.method === "notify" ? "Notification" : `Extension UI: ${event.method}`;
  const rawText = event.message || event.title || event.statusText || event.text || event.widgetLines?.join("\n") || event.statusKey || event.widgetKey || "Extension UI update";
  const text = stripAnsiDisplay(rawText);
  const tone = event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warn" : undefined;
  return (
    <article className={`message activity extension ${tone || ""}`}>
      <div className="message-role">
        <Bell size={12} />
        {label}
        <span className="activity-time">{meta}</span>
      </div>
      <div className="message-body">
        <div>{text}</div>
        {event.options && event.options.length > 0 && (
          <div className="option-list">
            {event.options.map((option) => <span key={option}>{option}</span>)}
          </div>
        )}
      </div>
    </article>
  );
}

function RawEventBubble({ event, meta }: { event: PiRpcEvent; meta: string }) {
  return (
    <details className="message activity raw">
      <summary className="message-role">
        <Info size={12} />
        {event.type || "Pi event"}
        <span className="activity-time">{meta}</span>
      </summary>
      <pre>{JSON.stringify(event, null, 2)}</pre>
    </details>
  );
}

// ============================================================================
// Bash execution bubble
// ============================================================================
function BashBubble({ message }: { message: AgentMessage }) {
  const command = message.command as string || "";
  const output = message.output as string || "";
  const exitCode = message.exitCode as number | null | undefined;
  const cancelled = Boolean(message.cancelled);
  const truncated = Boolean(message.truncated);
  const excludeFromContext = Boolean(message.excludeFromContext);

  const tone = cancelled ? "cancelled" : exitCode != null && exitCode !== 0 ? "error" : "success";

  return (
    <article className={`message bash-execution ${tone}${excludeFromContext ? " excluded" : ""}`}>
      <div className="message-role">
        <FileCode size={12} />
        Bash
        {cancelled && <span className="badge badge-warn">cancelled</span>}
        {!cancelled && exitCode != null && exitCode !== 0 && <span className="badge badge-error">exit {exitCode}</span>}
        {!cancelled && exitCode === 0 && <span className="badge badge-ok">done</span>}
        {excludeFromContext && <span className="badge badge-muted">excluded</span>}
      </div>
      <div className="message-body">
        <div className="bash-command"><code>$ {command}</code></div>
        {output && <pre className="bash-output">{output}</pre>}
        {truncated && message.fullOutputPath && (
          <div className="bash-truncated">Output truncated. Full output: {message.fullOutputPath as string}</div>
        )}
      </div>
    </article>
  );
}

// ============================================================================
// Tool result bubble (rendered after the assistant message that made the calls)
// ============================================================================
function ToolResultBubble({ message }: { message: AgentMessage }) {
  const content = extractContentBlocks(message);
  const toolName = typeof message.toolName === "string" ? message.toolName : "Tool";
  const isError = Boolean(message.isError);
  return (
    <article className={`message tool-result ${isError ? "error" : ""}`}>
      <div className="message-role">
        <Wrench size={12} />
        {toolName}
        <span className={`badge ${isError ? "badge-error" : "badge-ok"}`}>{isError ? "error" : "done"}</span>
      </div>
      <div className="message-body">
        <ToolResultDetails blocks={content} />
      </div>
    </article>
  );
}

// ============================================================================
// Compaction summary bubble
// ============================================================================
function CompactionSummaryBubble({ message }: { message: AgentMessage }) {
  const summary = message.summary as string || "";
  return (
    <article className="message compaction-summary">
      <div className="message-role">
        <AlertTriangle size={12} />
        Context Compaction
      </div>
      <div className="message-body">
        <p>Previous conversation was compacted to save context space.</p>
        {summary && <pre className="compaction-detail">{summary}</pre>}
      </div>
    </article>
  );
}

// ============================================================================
// Branch summary bubble
// ============================================================================
function BranchSummaryBubble({ message }: { message: AgentMessage }) {
  const summary = message.summary as string || "";
  return (
    <article className="message branch-summary">
      <div className="message-role">Branch Return</div>
      <div className="message-body">
        <p>Returned from branch conversation.</p>
        {summary && <pre className="compaction-detail">{summary}</pre>}
      </div>
    </article>
  );
}

// ============================================================================
// Custom message bubble
// ============================================================================
function CustomBubble({ message }: { message: AgentMessage }) {
  const display = message.display as string || message.customType as string || "Custom";
  const text = extractText(message);
  return (
    <article className="message custom">
      <div className="message-role">{display}</div>
      <div className="message-body">
        <pre>{text}</pre>
      </div>
    </article>
  );
}

// ============================================================================
// Generic fallback
// ============================================================================
function GenericBubble({ message }: { message: AgentMessage }) {
  const role = message.role || message.type || "message";
  const text = extractText(message);
  return (
    <article className="message">
      <div className="message-role">{role}</div>
      <div className="message-body">
        <pre>{text}</pre>
      </div>
    </article>
  );
}

// ============================================================================
// Helpers
// ============================================================================
function extractText(message: AgentMessage): string {
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

function extractContentBlocks(message: AgentMessage): ContentBlock[] {
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
          return { type: "toolCall", name: block.name, id: block.id, input: (block.input as JsonValue) ?? null } satisfies ContentBlock;
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

function shouldDisplayActivity(event: ActivityEvent): boolean {
  return event.type !== "turn_start" && event.type !== "turn_end";
}

function summarizeContentBlocks(blocks: ContentBlock[]): string {
  const firstText = blocks.find((block) => block.type === "text" && block.text?.trim());
  if (firstText?.text) {
    const compact = firstText.text.replace(/\s+/g, " ").trim();
    return compact.length > 96 ? `${compact.slice(0, 96)}...` : compact;
  }
  if (blocks.some((block) => block.type === "image")) return "Image result";
  if (blocks.length > 0) return `${blocks.length} result block${blocks.length === 1 ? "" : "s"}`;
  return "";
}

function timelineTimestamp(item: TimelineItem): number | undefined {
  if (item.kind === "message") return item.message.timestamp as number | undefined;
  if (item.kind === "toolEvent") return item.event.timestamp;
  return item.event.timestamp;
}

function appendToolEvent(current: ToolExecutionEvent[], event: ToolExecutionEvent): ToolExecutionEvent[] {
  const idx = current.findIndex((existing) => existing.toolCallId === event.toolCallId);
  if (idx >= 0) {
    const updated = [...current];
    updated[idx] = { ...current[idx], ...event };
    return updated;
  }
  return [...current, event];
}

function isUnknownDisplayEvent(event: PiRpcEvent): boolean {
  const shown = new Set(["agent_start", "agent_end", "turn_start", "turn_end",
    "message_start", "message_update", "message_end", "message_complete", "message_partial",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "compaction_start", "compaction_end", "compaction_snapshot",
    "queue_update", "queue_message",
    "thinking_level_changed", "session_info_changed",
    "auto_retry_start", "auto_retry_end", "response", "error"]);
  return !shown.has(event.type) && event.type !== "extension_ui_request";
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stripAnsiDisplay(text: string): string {
  // Strip SGR (Select Graphic Rendition) sequences: ESC[ param ; param m
  // Also handles OSC 133 terminal markers
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\]133;[ABC]\x07/g, "");
}

// ============================================================================
// Bootstrap
// ============================================================================
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

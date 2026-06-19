import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CircleStop, RefreshCcw, SendHorizontal, Terminal, Wrench, Monitor, FileCode, AlertTriangle, Loader2, ChevronDown, ChevronRight, Info, RotateCcw, Bell, Check, Plus } from "lucide-react";
import type { ActivityEvent, AgentMessage, JsonValue, PiModel, PiRpcEvent, PiSessionInfo, PiState, ServerEvent, SessionStats, StreamingMessage, ToolExecutionEvent, ContentBlock, QueueState } from "../../shared/src/index.js";
import { marked } from "marked";
import "./styles.css";

const COMPOSER_MAX_VIEWPORT_RATIO = 0.5;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

function resizeComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  const maxHeight = Math.max(46, window.innerHeight * COMPOSER_MAX_VIEWPORT_RATIO);
  const nextHeight = Math.min(el.scrollHeight, maxHeight);
  el.style.height = `${nextHeight}px`;
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

function modelDisplayName(model: PiModel): string {
  return model.displayName || model.name || model.id || `${model.provider || "model"}`;
}

function modelKey(model: PiModel): string {
  const provider = typeof model.provider === "string" ? model.provider : "";
  const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
  return `${provider}/${id}`;
}

function thinkingLevelLabel(level: string): string {
  return level === "xhigh" ? "X High" : level.charAt(0).toUpperCase() + level.slice(1);
}

function supportedThinkingLevels(model: PiModel | null): ThinkingLevel[] {
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

function sessionDisplayName(session: PiSessionInfo): string {
  return session.name || session.firstMessage || session.id || "New session";
}

function formatRelativeTime(value: string): string {
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

type TimelineItem =
  | { kind: "message"; message: AgentMessage }
  | { kind: "trace"; trace: ExecutionTrace }
  | { kind: "toolEvent"; event: ToolExecutionEvent }
  | { kind: "toolGroup"; events: { kind: "toolEvent"; event: ToolExecutionEvent }[] }
  | { kind: "activity"; event: ActivityEvent };

type ExecutionTrace = {
  id: string;
  entries: TraceEntry[];
  active?: boolean;
};

type TraceEntry =
  | { kind: "thinking"; block: ContentBlock; key: string }
  | { kind: "tool"; event: ToolExecutionEvent; key: string };

type ExtensionStatus = {
  key: string;
  text: string;
  title?: string;
  timestamp: number;
};

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
  const [displayStats, setDisplayStats] = useState<SessionStats | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const isStreamingRef = useRef(false);
  const composingRef = useRef(false);
  const lastStreamUpdateRef = useRef(0);
  const lastTraceShapeRef = useRef("");
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);

  const MAX_VISIBLE_MESSAGES = 1000;

  // --- streaming state ---
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage | undefined>();
  const [toolEvents, setToolEvents] = useState<ToolExecutionEvent[]>([]);
  const [queueState, setQueueState] = useState<QueueState>({ steering: [], followUp: [] });
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactionMessage, setCompactionMessage] = useState<string | undefined>();
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatus[]>([]);
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [switchingModelKey, setSwitchingModelKey] = useState<string | undefined>();
  const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionScope, setSessionScope] = useState<"current" | "all">("current");
  const [switchingSessionPath, setSwitchingSessionPath] = useState<string | undefined>();
  const [creatingSession, setCreatingSession] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [switchingThinkingLevel, setSwitchingThinkingLevel] = useState<string | undefined>();

  const updateExtensionStatus = (event: Extract<ActivityEvent, { type: "extension_ui_request" }>) => {
    const rawText = event.statusText || event.message || event.text || event.title || event.statusKey || "Extension UI update";
    const text = stripAnsiDisplay(rawText).trim();
    if (!text) return;

    const key = event.statusKey || event.widgetKey || event.title || event.method;
    const next: ExtensionStatus = {
      key,
      text,
      title: event.title,
      timestamp: event.timestamp
    };

    setExtensionStatuses((prev) => {
      const idx = prev.findIndex((status) => status.key === key);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = next;
        return updated;
      }
      return [...prev, next].slice(-8);
    });
  };

  const pushActivity = (event: ActivityEvent) => {
    if (event.type === "extension_ui_request" && event.method === "setStatus") {
      updateExtensionStatus(event);
      return;
    }

    // Auto-dismiss successful retry end notices after 5 seconds
    if (event.type === "auto_retry_end" && event.success) {
      setTimeout(() => {
        setActivityEvents((prev) => prev.filter((a) => a.id !== event.id));
      }, 5000);
    }

    setActivityEvents((prev) => {
      // Clean "retry pending" cards (agent_end willRetry) when actual retry flow starts
      let filtered = prev;
      if (event.type === "auto_retry_start") {
        filtered = prev.filter(
          (a) => !(a.type === "unknown" && "willRetry" in (a.event || {}) && (a.event as Record<string, unknown>).willRetry)
        );
      }
      // Replace matching retry start with its end event to keep a single card
      if (event.type === "auto_retry_end") {
        const idx = filtered.findIndex(
          (a) => a.type === "auto_retry_start" && a.attempt === event.attempt
        );
        if (idx >= 0) {
          const updated = [...filtered];
          updated[idx] = event;
          return updated;
        }
      }
      return [...filtered, event].slice(-40);
    });
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
          setDisplayStats((current) => event.state.isStreaming && current ? current : event.state.stats);
          break;
        case "messages":
          setMessages(mergeMessages([], event.messages));
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
          setToolEvents([]);
          lastTraceShapeRef.current = "";
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
          lastTraceShapeRef.current = traceShapeKey(event.message.content);
          setStreamingMessage(event.message);
          break;
        case "message_update":
          // Throttle streaming text updates to ~30fps to avoid excessive re-renders.
          // Trace shape changes are still processed immediately so thinking/tool order stays stable.
          {
            const now = Date.now();
            const needsThrottle = now - lastStreamUpdateRef.current < 32;
            const traceShape = traceShapeKey(event.message.content);
            const traceShapeChanged = traceShape !== lastTraceShapeRef.current;
            // Always process tool calls regardless of throttle
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
            if (!needsThrottle || traceShapeChanged) {
              lastStreamUpdateRef.current = now;
              lastTraceShapeRef.current = traceShape;
              setStreamingMessage(event.message);
            }
          }
          break;
        case "message_end":
          // Only persist assistant/system messages; user is added by sendPrompt(),
          // toolResult is shown via ToolExecutionBubble
          if (event.message.role === "assistant" || event.message.role === "compactionSummary" || event.message.role === "branchSummary" || event.message.role === "custom" || event.message.role === "bashExecution") {
            setMessages((prev) => mergeMessages(prev, [event.message as unknown as AgentMessage]));
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

  useEffect(() => {
    if (!modelMenuOpen && !sessionMenuOpen && !thinkingMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
      if (!sessionMenuRef.current?.contains(event.target as Node)) {
        setSessionMenuOpen(false);
      }
      if (!thinkingMenuRef.current?.contains(event.target as Node)) {
        setThinkingMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModelMenuOpen(false);
        setSessionMenuOpen(false);
        setThinkingMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelMenuOpen, sessionMenuOpen, thinkingMenuOpen]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    resizeComposerTextarea(el);
  }, [draft]);

  useEffect(() => {
    const handleResize = () => {
      const el = textareaRef.current;
      if (el) resizeComposerTextarea(el);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Auto-scroll when messages or streaming content changes
  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamingMessage, toolEvents, activityEvents, isCompacting]);

  // Merge all event streams into a single chronological timeline
  // Cap messages to avoid performance degradation on long sessions
  const timeline = useMemo((): { items: TimelineItem[]; liveItems: TimelineItem[]; truncated: boolean } => {
    const totalMessages = messages.length;
    const visibleMessages = totalMessages > MAX_VISIBLE_MESSAGES
      ? messages.slice(-MAX_VISIBLE_MESSAGES)
      : messages;

    const items: TimelineItem[] = [];
    const liveItems: TimelineItem[] = [];
    // Build a lookup of tool results from toolResult messages, keyed by toolCallId then toolName
    const toolResultMap = new Map<string, ContentBlock[]>();
    const consumedResults = new Set<string>();
    const toolCallKeys = new Set<string>();
    const activeToolMap = new Map<string, ToolExecutionEvent>();
    const consumedActiveTools = new Set<string>();

    for (const tool of toolEvents) {
      if (tool.toolCallId) activeToolMap.set(tool.toolCallId, tool);
    }

    for (const message of visibleMessages) {
      if (message.role === "toolResult") {
        const key = String(message.toolCallId ?? message.toolName ?? "");
        if (key) toolResultMap.set(key, extractContentBlocks(message));
        continue;
      }
      if (message.role === "assistant") {
        for (const block of extractContentBlocks(message)) {
          if (block.type === "toolCall") {
            if (block.id) toolCallKeys.add(String(block.id));
            if (block.name) toolCallKeys.add(String(block.name));
          }
        }
      }
    }

    for (const message of visibleMessages) {
      if (message.role === "toolResult") {
        const key = String(message.toolCallId ?? message.toolName ?? "");
        if (key && (consumedResults.has(key) || toolCallKeys.has(key))) continue;
        items.push({ kind: "message", message });
        continue;
      }

      if (message.role === "assistant") {
        const blocks = extractContentBlocks(message);
        const trace: ExecutionTrace = {
          id: messageKey(message),
          entries: []
        };
        for (const [blockIndex, block] of blocks.entries()) {
          if (block.type === "thinking") {
            trace.entries.push({ kind: "thinking", block, key: `thinking-${blockIndex}` });
          } else if (block.type === "toolCall" && block.id && block.name) {
            const callId = String(block.id);
            const callName = String(block.name);
            const activeTool = activeToolMap.get(callId);
            const resultContent = toolResultMap.get(callId) ?? toolResultMap.get(callName);

            if (resultContent && resultContent.length > 0) {
              consumedResults.add(callId);
              consumedResults.add(callName);
            }

            if (activeTool) {
              consumedActiveTools.add(callId);
              trace.entries.push({ kind: "tool", event: activeTool, key: `tool-${callId}` });
              continue;
            }

            trace.entries.push({ kind: "tool", key: `tool-${callId}`, event: {
                toolCallId: callId,
                toolName: callName,
                args: (block.input ?? block.arguments ?? undefined) as JsonValue | undefined,
                timestamp: message.timestamp as number | undefined,
                status: "complete",
                ...(resultContent && resultContent.length > 0 && { result: { content: resultContent } })
            } });
          }
        }
        if (trace.entries.length > 0) {
          items.push({ kind: "trace", trace });
        }
      }

      if (message.role !== "assistant" || hasAssistantDisplayContent(message)) {
        items.push({ kind: "message", message });
      }
    }

    for (const tool of toolEvents) {
      if (consumedActiveTools.has(tool.toolCallId)) continue;
      liveItems.push({ kind: "toolEvent", event: tool });
    }
    for (const event of activityEvents) {
      liveItems.push({ kind: "activity", event });
    }

    return {
      items: collapseToolGroups(items),
      liveItems: collapseToolGroups(liveItems),
      truncated: totalMessages > MAX_VISIBLE_MESSAGES
    };
  }, [messages, toolEvents, activityEvents]);

  async function fetchState() {
    const response = await fetch("/api/state");
    const nextState = (await response.json()) as PiState;
    isStreamingRef.current = nextState.isStreaming;
    setState(nextState);
    setDisplayStats((current) => nextState.isStreaming && current ? current : nextState.stats);
  }

  async function fetchMessages() {
    const response = await fetch("/api/messages");
    setMessages(mergeMessages([], (await response.json()) as AgentMessage[]));
  }

  async function fetchModels() {
    setModelsLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/models");
      const body = (await response.json().catch(() => ({}))) as { models?: PiModel[]; error?: string };
      if (!response.ok) {
        setError(body.error || `Model list failed with HTTP ${response.status}`);
        return;
      }
      setModels(Array.isArray(body.models) ? body.models : []);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }

  async function toggleModelMenu() {
    setModelMenuOpen((open) => !open);
    if (!modelMenuOpen && models.length === 0 && !modelsLoading) {
      await fetchModels();
    }
  }

  async function switchModel(model: PiModel) {
    const provider = typeof model.provider === "string" ? model.provider : "";
    const modelId = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
    if (!provider || !modelId || switchingModelKey) return;

    setSwitchingModelKey(modelKey(model));
    setError(undefined);
    try {
      const response = await fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, modelId })
      });
      const body = (await response.json().catch(() => ({}))) as { data?: PiModel; error?: string; message?: string };
      if (!response.ok || body.error) {
        setError(body.error || body.message || `Model switch failed with HTTP ${response.status}`);
      } else {
        if (body.data) setState((current) => ({ ...current, model: body.data ?? current.model }));
        setModelMenuOpen(false);
        await fetchState();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingModelKey(undefined);
    }
  }

  async function switchThinkingLevel(level: string) {
    if (switchingThinkingLevel || level === state.thinkingLevel) return;

    setSwitchingThinkingLevel(level);
    setError(undefined);
    try {
      const response = await fetch("/api/thinking-level", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level })
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok || body.error) {
        setError(body.error || body.message || `Thinking level switch failed with HTTP ${response.status}`);
      } else {
        setState((current) => ({ ...current, thinkingLevel: level }));
        setThinkingMenuOpen(false);
        void fetchState();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingThinkingLevel(undefined);
    }
  }

  async function fetchSessions(scope = sessionScope) {
    setSessionsLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions?scope=${encodeURIComponent(scope)}`);
      const body = (await response.json().catch(() => ({}))) as { sessions?: PiSessionInfo[]; error?: string };
      if (!response.ok) {
        setError(body.error || `Session list failed with HTTP ${response.status}`);
        return;
      }
      setSessions(Array.isArray(body.sessions) ? body.sessions : []);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionsLoading(false);
    }
  }

  async function toggleSessionMenu() {
    setSessionMenuOpen((open) => !open);
    if (!sessionMenuOpen && sessions.length === 0 && !sessionsLoading) {
      await fetchSessions();
    }
  }

  async function changeSessionScope(scope: "current" | "all") {
    if (scope === sessionScope) return;
    setSessionScope(scope);
    await fetchSessions(scope);
  }

  async function switchSession(session: PiSessionInfo) {
    if (switchingSessionPath || creatingSession || session.path === state.sessionFile) return;

    setSwitchingSessionPath(session.path);
    setError(undefined);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPath: session.path })
      });
      const body = (await response.json().catch(() => ({}))) as { data?: { cancelled?: boolean }; error?: string; message?: string };
      if (!response.ok || body.error) {
        setError(body.error || body.message || `Session switch failed with HTTP ${response.status}`);
      } else if (!body.data?.cancelled) {
        setSessionMenuOpen(false);
        setStreamingMessage(undefined);
        setToolEvents([]);
        setActivityEvents([]);
        setDisplayStats(undefined);
        await Promise.all([fetchState(), fetchMessages()]);
        void fetchSessions();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitchingSessionPath(undefined);
    }
  }

  async function newSession() {
    if (creatingSession || switchingSessionPath) return;

    setCreatingSession(true);
    setError(undefined);
    try {
      const response = await fetch("/api/session/new", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { data?: { cancelled?: boolean }; error?: string; message?: string };
      if (!response.ok || body.error) {
        setError(body.error || body.message || `New session failed with HTTP ${response.status}`);
      } else if (!body.data?.cancelled) {
        setSessionMenuOpen(false);
        setStreamingMessage(undefined);
        setToolEvents([]);
        setActivityEvents([]);
        setDisplayStats(undefined);
        await Promise.all([fetchState(), fetchMessages()]);
        void fetchSessions();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingSession(false);
    }
  }

  async function sendPrompt() {
    const message = draft.trim();
    if (!message || state.isStreaming) return;
    setDraft("");
    setError(undefined);
    setMessages((prev) => [...prev, { id: `local-user-${Date.now()}`, role: "user", content: message, timestamp: Date.now(), localOnly: true }]);
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
    return modelDisplayName(model);
  }, [state.model]);
  const thinkingLevels = useMemo(() => supportedThinkingLevels(state.model), [state.model]);

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
          <ModelStatus
            value={modelLabel}
            currentModel={state.model}
            models={models}
            open={modelMenuOpen}
            loading={modelsLoading}
            switchingKey={switchingModelKey}
            disabled={!state.processRunning || state.isStreaming}
            menuRef={modelMenuRef}
            onToggle={() => void toggleModelMenu()}
            onRefresh={() => void fetchModels()}
            onSelect={(model) => void switchModel(model)}
          />
          <SessionStatus
            value={state.sessionName || state.sessionId || "new"}
            currentSessionFile={state.sessionFile}
            sessions={sessions}
            open={sessionMenuOpen}
            loading={sessionsLoading}
            scope={sessionScope}
            switchingPath={switchingSessionPath}
            creating={creatingSession}
            disabled={!state.processRunning || state.isStreaming}
            menuRef={sessionMenuRef}
            onToggle={() => void toggleSessionMenu()}
            onRefresh={() => void fetchSessions()}
            onScopeChange={(scope) => void changeSessionScope(scope)}
            onNew={() => void newSession()}
            onSelect={(session) => void switchSession(session)}
          />
          <ThinkingStatus
            value={thinkingLevelLabel(state.thinkingLevel || "medium")}
            currentLevel={state.thinkingLevel || "medium"}
            levels={thinkingLevels}
            open={thinkingMenuOpen}
            switchingLevel={switchingThinkingLevel}
            disabled={!state.processRunning || state.isStreaming}
            menuRef={thinkingMenuRef}
            onToggle={() => setThinkingMenuOpen((open) => !open)}
            onSelect={(level) => void switchThinkingLevel(level)}
          />
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

      {(displayStats || extensionStatuses.length > 0) && (
        <StatsBar
          stats={displayStats}
          autoCompactEnabled={state.autoCompactionEnabled}
          extensionStatuses={extensionStatuses}
        />
      )}

      <section ref={listRef} className="message-list" aria-live="polite" onScroll={handleMessageListScroll}>
        {timeline.items.length === 0 && !streamingMessage ? (
          <div className="empty-state">Start a Pi RPC chat in {state.cwd || "this workspace"}.</div>
        ) : (
          <>
            {timeline.truncated && (
              <div className="truncation-notice">
                Showing last {MAX_VISIBLE_MESSAGES} of {messages.length} messages.
                Older messages are hidden for performance.
              </div>
            )}
            {timeline.items.map((item, i) => renderTimelineItem(item, i))}

            {streamingMessage && streamingMessage.role === "assistant" && (
              <StreamingAssistantCard
                trace={buildStreamingTrace(streamingMessage, toolEvents)}
                message={streamingMessage}
              />
            )}

            {timeline.liveItems
              .filter((item) => streamingMessage?.role !== "assistant" || item.kind === "activity")
              .map((item, i) => renderTimelineItem(item, i, "live"))}

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
          ref={textareaRef}
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

function ModelStatus({
  value,
  currentModel,
  models,
  open,
  loading,
  switchingKey,
  disabled,
  menuRef,
  onToggle,
  onRefresh,
  onSelect
}: {
  value: string;
  currentModel: PiModel | null;
  models: PiModel[];
  open: boolean;
  loading: boolean;
  switchingKey?: string;
  disabled: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onRefresh: () => void;
  onSelect: (model: PiModel) => void;
}) {
  const currentKey = currentModel ? modelKey(currentModel) : "";
  const groupedModels = useMemo(() => {
    const groups = new Map<string, PiModel[]>();
    for (const model of models) {
      const provider = typeof model.provider === "string" && model.provider ? model.provider : "other";
      groups.set(provider, [...(groups.get(provider) ?? []), model]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  return (
    <div className="status model-status" ref={menuRef}>
      <button type="button" className="status-button" onClick={onToggle} disabled={disabled} title="Switch model">
        <span>MODEL</span>
        <strong>{value}</strong>
        <ChevronDown size={14} className={open ? "chevron open" : "chevron"} />
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-menu-header">
            <span>Models</span>
            <button type="button" className="model-refresh" onClick={onRefresh} disabled={loading} title="Refresh models">
              {loading ? <Loader2 size={14} className="spinner" /> : <RefreshCcw size={14} />}
            </button>
          </div>
          {loading && models.length === 0 ? (
            <div className="model-menu-empty">Loading models...</div>
          ) : groupedModels.length === 0 ? (
            <div className="model-menu-empty">No models available</div>
          ) : (
            <div className="model-list">
              {groupedModels.map(([provider, providerModels]) => (
                <div key={provider} className="model-group">
                  <div className="model-provider">{provider}</div>
                  {providerModels.map((model) => {
                    const key = modelKey(model);
                    const active = key === currentKey;
                    const switching = key === switchingKey;
                    return (
                      <button
                        type="button"
                        key={key}
                        className={`model-option ${active ? "active" : ""}`}
                        onClick={() => onSelect(model)}
                        disabled={Boolean(switchingKey) || active}
                      >
                        <span className="model-option-icon">
                          {switching ? <Loader2 size={14} className="spinner" /> : active ? <Check size={14} /> : null}
                        </span>
                        <span className="model-option-text">
                          <strong>{modelDisplayName(model)}</strong>
                          <small>{model.id || model.name || key}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionStatus({
  value,
  currentSessionFile,
  sessions,
  open,
  loading,
  scope,
  switchingPath,
  creating,
  disabled,
  menuRef,
  onToggle,
  onRefresh,
  onScopeChange,
  onNew,
  onSelect
}: {
  value: string;
  currentSessionFile?: string;
  sessions: PiSessionInfo[];
  open: boolean;
  loading: boolean;
  scope: "current" | "all";
  switchingPath?: string;
  creating: boolean;
  disabled: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onRefresh: () => void;
  onScopeChange: (scope: "current" | "all") => void;
  onNew: () => void;
  onSelect: (session: PiSessionInfo) => void;
}) {
  return (
    <div className="status model-status session-status" ref={menuRef}>
      <button type="button" className="status-button" onClick={onToggle} disabled={disabled} title="Manage sessions">
        <span>SESSION</span>
        <strong>{value}</strong>
        <ChevronDown size={14} className={open ? "chevron open" : "chevron"} />
      </button>
      {open && (
        <div className="model-menu session-menu">
          <div className="model-menu-header session-menu-header">
            <div className="session-tabs">
              <button type="button" className={scope === "current" ? "active" : ""} onClick={() => onScopeChange("current")}>
                Current
              </button>
              <button type="button" className={scope === "all" ? "active" : ""} onClick={() => onScopeChange("all")}>
                All
              </button>
            </div>
            <div className="session-actions">
              <button type="button" className="model-refresh" onClick={onNew} disabled={creating || Boolean(switchingPath)} title="New session">
                {creating ? <Loader2 size={14} className="spinner" /> : <Plus size={14} />}
              </button>
              <button type="button" className="model-refresh" onClick={onRefresh} disabled={loading} title="Refresh sessions">
                {loading ? <Loader2 size={14} className="spinner" /> : <RefreshCcw size={14} />}
              </button>
            </div>
          </div>
          {loading && sessions.length === 0 ? (
            <div className="model-menu-empty">Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div className="model-menu-empty">No sessions found</div>
          ) : (
            <div className="model-list session-list">
              {sessions.map((session) => {
                const active = Boolean(currentSessionFile && session.path === currentSessionFile);
                const switching = switchingPath === session.path;
                return (
                  <button
                    type="button"
                    key={session.path}
                    className={`model-option session-option ${active ? "active" : ""}`}
                    onClick={() => onSelect(session)}
                    disabled={Boolean(switchingPath) || creating || active}
                    title={session.path}
                  >
                    <span className="model-option-icon">
                      {switching ? <Loader2 size={14} className="spinner" /> : active ? <Check size={14} /> : null}
                    </span>
                    <span className="model-option-text session-option-text">
                      <strong>{sessionDisplayName(session)}</strong>
                      <small>
                        {formatRelativeTime(session.modified)}
                        {session.messageCount > 0 ? ` · ${session.messageCount} messages` : ""}
                      </small>
                      {scope === "all" && <small>{session.cwd}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingStatus({
  value,
  currentLevel,
  levels,
  open,
  switchingLevel,
  disabled,
  menuRef,
  onToggle,
  onSelect
}: {
  value: string;
  currentLevel: string;
  levels: string[];
  open: boolean;
  switchingLevel?: string;
  disabled: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onSelect: (level: string) => void;
}) {
  return (
    <div className="status model-status thinking-status" ref={menuRef}>
      <button type="button" className="status-button" onClick={onToggle} disabled={disabled} title="Switch thinking level">
        <span>THINKING</span>
        <strong>{value}</strong>
        <ChevronDown size={14} className={open ? "chevron open" : "chevron"} />
      </button>
      {open && (
        <div className="model-menu thinking-menu">
          <div className="model-menu-header">
            <span>Thinking</span>
          </div>
          {levels.length === 0 ? (
            <div className="model-menu-empty">No thinking levels available</div>
          ) : (
            <div className="model-list thinking-list">
              {levels.map((level) => {
                const active = level === currentLevel;
                const switching = level === switchingLevel;
                return (
                  <button
                    type="button"
                    key={level}
                    className={`model-option thinking-option ${active ? "active" : ""}`}
                    onClick={() => onSelect(level)}
                    disabled={Boolean(switchingLevel) || active}
                  >
                    <span className="model-option-icon">
                      {switching ? <Loader2 size={14} className="spinner" /> : active ? <Check size={14} /> : null}
                    </span>
                    <span className="model-option-text">
                      <strong>{thinkingLevelLabel(level)}</strong>
                      <small>{level === "off" ? "Disable model reasoning" : `${level} thinking mode`}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
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

  const textBlocks = contentBlocks.filter((b) => b.type === "text");
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
// Streaming trace: merge consecutive completed tools into compact groups
// ============================================================================

function CompactToolGroup({ tools, names }: { tools: { event: ToolExecutionEvent; key: string }[]; names: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="compact-tool-group">
      <button className="compact-tool-group-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={10} />
        <span>{tools.length} tool{tools.length !== 1 ? "s" : ""}</span>
        <span className="compact-tool-group-names">{names}</span>
      </button>
      {expanded && (
        <div className="compact-tool-group-items">
          {tools.map((t) => (
            <ToolExecutionBubble key={t.key} tool={t.event} collapsed />
          ))}
        </div>
      )}
    </div>
  );
}

function renderMergedEntries(entries: TraceEntry[]): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const completedTools: { event: ToolExecutionEvent; key: string }[] = [];

  for (const entry of entries) {
    if (entry.kind === "thinking") {
      result.push(<pre key={entry.key}>{entry.block.thinking || ""}</pre>);
      continue;
    }
    // Tool entry: running/pending/error stay inline; completed tools go to bottom group
    const tool = entry.event;
    const isDone = tool.status === "complete" || (!tool.status && !!tool.result);
    if (isDone && !tool.isError) {
      completedTools.push({ event: tool, key: entry.key });
    } else {
      result.push(<ToolExecutionBubble key={entry.key} tool={tool} />);
    }
  }

  if (completedTools.length > 0) {
    const names = completedTools.map((t) => t.event.toolName).filter(Boolean).join(", ");
    const key = completedTools.map((t) => t.key).join("-");
    result.push(<CompactToolGroup key={key} tools={completedTools} names={names} />);
  }

  return result;
}

// ============================================================================
// Streaming assistant card (trace + text in one card)
// ============================================================================
function StreamingAssistantCard({ trace, message }: { trace: ExecutionTrace; message: StreamingMessage }) {
  const [expanded, setExpanded] = useState(true);
  const entries = trace.entries;
  const thinkingCount = entries.filter((e) => e.kind === "thinking").length;
  const toolCount = entries.filter((e) => e.kind === "tool").length;
  const toolEntries = entries.filter((e) => e.kind === "tool") as Extract<TraceEntry, { kind: "tool" }>[];
  const hasRunning = toolEntries.some((e) => e.event.status === "running" || e.event.status === "pending");

  const textBlocks = message.content.filter((b) => b.type === "text");
  const imageBlocks = message.content.filter((b) => b.type === "image");
  const otherBlocks = message.content.filter((b) => !["text", "thinking", "toolCall", "image"].includes(b.type));

  const toolNames = toolEntries.map((e) => e.event.toolName).filter(Boolean).join(", ");
  const parts = [
    thinkingCount > 0 ? `${thinkingCount} thinking` : "",
    toolCount > 0 ? `${toolCount} action${toolCount === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  const hasTrace = thinkingCount > 0 || toolCount > 0;

  return (
    <article className={`message assistant streaming${toolCount > 0 ? " has-tools" : ""}`}>
      {hasTrace && (
        <>
          <button className="trace-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {hasRunning ? <Loader2 size={12} className="spinner" /> : <Wrench size={12} />}
            <span>Working</span>
            <span className="trace-summary">{parts.join(" · ")}{toolNames ? ` · ${toolNames}` : ""}</span>
          </button>
          {expanded && (
            <div className="streaming-trace-body">
              {renderMergedEntries(entries)}
            </div>
          )}
        </>
      )}
      <div className="message-role">
        <Loader2 size={12} className="spinner" />
        Assistant streaming...
        {message.stopReason === "aborted" && <span className="badge badge-warn">Aborted</span>}
        {message.stopReason === "error" && <span className="badge badge-error">Error</span>}
      </div>
      <div className="message-body">
        {textBlocks.map((b, i) => (
          <Markdown key={i} text={b.text || ""} />
        ))}
        {imageBlocks.length > 0 && <ResultContent blocks={imageBlocks} />}
        {otherBlocks.length > 0 && <ResultContent blocks={otherBlocks} />}
        {!hasTrace && message.stopReason === "aborted" && (
          <div className="assistant-error">{message.errorMessage || "Operation aborted"}</div>
        )}
        {!hasTrace && message.stopReason === "error" && (
          <div className="assistant-error">Error: {message.errorMessage || "Unknown error"}</div>
        )}
      </div>
    </article>
  );
}

// ============================================================================
// Tool execution bubble
// ============================================================================

function TraceBubble({ trace, defaultExpanded = false, active = false }: { trace: ExecutionTrace; defaultExpanded?: boolean; active?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const thinkingBlocks = trace.entries.filter((e) => e.kind === "thinking").map((e) => e.block);
  const toolEvents = trace.entries.filter((e) => e.kind === "tool").map((e) => e.event);
  const thinkingCount = thinkingBlocks.length;
  const toolCount = toolEvents.length;
  const hasRunning = active || toolEvents.some((tool) => tool.status === "running" || tool.status === "pending");
  const parts = [
    thinkingCount > 0 ? `${thinkingCount} thinking` : "",
    toolCount > 0 ? `${toolCount} action${toolCount === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  const toolNames = toolEvents.map((tool) => tool.toolName).filter(Boolean).join(", ");

  if (thinkingCount === 0 && toolCount === 0) return null;

  return (
    <article className={`message trace${hasRunning ? " active" : ""}`}>
      <button className="trace-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {hasRunning ? <Loader2 size={12} className="spinner" /> : <Wrench size={12} />}
        <span>{active ? "Working" : "Trace"}</span>
        <span className="trace-summary">{parts.join(" · ")}{toolNames ? ` · ${toolNames}` : ""}</span>
      </button>
      {expanded && (
        <div className="trace-body">
          {thinkingCount > 0 && (
            <div className="thinking-section trace-thinking">
              <div className="trace-section-label">Thinking</div>
              <div className="thinking-content">
                {thinkingBlocks.map((block, i) => (
                  <pre key={i}>{block.thinking || ""}</pre>
                ))}
              </div>
            </div>
          )}
          {toolCount > 0 && (
            <div className="trace-tools">
              <div className="trace-section-label">Actions</div>
              <div className="trace-tool-list">
                {toolEvents.map((tool, i) => (
                  <ToolExecutionBubble key={tool.toolCallId || i} tool={tool} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function ToolGroupBubble({ events }: { events: { kind: "toolEvent"; event: ToolExecutionEvent }[] }) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = events.length;
  const names = events.map((e) => e.event.toolName).join(", ");
  const hasRunning = events.some((e) => e.event.status === "running" || e.event.status === "pending");

  return (
    <article className={`message tool-group${hasRunning ? " has-running" : ""}`}>
      <button className="tool-group-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {hasRunning && <Loader2 size={12} className="spinner" />}
        {toolCount} tools
        <span className="tool-group-names">{names}</span>
      </button>
      {expanded && (
        <div className="tool-group-items">
          {events.map((e, i) => (
            <ToolExecutionBubble key={e.event.toolCallId || i} tool={e.event} />
          ))}
        </div>
      )}
    </article>
  );
}

function formatArgSummary(args: JsonValue | undefined): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  const [k, v] = entries[0];
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `${k}: ${s.length > 80 ? s.slice(0, 77) + "..." : s}`;
}

function ToolExecutionBubble({ tool, collapsed }: { tool: ToolExecutionEvent; collapsed?: boolean }) {
  const ss = tool.status;
  const hasResult = !!(tool.result || tool.partialResult);
  const isPending = ss === "pending";
  const isRunning = ss === "running" || (!ss && hasResult && !tool.result);
  const isDone = ss === "complete" || (!ss && !!tool.result);
  const tone = tool.isError ? "error" : isDone ? "success" : isRunning ? "pending" : "pending";
  const shouldCollapse = collapsed && isDone && !tool.isError && hasResult;

  const body = (
    <div className="message-body">
      {tool.args && <ToolArgsTable args={tool.args} />}
      {hasResult && <ToolResultDetails blocks={tool.result?.content || tool.partialResult?.content || []} isPartial={isRunning} />}
    </div>
  );

  return (
    <article className={`message tool-execution ${tone}${shouldCollapse ? " tool-collapsed" : ""}`}>
      <div className="message-role">
        {isRunning ? <Loader2 size={12} className="spinner" /> : isPending ? <Loader2 size={12} /> : <Wrench size={12} />}
        {tool.toolName}
        {isPending && <span className="badge badge-muted">preparing</span>}
        {isRunning && <span className="badge badge-pending">running</span>}
        {tool.isError && <span className="badge badge-error">error</span>}
        {isDone && !tool.isError && <span className="badge badge-ok">done</span>}
      </div>
      {shouldCollapse ? (
        <details className="tool-collapsed-details">
          <summary>{formatArgSummary(tool.args)}</summary>
          {body}
        </details>
      ) : (
        body
      )}
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

function buildStreamingTrace(message: StreamingMessage, toolEvents: ToolExecutionEvent[]): ExecutionTrace {
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

function traceShapeKey(blocks: ContentBlock[]): string {
  return blocks
    .map((block, index) => {
      if (block.type === "thinking") return `thinking:${index}:${block.thinking?.length ?? 0}`;
      if (block.type === "toolCall") return `tool:${block.id || index}:${block.name || ""}`;
      return "";
    })
    .filter(Boolean)
    .join("|");
}

function hasAssistantDisplayContent(message: AgentMessage): boolean {
  if (message.errorMessage) return true;
  return extractContentBlocks(message).some((block) =>
    block.type === "text" && Boolean(block.text?.trim()) ||
    block.type === "image" ||
    !["thinking", "toolCall"].includes(block.type)
  );
}

function renderTimelineItem(item: TimelineItem, index: number, prefix = "history"): React.ReactNode {
  if (item.kind === "message") {
    return <MessageBubble key={`${prefix}-${messageKey(item.message, index)}`} message={item.message} />;
  }
  if (item.kind === "trace") {
    return <TraceBubble key={`${prefix}-trace-${item.trace.id || index}`} trace={item.trace} />;
  }
  if (item.kind === "toolEvent") {
    return <ToolExecutionBubble key={`${prefix}-tool-${item.event.toolCallId || index}`} tool={item.event} />;
  }
  if (item.kind === "toolGroup") {
    const ids = item.events.map((event, i) => event.event.toolCallId || i).join(":");
    return <ToolGroupBubble key={`${prefix}-tg-${ids || index}`} events={item.events} />;
  }
  return <ActivityBubble key={`${prefix}-activity-${item.event.id}`} event={item.event} />;
}

function collapseToolGroups(items: TimelineItem[]): TimelineItem[] {
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

function mergeMessages(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
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

  return dedupeMessages(result);
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

function messageKey(message: AgentMessage, fallbackIndex = -1): string {
  if (typeof message.id === "string") return `id:${message.id}`;
  if (typeof message.responseId === "string") return `response:${message.responseId}`;
  if (typeof message.timestamp === "number") return `timestamp:${message.timestamp}:${message.role ?? message.type ?? ""}:${extractText(message)}`;
  return `content:${message.role ?? message.type ?? ""}:${extractText(message)}:${fallbackIndex}`;
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

function appendToolEvent(current: ToolExecutionEvent[], event: ToolExecutionEvent): ToolExecutionEvent[] {
  const idx = current.findIndex((existing) => existing.toolCallId === event.toolCallId);
  if (idx >= 0) {
    const updated = [...current];
    updated[idx] = { ...current[idx], ...event, timestamp: current[idx]?.timestamp ?? event.timestamp };
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
// Stats bar
// ============================================================================

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function StatsBar({
  stats,
  autoCompactEnabled,
  extensionStatuses
}: {
  stats?: SessionStats;
  autoCompactEnabled?: boolean;
  extensionStatuses?: ExtensionStatus[];
}) {
  const parts: string[] = [];
  const statuses = extensionStatuses ?? [];

  if (stats?.tokens.input && stats.tokens.input > 0) parts.push(`↑${formatTokens(stats.tokens.input)}`);
  if (stats?.tokens.output && stats.tokens.output > 0) parts.push(`↓${formatTokens(stats.tokens.output)}`);
  if (stats?.tokens.cacheRead && stats.tokens.cacheRead > 0) parts.push(`R${formatTokens(stats.tokens.cacheRead)}`);
  if (stats?.tokens.cacheWrite && stats.tokens.cacheWrite > 0) parts.push(`W${formatTokens(stats.tokens.cacheWrite)}`);

  if ((stats?.tokens.cacheRead && stats.tokens.cacheRead > 0) || (stats?.tokens.cacheWrite && stats.tokens.cacheWrite > 0)) {
    const totalPrompt = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
    if (totalPrompt > 0) {
      parts.push(`CH${((stats.tokens.cacheRead / totalPrompt) * 100).toFixed(1)}%`);
    }
  }

  if (stats?.cost && stats.cost > 0) parts.push(`$${stats.cost.toFixed(3)}`);

  if (stats?.contextUsage) {
    const cu = stats.contextUsage;
    const autoIndicator = autoCompactEnabled ? " (auto)" : "";
    const ctxDisplay = cu.percent !== null
      ? `${cu.percent.toFixed(1)}%/${formatTokens(cu.contextWindow)}${autoIndicator}`
      : `?/${formatTokens(cu.contextWindow)}${autoIndicator}`;
    parts.push(ctxDisplay);
  }

  if (parts.length === 0 && statuses.length === 0) return null;

  return (
    <div className="stats-bar">
      {parts.length > 0 && <span>{parts.join(" · ")}</span>}
      {statuses.length > 0 && (
        <div className="extension-status-list" aria-label="Extension status">
          {statuses.map((status) => (
            <span className="extension-status" key={status.key} title={status.title || status.key}>
              {status.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Bootstrap
// ============================================================================
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import { createRoot } from "react-dom/client";
import { CircleStop, RefreshCcw, SendHorizontal, Terminal, Wrench, Monitor, FileCode, AlertTriangle, Loader2, ChevronDown, ChevronRight, Check, Plus, Folder, File } from "lucide-react";
import type { ActivityEvent, AgentMessage, FileEntry, JsonValue, PiModel, PiSessionInfo, PiSlashCommand, PiState, ServerEvent, SessionStats, StreamingMessage, ToolExecutionEvent, ContentBlock, QueueState } from "../../shared/src/index.js";
import { marked } from "marked";
import "./styles.css";
import { MAX_VISIBLE_MESSAGES, emptyState, resizeComposerTextarea, modelDisplayName, modelKey, thinkingLevelLabel, supportedThinkingLevels, sessionDisplayName, formatRelativeTime, formatArgSummary, extractText, extractContentBlocks, buildStreamingTrace, traceShapeKey, hasAssistantDisplayContent, collapseToolGroups, mergeMessages, messageKey, shouldDisplayActivity, summarizeContentBlocks, appendToolEvent, isUnknownDisplayEvent, stripAnsiDisplay, formatTokens, traceEntryStatusColor, traceOverallStatus } from "./lib/helpers.js";
import { ToastProvider, useToast } from "./lib/toast.js";
import { InteractiveDialogProvider, useInteractiveDialog } from "./lib/interactive-dialog.js";

type TimelineItem =
  | { kind: "message"; message: AgentMessage }
  | { kind: "trace"; trace: ExecutionTrace }
  | { kind: "toolEvent"; event: ToolExecutionEvent }
  | { kind: "toolGroup"; events: { kind: "toolEvent"; event: ToolExecutionEvent }[] };

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
// Constants
// ============================================================================

/** Built-in slash commands (mirrored from pi TUI BUILTIN_SLASH_COMMANDS) */
const BUILTIN_COMMANDS: PiSlashCommand[] = [
  { name: "model", description: "Select model", source: "builtin" },
  { name: "scoped-models", description: "Enable/disable models for cycling", source: "builtin" },
  { name: "export", description: "Export session as HTML", source: "builtin" },
  { name: "import", description: "Import and resume a session from JSONL", source: "builtin" },
  { name: "share", description: "Share session as GitHub gist", source: "builtin" },
  { name: "copy", description: "Copy last assistant message to clipboard", source: "builtin" },
  { name: "name", description: "Set session display name", source: "builtin" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "changelog", description: "Show changelog entries", source: "builtin" },
  { name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Create a new fork from a previous user message", source: "builtin" },
  { name: "clone", description: "Duplicate the current session", source: "builtin" },
  { name: "tree", description: "Navigate session tree (switch branches)", source: "builtin" },
  { name: "trust", description: "Save project trust decision", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin" },
  { name: "logout", description: "Remove provider authentication", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Manually compact the session context", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes", source: "builtin" },
  { name: "quit", description: "Quit pi", source: "builtin" },
  { name: "settings", description: "Open settings menu", source: "builtin" },
];

// ============================================================================
// Markdown renderer
// ============================================================================
marked.setOptions({ gfm: true, breaks: false });

function Markdown({ text }: { text: string }) {
  const lastTextRef = useRef("");
  const lastHtmlRef = useRef("");

  // Re-parse only when text content actually changes.
  // During streaming, React may re-render with the same text prop value
  // from unrelated state changes; the ref cache avoids redundant O(n) parse.
  const html = useMemo(() => {
    if (text === lastTextRef.current) return lastHtmlRef.current;
    lastTextRef.current = text;
    lastHtmlRef.current = marked.parse(text, { async: false }) as string;
    return lastHtmlRef.current;
  }, [text]);

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
  const lastTextContentRef = useRef("");
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);

  // --- streaming state ---
  const [streamingMessage, setStreamingMessage] = useState<StreamingMessage | undefined>();
  // Defer streaming text rendering so rapid updates don't block scrolling / tool updates.
  // React 18 will skip intermediate renders when new updates arrive before paint.
  const deferredStreamingMessage = useDeferredValue(streamingMessage);
  const [toolEvents, setToolEvents] = useState<ToolExecutionEvent[]>([]);
  const [queueState, setQueueState] = useState<QueueState>({ steering: [], followUp: [] });
  const [isCompacting, setIsCompacting] = useState(false);

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
  const [slashCommands, setSlashCommands] = useState<PiSlashCommand[]>([]);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileIndex, setFileIndex] = useState(0);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);

  const { pushToast } = useToast();
  const { pushDialog } = useInteractiveDialog();

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

  // Route an activity event to either extension status bar, interactive dialog, or toast stack
  const pushActivity = (event: ActivityEvent) => {
    if (event.type === "extension_ui_request") {
      if (event.method === "setStatus") {
        updateExtensionStatus(event);
        return;
      }
      // Interactive extension_ui_request events (with options or widget content) go to dialog
      if (event.options || event.widgetKey) {
        pushDialog(event);
        return;
      }
    }
    // All other activity events go to the toast stack
    const dismissGroups: string[] | undefined =
      event.type === "auto_retry_start" ? ["retry-pending"] : undefined;
    pushToast({
      id: event.id,
      type: event.type,
      payload: event,
      dismissGroups
    });
  };

  // SSE
  useEffect(() => {
    void fetchState();
    void fetchMessages();
    void fetchCommands();

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
          setDisplayStats((current) => event.state.stats ?? current);
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
            pushToast({
              id: `unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              type: "unknown",
              payload: { type: "unknown", timestamp: Date.now(), event: event.event } as ActivityEvent
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
          setQueueState({ steering: [], followUp: [] });
          lastTraceShapeRef.current = "";
          lastTextContentRef.current = "";
          setIsCompacting(false);
          break;
        case "agent_end":
          isStreamingRef.current = false;
          setStreamingMessage(undefined);
          if (event.willRetry) {
            pushToast({
              id: `retry-pending-${Date.now()}`,
              type: "agent_retry_pending",
              payload: { id: `retry-pending-${Date.now()}`, type: "agent_retry_pending", timestamp: Date.now() } as unknown as ActivityEvent
            });
          }
          break;

        case "message_start":
          // Skip toolResult messages — they're already shown via ToolExecutionBubble
          if (event.message.role === "toolResult") break;
          lastTraceShapeRef.current = traceShapeKey(event.message.content);
          // Register tool calls from the initial message content block
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
          setStreamingMessage(event.message);
          break;
        case "message_update":
          // Throttle streaming text updates adaptively to avoid excessive re-renders.
          // For long texts (>10KB), update less frequently to prevent event backlog.
          // Trace shape changes (thinking/tool blocks) are still processed immediately.
          {
            const now = Date.now();

            // Fast path: check if the text content actually changed since last update.
            // When only trace shape changes (thinking/tool), text stays same.
            const textContent = event.message.content
              .filter((b) => b.type === "text")
              .map((b) => b.text || "")
              .join("");
            const textChanged = textContent !== lastTextContentRef.current;

            // Adaptive throttle: longer texts get longer intervals so markdown
            // parsing (O(n)) doesn't starve the main thread and cause event backlog.
            const textLen = textContent.length;
            const throttleMs = textLen > 20000 ? 150 : textLen > 8000 ? 80 : textLen > 3000 ? 50 : 32;
            const needsThrottle = now - lastStreamUpdateRef.current < throttleMs;

            // Compute trace shape only when we might need it
            let traceShapeChanged = false;
            if (!needsThrottle || textChanged) {
              const traceShape = traceShapeKey(event.message.content);
              traceShapeChanged = traceShape !== lastTraceShapeRef.current;
              if (traceShapeChanged) lastTraceShapeRef.current = traceShape;
            }

            // Always process tool calls regardless of throttle (they must not be missed)
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

            // Only update streaming message when text changed OR trace shape changed.
            if (textChanged || traceShapeChanged) {
              if (textChanged) lastTextContentRef.current = textContent;
              lastStreamUpdateRef.current = now;
              setStreamingMessage(event.message);
            }
          }
          break;
        case "message_end":
          // Persist assistant, system, and toolResult messages.
          // User messages are added locally by sendPrompt(); they arrive later
          // via the server and are deduplicated by mergeMessages.
          if (event.message.role === "assistant" || event.message.role === "compactionSummary" || event.message.role === "branchSummary" || event.message.role === "custom" || event.message.role === "bashExecution" || event.message.role === "toolResult") {
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
          break;
        case "compaction_end":
          setIsCompacting(false);
          if (event.errorMessage || event.aborted) {
            pushToast({
              id: `compaction-${Date.now()}`,
              type: "compaction_end",
              payload: { id: `compaction-${Date.now()}`, type: "compaction_end", timestamp: Date.now(), errorMessage: event.errorMessage, aborted: event.aborted } as unknown as ActivityEvent
            });
          }
          break;

        case "queue_update":
          setQueueState(event.queue);
          break;
      }
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    if (!modelMenuOpen && !sessionMenuOpen && !thinkingMenuOpen && !commandMenuOpen && !fileMenuOpen) return;

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
      if (!commandMenuRef.current?.contains(event.target as Node)) {
        setCommandMenuOpen(false);
      }
      if (!fileMenuRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Close file menu first if open
        if (fileMenuOpen) {
          setFileMenuOpen(false);
          event.stopPropagation();
          return;
        }
        // Close command menu next if open (textarea Esc is for abort/interrupt)
        if (commandMenuOpen) {
          setCommandMenuOpen(false);
          event.stopPropagation();
          return;
        }
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
  }, [modelMenuOpen, sessionMenuOpen, thinkingMenuOpen, commandMenuOpen, fileMenuOpen]);

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
  }, [messages, streamingMessage, toolEvents, isCompacting]);

  // Merge all event streams into a single chronological timeline
  // Cap messages to avoid performance degradation on long sessions
  const timeline = useMemo((): { items: TimelineItem[]; liveItems: TimelineItem[]; truncated: boolean } => {
    const totalMessages = messages.length;
    const visibleMessages = totalMessages > MAX_VISIBLE_MESSAGES
      ? messages.slice(-MAX_VISIBLE_MESSAGES)
      : messages;

    const items: TimelineItem[] = [];
    const liveItems: TimelineItem[] = [];
    // Build a lookup of tool results from toolResult messages, keyed by toolCallId then toolName.
    // Results are removed from the map once consumed by a trace, so they are not
    // re-matched to a later assistant message that called a tool with the same name.
    const toolResultMap = new Map<string, { content: ContentBlock[]; key: string }>();
    const consumedResults = new Set<string>();
    const activeToolMap = new Map<string, ToolExecutionEvent>();
    const consumedActiveTools = new Set<string>();

    for (const tool of toolEvents) {
      if (tool.toolCallId) activeToolMap.set(tool.toolCallId, tool);
    }

    for (const message of visibleMessages) {
      if (message.role === "toolResult") {
        const key = String(message.toolCallId ?? message.toolName ?? "");
        if (key) toolResultMap.set(key, { content: extractContentBlocks(message), key });
        continue;
      }
    }

    for (const message of visibleMessages) {
      if (message.role === "toolResult") {
        const key = String(message.toolCallId ?? message.toolName ?? "");
        // Show toolResult as a standalone bubble only when no trace consumed it
        if (key && consumedResults.has(key)) continue;
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
            // Try toolCallId first, then toolName as fallback.
            // Remove from map on match so the same result isn't reused by a later assistant.
            const resultEntry = toolResultMap.get(callId) ?? toolResultMap.get(callName);
            const resultContent = resultEntry?.content;

            if (resultContent && resultContent.length > 0) {
              consumedResults.add(callId);
              consumedResults.add(callName);
              // Remove consumed result so later assistants with same toolName don't reuse it
              if (resultEntry) {
                toolResultMap.delete(resultEntry.key);
              }
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
                // Only mark as complete when a result is present; otherwise leave
                // status undefined so the UI does not falsely show a green "done".
                ...(resultContent && resultContent.length > 0
                  ? { status: "complete" as const, result: { content: resultContent } }
                  : {}),
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
    return {
      items: collapseToolGroups(items),
      liveItems: collapseToolGroups(liveItems),
      truncated: totalMessages > MAX_VISIBLE_MESSAGES
    };
  }, [messages, toolEvents]);

  async function fetchState() {
    const response = await fetch("/api/state");
    const nextState = (await response.json()) as PiState;
    isStreamingRef.current = nextState.isStreaming;
    setState(nextState);
    setDisplayStats((current) => nextState.stats ?? current);
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

  async function fetchCommands() {
    try {
      const response = await fetch("/api/commands");
      const body = (await response.json()) as { commands?: PiSlashCommand[] };
      const rpcCommands = Array.isArray(body.commands) ? body.commands : [];
      // Merge built-in commands with RPC commands, deduplicating by name
      const merged = new Map<string, PiSlashCommand>();
      for (const cmd of BUILTIN_COMMANDS) merged.set(cmd.name, cmd);
      for (const cmd of rpcCommands) {
        if (!merged.has(cmd.name)) merged.set(cmd.name, cmd);
      }
      setSlashCommands([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } catch { /* silently ignore — command bar works without server data */ }
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
        setDisplayStats(undefined);
        setIsCompacting(false);
        setQueueState({ steering: [], followUp: [] });
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
        setDisplayStats(undefined);
        setIsCompacting(false);
        setQueueState({ steering: [], followUp: [] });
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

    // Check if this is a slash command and handle built-in commands specially
    if (message.startsWith("/")) {
      const handled = await handleSlashCommand(message);
      if (handled) {
        setDraft("");
        return;
      }
    }

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

  /** Handle built-in slash commands by routing to appropriate RPC endpoints */
  async function handleSlashCommand(command: string): Promise<boolean> {
    const spaceIndex = command.indexOf(" ");
    const cmdName = spaceIndex === -1 ? command.slice(1) : command.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : command.slice(spaceIndex + 1).trim();

    switch (cmdName) {
      case "model":
        // Open model selector menu
        await toggleModelMenu();
        return true;

      case "scoped-models":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Scoped models management not yet supported in WebUI" } } as ActivityEvent
        });
        return true;

      case "export":
        try {
          const response = await fetch("/api/export", { method: "POST" });
          const body = (await response.json()) as { data?: { filePath?: string }; error?: string };
          if (body.data?.filePath) {
            pushToast({
              id: `export-${Date.now()}`,
              type: "unknown",
              payload: { type: "unknown", timestamp: Date.now(), event: { type: "success", message: `Exported to ${body.data.filePath}` } } as ActivityEvent
            });
          } else if (body.error) {
            setError(body.error);
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        return true;

      case "import":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Import via file upload not yet supported. Use session menu instead." } } as ActivityEvent
        });
        return true;

      case "share":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "GitHub gist sharing not yet supported in WebUI" } } as ActivityEvent
        });
        return true;

      case "copy":
        try {
          const response = await fetch("/api/copy");
          const body = (await response.json()) as { data?: { text?: string }; error?: string };
          if (body.data?.text) {
            await navigator.clipboard.writeText(body.data.text);
            pushToast({
              id: `copy-${Date.now()}`,
              type: "unknown",
              payload: { type: "unknown", timestamp: Date.now(), event: { type: "success", message: "Copied last assistant message" } } as ActivityEvent
            });
          } else if (body.error) {
            setError(body.error);
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        return true;

      case "name":
        if (!args) {
          setError("Usage: /name <session-name>");
          return true;
        }
        try {
          const response = await fetch("/api/session/name", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: args })
          });
          const body = (await response.json()) as { error?: string };
          if (body.error) {
            setError(body.error);
          } else {
            await fetchState();
            pushToast({
              id: `name-${Date.now()}`,
              type: "unknown",
              payload: { type: "unknown", timestamp: Date.now(), event: { type: "success", message: `Session renamed to "${args}"` } } as ActivityEvent
            });
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        return true;

      case "session":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: `Session: ${state.sessionName || state.sessionId || "new"}, Messages: ${messages.length}` } } as ActivityEvent
        });
        return true;

      case "changelog":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Changelog view not yet supported in WebUI" } } as ActivityEvent
        });
        return true;

      case "hotkeys":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Keyboard shortcuts: Enter=send, Shift+Enter=newline, Esc=abort, /=commands, @=files" } } as ActivityEvent
        });
        return true;

      case "fork":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Fork from previous message not yet supported in WebUI" } } as ActivityEvent
        });
        return true;

      case "clone":
        try {
          const response = await fetch("/api/session/clone", { method: "POST" });
          const body = (await response.json()) as { error?: string };
          if (body.error) {
            setError(body.error);
          } else {
            await Promise.all([fetchState(), fetchMessages()]);
            void fetchSessions();
            pushToast({
              id: `clone-${Date.now()}`,
              type: "unknown",
              payload: { type: "unknown", timestamp: Date.now(), event: { type: "success", message: "Session cloned" } } as ActivityEvent
            });
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        return true;

      case "tree":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Session tree navigation not yet supported in WebUI" } } as ActivityEvent
        });
        return true;

      case "trust":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Project trust management not yet supported in WebUI" } } as ActivityEvent
        });
        return true;

      case "login":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "OAuth login must be configured via pi CLI first" } } as ActivityEvent
        });
        return true;

      case "logout":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "OAuth logout must be done via pi CLI" } } as ActivityEvent
        });
        return true;

      case "new":
        await newSession();
        return true;

      case "compact":
        try {
          const response = await fetch("/api/compact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args ? { customInstructions: args } : {})
          });
          const body = (await response.json()) as { error?: string };
          if (body.error) {
            setError(body.error);
          } else {
            pushToast({
              id: `compact-${Date.now()}`,
              type: "unknown",
              payload: { type: "unknown", timestamp: Date.now(), event: { type: "success", message: "Compaction started" } } as ActivityEvent
            });
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        return true;

      case "resume":
        await toggleSessionMenu();
        return true;

      case "reload":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Reload not supported in RPC mode — restart pi-web-ui instead" } } as ActivityEvent
        });
        return true;

      case "quit":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Close the browser tab to quit" } } as ActivityEvent
        });
        return true;

      case "settings":
        pushToast({
          id: `info-${Date.now()}`,
          type: "unknown",
          payload: { type: "unknown", timestamp: Date.now(), event: { type: "info", message: "Settings panel not yet implemented in WebUI" } } as ActivityEvent
        });
        return true;

      default:
        // Not a built-in command — let it fall through to normal prompt handling
        return false;
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

  // Refs for command menu scrolling
  const commandItemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Filtered slash commands for the command menu
  // Sort by source (builtin first) then by name to match visual grouping
  const filteredCommands = useMemo(() => {
    const q = commandFilter.toLowerCase();
    const sourceOrder: Record<string, number> = { builtin: 0, extension: 1, prompt: 2, skill: 3 };
    const filtered = q
      ? slashCommands.filter((cmd) =>
          cmd.name.toLowerCase().includes(q) ||
          (cmd.description || "").toLowerCase().includes(q)
        )
      : slashCommands;
    return [...filtered].sort((a, b) => {
      const sourceDiff = (sourceOrder[a.source] ?? 99) - (sourceOrder[b.source] ?? 99);
      if (sourceDiff !== 0) return sourceDiff;
      return a.name.localeCompare(b.name);
    });
  }, [slashCommands, commandFilter]);

  // Scroll active command item into view when index changes
  useEffect(() => {
    if (!commandMenuOpen) return;
    const el = commandItemRefs.current[commandIndex];
    if (el) el.scrollIntoView({ block: "center" });
  }, [commandIndex, commandMenuOpen]);

  // Reset refs array when filtered list changes
  useEffect(() => {
    commandItemRefs.current = [];
  }, [filteredCommands]);

  // Select a command and insert into the textarea
  function selectCommand(cmd: PiSlashCommand) {
    const text = `/${cmd.name} `;
    setDraft(text);
    setCommandMenuOpen(false);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    }, 0);
  }

  // --- File menu (@ file picker) ---
  const fileItemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fileCacheRef = useRef<FileEntry[] | null>(null);

  /** Detect @token ending at cursorPos. Returns { start, query } or null. */
  function findAtToken(text: string, cursorPos: number): { start: number; query: string } | null {
    // Scan backwards from cursorPos to find '@'
    let i = cursorPos - 1;
    while (i >= 0) {
      const ch = text[i];
      // Stop at whitespace or newline
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") return null;
      if (ch === "@") {
        // Verify @ is at start of string or preceded by whitespace/newline
        if (i === 0 || /[\s]/.test(text[i - 1])) {
          const query = text.slice(i + 1, cursorPos);
          return { start: i, query };
        }
        return null;
      }
      i--;
    }
    return null;
  }

  // Filtered files for the file menu
  const filteredFiles = useMemo(() => {
    const q = fileFilter.toLowerCase();
    if (!q) return fileEntries;
    return fileEntries.filter((f) =>
      f.name.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q)
    );
  }, [fileEntries, fileFilter]);

  // Scroll active file item into view when index changes
  useEffect(() => {
    if (!fileMenuOpen) return;
    const el = fileItemRefs.current[fileIndex];
    if (el) el.scrollIntoView({ block: "center" });
  }, [fileIndex, fileMenuOpen]);

  // Reset refs array when filtered list changes
  useEffect(() => {
    fileItemRefs.current = [];
  }, [filteredFiles]);

  // Clear file cache when cwd changes
  useEffect(() => {
    fileCacheRef.current = null;
  }, [state.cwd]);

  // Select a file and replace the @token in the textarea
  function selectFile(file: FileEntry) {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? draft.length;
    const token = findAtToken(draft, cursorPos);
    if (!token) return;
    const before = draft.slice(0, token.start);
    const after = draft.slice(cursorPos);
    const inserted = `@${file.path} `;
    const newText = before + inserted + after;
    const newCursor = before.length + inserted.length;
    setDraft(newText);
    setFileMenuOpen(false);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    }, 0);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Terminal size={20} />
          <div>
            <h1>Pi Web UI</h1>
            <p>{state.cwd || "Loading workspace"}{state.gitBranch ? ` (${state.gitBranch})` : ""}</p>
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
          <Status label="Stream" value={isCompacting ? "compacting" : state.isStreaming ? "streaming" : "idle"} tone={isCompacting ? "warn" : state.isStreaming ? "hot" : "ok"} />
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

      <section ref={listRef} className="message-list session-path" aria-live="polite" onScroll={handleMessageListScroll}>
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

            {streamingMessage && (
              <StreamingAssistantCard
                trace={buildStreamingTrace(streamingMessage, toolEvents)}
                message={deferredStreamingMessage || streamingMessage}
              />
            )}

            {timeline.liveItems
              .map((item, i) => renderTimelineItem(item, i, "live"))}
          </>
        )}
      </section>

      <footer className="composer">
        {fileMenuOpen && filteredFiles.length > 0 && (
          <div ref={fileMenuRef} className="file-menu" onMouseDown={(event) => event.preventDefault()}>
            <div className="file-menu-list">
              {filteredFiles.map((file, index) => (
                <div
                  key={file.path}
                  ref={(el) => { fileItemRefs.current[index] = el; }}
                  role="option"
                  aria-selected={index === fileIndex}
                  className={`file-item${index === fileIndex ? " active" : ""}`}
                  onClick={() => selectFile(file)}
                  onMouseEnter={() => setFileIndex(index)}
                >
                  <span className="file-icon">{file.isDirectory ? <Folder size={14} /> : <File size={14} />}</span>
                  <span className="file-name">{file.name}</span>
                  <span className="file-path">{file.path}</span>
                </div>
              ))}
            </div>
            <div className="file-menu-footer">
              ({fileIndex + 1}/{filteredFiles.length})
            </div>
          </div>
        )}
        {commandMenuOpen && filteredCommands.length > 0 && (
          <div ref={commandMenuRef} className="command-menu" onMouseDown={(event) => event.preventDefault()}>
            {(() => {
              // Group commands by source
              const groups: { source: string; commands: PiSlashCommand[] }[] = [];
              const sourceOrder = ["builtin", "extension", "prompt", "skill"];
              
              for (const source of sourceOrder) {
                const cmds = filteredCommands.filter((cmd) => cmd.source === source);
                if (cmds.length > 0) {
                  groups.push({ source, commands: cmds });
                }
              }
              
              let currentIndex = 0;
              return groups.map((group) => (
                <div key={group.source} className="command-group" data-source={group.source}>
                  <div className="command-group-header">
                    <span className="command-group-label">{group.source}</span>
                    <span className="command-group-count">{group.commands.length}</span>
                  </div>
                  {group.commands.map((cmd) => {
                    const index = currentIndex++;
                    return (
                      <div
                        key={cmd.name}
                        ref={(el) => { commandItemRefs.current[index] = el; }}
                        role="option"
                        aria-selected={index === commandIndex}
                        className={`command-item${index === commandIndex ? " active" : ""}`}
                        onClick={() => selectCommand(cmd)}
                        onMouseEnter={() => setCommandIndex(index)}
                      >
                        <span className="command-name">/{cmd.name}</span>
                        {cmd.description && <span className="command-desc">{cmd.description}</span>}
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            const val = event.target.value;
            setDraft(val);
            const cursorPos = event.target.selectionStart ?? val.length;

            // Check for @ token first
            const atToken = findAtToken(val, cursorPos);
            if (atToken) {
              // Open file menu, close command menu
              setCommandMenuOpen(false);
              setFileMenuOpen(true);
              setFileFilter(atToken.query);
              setFileIndex(0);
              // Lazy-load file entries from API
              if (!fileCacheRef.current) {
                fetch("/api/files")
                  .then((r) => r.json())
                  .then((data) => {
                    fileCacheRef.current = data.files ?? [];
                    setFileEntries(data.files ?? []);
                  })
                  .catch(() => {});
              } else {
                setFileEntries(fileCacheRef.current);
              }
              return;
            }

            // Close file menu if no @ token
            setFileMenuOpen(false);

            // Toggle command menu when user types / at line start
            if (val.startsWith("/") && !val.includes(" ") && val.length >= 1) {
              setCommandMenuOpen(true);
              setCommandFilter(val.slice(1));
              setCommandIndex(0);
            } else if (val.startsWith("/") && val.includes(" ")) {
              setCommandMenuOpen(false);
            } else {
              setCommandMenuOpen(false);
            }
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (commandMenuOpen && filteredCommands.length > 0) {
              if (event.key === "Escape") {
                event.preventDefault();
                setCommandMenuOpen(false);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCommandIndex((prev) => Math.max(0, prev - 1));
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCommandIndex((prev) => Math.min(filteredCommands.length - 1, prev + 1));
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
                event.preventDefault();
                const cmd = filteredCommands[commandIndex];
                if (cmd) selectCommand(cmd);
                return;
              }
              // Tab selects and keeps menu open for argument completion
              if (event.key === "Tab") {
                event.preventDefault();
                const cmd = filteredCommands[commandIndex];
                if (cmd) {
                  setDraft(`/${cmd.name} `);
                  setCommandMenuOpen(false);
                  setTimeout(() => {
                    const el = textareaRef.current;
                    if (el) {
                      el.focus();
                      el.setSelectionRange(cmd.name.length + 2, cmd.name.length + 2);
                    }
                  }, 0);
                }
                return;
              }
              // Any other key: let it through to onChange which will update commandFilter
              return;
            }
            if (fileMenuOpen && filteredFiles.length > 0) {
              if (event.key === "Escape") {
                event.preventDefault();
                setFileMenuOpen(false);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setFileIndex((prev) => Math.max(0, prev - 1));
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setFileIndex((prev) => Math.min(filteredFiles.length - 1, prev + 1));
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
                event.preventDefault();
                const file = filteredFiles[fileIndex];
                if (file) selectFile(file);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                const file = filteredFiles[fileIndex];
                if (file) selectFile(file);
                return;
              }
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current) {
              event.preventDefault();
              void sendPrompt();
            }
          }}
          placeholder="Send a prompt to Pi — / for commands, @ for files"
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
function Status({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" | "hot" | "warn" }) {
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
        {message.errorMessage && (
          <div className="assistant-error">{String(message.errorMessage)}</div>
        )}
      </div>
    </article>
  );
}

// ============================================================================
// Streaming trace: merge consecutive completed tools into compact groups
// ============================================================================
// Path diagram — Layer 1 wrapper (session-level node)
// ============================================================================

type PathDotTone = "user" | "assistant" | "active" | "complete" | "error" | "ok" | "cancelled";

function PathNode({ dotTone, dotKind, children }: { dotTone?: PathDotTone; dotKind?: string; children: React.ReactNode }) {
  const kind = dotKind || "";
  return (
    <div className="path-node">
      <div className={`path-dot ${kind}${dotTone ? ` ${dotTone}` : ""}`} />
      <div className="path-card">{children}</div>
    </div>
  );
}

// ============================================================================
// Trace card (Layer 1 node for a trace — replaces old TraceBubble)
// ============================================================================

export function TraceCard({ trace, active, defaultExpanded }: { trace: ExecutionTrace; active?: boolean; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? active ?? false);
  const thinkingCount = trace.entries.filter((e) => e.kind === "thinking").length;
  const toolCount = trace.entries.filter((e) => e.kind === "tool").length;
  // Auto-expand when streaming (active) and entries arrive
  useEffect(() => { if (active) setExpanded(true); }, [active, trace.entries.length]);
  const hasRunning = active || trace.entries.some((e) => e.kind === "tool" && (e.event.status === "running" || e.event.status === "pending"));
  const overall = traceOverallStatus(trace.entries, !!active);
  const toolEntries = trace.entries.filter((e) => e.kind === "tool") as Extract<TraceEntry, { kind: "tool" }>[];
  const toolNames = toolEntries.map((e) => e.event.toolName).filter(Boolean).join(", ");
  const parts = [
    thinkingCount > 0 ? `${thinkingCount} thinking` : "",
    toolCount > 0 ? `${toolCount} action${toolCount === 1 ? "" : "s"}` : ""
  ].filter(Boolean);

  if (thinkingCount === 0 && toolCount === 0) return null;

  return (
    <div className={`trace-card ${overall}`}>
      <button className="trace-card-header" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {hasRunning ? <Loader2 size={12} className="spinner" /> : <Wrench size={12} />}
        <span>{active ? "Working" : "Trace"}</span>
        <span className="trace-summary">{parts.join(" · ")}{toolNames ? ` · ${toolNames}` : ""}</span>
      </button>
      {expanded && <SubPath entries={trace.entries} />}
    </div>
  );
}

// ============================================================================
// Sub-path (Layer 2): trace-internal vertical timeline with dashed line
// ============================================================================

function SubPath({ entries }: { entries: TraceEntry[] }) {
  // Merge consecutive completed (non-error) tools into groups
  const merged: Array<TraceEntry | { kind: "subGroup"; entries: Extract<TraceEntry, { kind: "tool" }>[]; key: string }> = [];
  let group: Extract<TraceEntry, { kind: "tool" }>[] = [];

  for (const entry of entries) {
    const isCompletedTool = entry.kind === "tool" && !entry.event.isError &&
      (entry.event.status === "complete" || (!entry.event.status && !!entry.event.result));
    if (isCompletedTool) {
      group.push(entry as Extract<TraceEntry, { kind: "tool" }>);
    } else {
      if (group.length >= 2) {
        merged.push({ kind: "subGroup", entries: group, key: group.map((e) => e.key).join("-") });
      } else if (group.length === 1) {
        merged.push(group[0]!);
      }
      group = [];
      merged.push(entry);
    }
  }
  if (group.length >= 2) {
    merged.push({ kind: "subGroup", entries: group, key: group.map((e) => e.key).join("-") });
  } else if (group.length === 1) {
    merged.push(group[0]!);
  }

  if (merged.length === 0) return null;

  return (
    <div className="sub-path">
      <div className="sub-path-line" />
      {merged.map((item) => {
        if (item.kind === "subGroup") {
          return <SubGroup key={item.key} entries={item.entries} />;
        }
        return <SubNode key={item.key} entry={item as TraceEntry} />;
      })}
    </div>
  );
}

// ============================================================================
// Sub-node (Layer 2): individual thinking or tool entry
// ============================================================================

function SubNode({ entry }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(() => {
    if (entry.kind === "tool") {
      const t = entry.event;
      return t.status === "running" || t.status === "pending" || !!t.isError;
    }
    return false;
  });

  // Re-expand when tool status changes to running or error
  useEffect(() => {
    if (entry.kind === "tool") {
      const t = entry.event;
      if (t.status === "running" || t.status === "pending" || t.isError) setExpanded(true);
    }
  }, [entry.kind === "tool" ? entry.event.status : null, entry.kind === "tool" ? entry.event.isError : null]);

  const status = traceEntryStatusColor(entry);

  if (entry.kind === "thinking") {
    const text = entry.block.thinking || "";
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    return (
      <div className="sub-node">
        <div className={`sub-dot ${status}`} />
        <button className="sub-node-toggle" onClick={() => setExpanded(!expanded)}>
          <span className="sub-node-icon">
            {expanded ? <ChevronDown size={12} className="sub-node-chevron open" /> : <ChevronRight size={12} className="sub-node-chevron" />}
          </span>
          <span className="sub-node-label">Thinking</span>
          <span className="sub-node-summary">{preview}</span>
        </button>
        {expanded && (
          <div className="sub-node-detail">
            <pre>{text}</pre>
          </div>
        )}
      </div>
    );
  }

  // Tool entry
  const tool = entry.event;
  const toolName = tool.toolName;
  const argSummary = formatArgSummary(tool.args);
  const statusLabel = tool.isError ? "error" : tool.status === "running" ? "running..." : tool.status === "pending" ? "preparing" : "";

  return (
    <div className="sub-node">
      <div className={`sub-dot ${status}`} />
      <button className="sub-node-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="sub-node-icon">
          {expanded ? <ChevronDown size={12} className="sub-node-chevron open" /> : <ChevronRight size={12} className="sub-node-chevron" />}
        </span>
        <span className="sub-node-label">{toolName}</span>
        {argSummary && <span className="sub-node-summary">{argSummary}</span>}
        {statusLabel && (
          <span className={`sub-node-status badge ${tool.isError ? "badge-error" : "badge-pending"}`}>{statusLabel}</span>
        )}
      </button>
      {expanded && (
        <div className="sub-node-detail">
          {tool.args && <ToolArgsTable args={tool.args} />}
          {(tool.result || tool.partialResult) && (
            <ToolResultDetails blocks={tool.result?.content || tool.partialResult?.content || []} isPartial={tool.status === "running"} />
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-group (Layer 2): merged completed tools
// ============================================================================

function SubGroup({ entries }: { entries: Extract<TraceEntry, { kind: "tool" }>[] }) {
  const [expanded, setExpanded] = useState(false);
  const names = entries.map((e) => e.event.toolName).filter(Boolean).join(", ");

  return (
    <div className="sub-node">
      <div className="sub-dot complete" />
      <button className="sub-group-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="sub-node-label">{entries.length} tools</span>
        {names && <span className="sub-node-summary">{names}</span>}
        <span className="sub-node-status badge badge-ok">done</span>
      </button>
      {expanded && (
        <div className="sub-group-items">
          {entries.map((entry) => (
            <SubNode key={entry.key} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Streaming assistant card (trace + text in one card for live streaming)
// ============================================================================

function StreamingAssistantCard({ trace, message }: { trace: ExecutionTrace; message: StreamingMessage }) {
  const thinkingCount = trace.entries.filter((e) => e.kind === "thinking").length;
  const toolCount = trace.entries.filter((e) => e.kind === "tool").length;
  const hasTrace = thinkingCount > 0 || toolCount > 0;

  const textBlocks = message.content.filter((b) => b.type === "text");
  const imageBlocks = message.content.filter((b) => b.type === "image");
  const otherBlocks = message.content.filter((b) => !["text", "thinking", "toolCall", "image"].includes(b.type));

  return (
    <>
      {hasTrace && (
        <PathNode dotKind="trace" dotTone="active">
          <TraceCard trace={trace} active />
        </PathNode>
      )}
      <PathNode dotKind="assistant">
        <article className="message assistant streaming">
          <div className="message-role">
            <Loader2 size={12} className="spinner" />
            {message.role && message.role !== "assistant" ? `${message.role} streaming...` : "Assistant streaming..."}
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
      </PathNode>
    </>
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

function renderTimelineItem(item: TimelineItem, index: number, prefix = "history"): React.ReactNode {
  if (item.kind === "message") {
    const msg = item.message;
    const dotKind = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "";
    return (
      <PathNode key={`${prefix}-${messageKey(msg, index)}`} dotKind={dotKind}>
        <MessageBubble message={msg} />
      </PathNode>
    );
  }
  if (item.kind === "trace") {
    const trace = item.trace;
    const overall = traceOverallStatus(trace.entries, false);
    return (
      <PathNode key={`${prefix}-trace-${trace.id || index}`} dotKind="trace" dotTone={overall}>
        <TraceCard trace={trace} />
      </PathNode>
    );
  }
  if (item.kind === "toolEvent") {
    const event = item.event;
    const tone = event.isError ? "error" as const : event.status === "complete" || (!event.status && event.result) ? "ok" as const : "active" as const;
    return (
      <PathNode key={`${prefix}-tool-${event.toolCallId || index}`} dotKind="tool-result" dotTone={tone}>
        <ToolExecutionBubble tool={event} />
      </PathNode>
    );
  }
  if (item.kind === "toolGroup") {
    const ids = item.events.map((event, i) => event.event.toolCallId || i).join(":");
    return (
      <PathNode key={`${prefix}-tg-${ids || index}`} dotKind="tool-result" dotTone="ok">
        <ToolGroupBubble events={item.events} />
      </PathNode>
    );
  }
  // Unknown timeline item kind — render nothing
  return null;
}

/** Status progression: pending → running → complete. Never regress. */

// ============================================================================
// Stats bar
// ============================================================================

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
// Bootstrap (skipped in test / SSR environments)
// ============================================================================
const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <InteractiveDialogProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </InteractiveDialogProvider>
    </React.StrictMode>
  );
}

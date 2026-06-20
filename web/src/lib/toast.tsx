import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { Info, RotateCcw, AlertTriangle, Bell, X } from "lucide-react";
import type { ActivityEvent } from "../../../shared/src/index.js";

// ============================================================================
// Types
// ============================================================================

export type Toast = {
  id: string;
  type: string;
  payload: ActivityEvent;
  autoDismissMs?: number;
  replaceGroup?: string;
  timestamp: number;
};

type ToastInput = Omit<Toast, "timestamp"> & { dismissGroups?: string[] };

type ToastContextValue = {
  toasts: Toast[];
  pushToast: (input: ToastInput) => void;
  dismissToast: (id: string) => void;
};

// ============================================================================
// Auto-dismiss rules: how long each toast type stays visible
// ============================================================================

function getAutoDismissMs(type: string, payload: ActivityEvent): number | undefined {
  switch (type) {
    case "thinking_level_changed":
    case "session_info_changed":
      return 3000;
    case "auto_retry_end":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (payload as any).success ? 2000 : undefined;
    case "extension_ui_request":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof (payload as any).timeout === "number" ? (payload as any).timeout : undefined;
    case "compaction_end":
      return undefined; // manual close only
    default:
      return undefined;
  }
}

// ============================================================================
// Replace group: toasts in the same group replace each other
// ============================================================================

function getReplaceGroup(type: string, payload: ActivityEvent): string | undefined {
  switch (type) {
    case "auto_retry_start":
    case "auto_retry_end":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return `retry-attempt-${(payload as any).attempt}`;
    case "agent_retry_pending":
      return "retry-pending";
    default:
      return undefined;
  }
}

// ============================================================================
// Context
// ============================================================================

const ToastContext = createContext<ToastContextValue>({
  toasts: [],
  pushToast: () => {},
  dismissToast: () => {}
});

export function useToast() {
  return useContext(ToastContext);
}

// ============================================================================
// Provider
// ============================================================================

const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
    };
  }, []);

  const pushToast = useCallback((input: ToastInput) => {
    const autoDismissMs = input.autoDismissMs ?? getAutoDismissMs(input.type, input.payload);
    const replaceGroup = input.replaceGroup ?? getReplaceGroup(input.type, input.payload);

    const toast: Toast = {
      id: input.id,
      type: input.type,
      payload: input.payload,
      autoDismissMs,
      replaceGroup,
      timestamp: Date.now()
    };

    setToasts((prev) => {
      let next = [...prev];

      // Dismiss toasts in specified groups (e.g. auto_retry_start clears retry-pending)
      if (input.dismissGroups && input.dismissGroups.length > 0) {
        const dismissSet = new Set(input.dismissGroups);
        for (const t of next) {
          if (t.replaceGroup && dismissSet.has(t.replaceGroup)) {
            clearTimer(t.id);
          }
        }
        next = next.filter((t) => !t.replaceGroup || !dismissSet.has(t.replaceGroup));
      }

      // Replace existing toast in the same group
      if (replaceGroup) {
        const idx = next.findIndex((t) => t.replaceGroup === replaceGroup);
        if (idx >= 0) {
          clearTimer(next[idx]!.id);
          next[idx] = toast;
        } else {
          next.push(toast);
        }
      } else {
        next.push(toast);
      }

      // Trim to MAX_TOASTS (keep newest)
      if (next.length > MAX_TOASTS) {
        for (const t of next.slice(0, next.length - MAX_TOASTS)) {
          clearTimer(t.id);
        }
        next = next.slice(-MAX_TOASTS);
      }

      return next;
    });

    // Set auto-dismiss timer
    if (autoDismissMs !== undefined && autoDismissMs > 0) {
      const timer = setTimeout(() => {
        dismissToast(toast.id);
      }, autoDismissMs);
      timersRef.current.set(toast.id, timer);
    }
  }, []);

  const dismissToast = useCallback((id: string) => {
    clearTimer(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  function clearTimer(id: string) {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }

  return (
    <ToastContext.Provider value={{ toasts, pushToast, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

// ============================================================================
// Container: fixed overlay for the toast stack
// ============================================================================

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ============================================================================
// Card: individual toast, styled by type
// ============================================================================

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const { type, payload } = toast;
  const config = getToastConfig(type, payload);

  return (
    <div className={`toast-card ${config.tone}`} role="status">
      <span className="toast-icon">{config.icon}</span>
      <div className="toast-body">
        <span className="toast-label">{config.label}</span>
        <span className="toast-text">{config.text}</span>
      </div>
      {config.dismissible && (
        <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Toast config: icon, label, text, tone per event type
// ============================================================================

type ToastConfig = {
  icon: React.ReactNode;
  label: string;
  text: string;
  tone: "" | "ok" | "warn" | "error";
  dismissible: boolean;
};

function getToastConfig(type: string, payload: ActivityEvent): ToastConfig {
  switch (type) {
    case "thinking_level_changed": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const level = (payload as any).level || "default";
      return {
        icon: <Info size={14} />,
        label: "Thinking",
        text: `Thinking level set to ${level}`,
        tone: "",
        dismissible: true
      };
    }
    case "session_info_changed": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const name = (payload as any).name;
      return {
        icon: <Info size={14} />,
        label: "Session",
        text: name ? `Session renamed to ${name}` : "Session name cleared",
        tone: "",
        dismissible: true
      };
    }
    case "auto_retry_start": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = payload as any;
      return {
        icon: <RotateCcw size={14} className="spinner-slow" />,
        label: "Retry",
        text: `Retry ${p.attempt}/${p.maxAttempts} in ${formatToastMs(p.delayMs)}: ${p.errorMessage || ""}`,
        tone: "warn",
        dismissible: true
      };
    }
    case "auto_retry_end": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = payload as any;
      return {
        icon: <RotateCcw size={14} />,
        label: "Retry",
        text: p.success
          ? `Retry ${p.attempt} succeeded`
          : `Retry ${p.attempt} failed${p.finalError ? `: ${p.finalError}` : ""}`,
        tone: p.success ? "ok" : "error",
        dismissible: true
      };
    }
    case "agent_retry_pending": {
      return {
        icon: <RotateCcw size={14} className="spinner-slow" />,
        label: "Retry",
        text: "Waiting for retry...",
        tone: "warn",
        dismissible: true
      };
    }
    case "extension_ui_request": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = payload as any;
      const label = p.method === "notify" ? "Notification" : `Extension: ${p.method}`;
      const text = p.message || p.title || p.statusText || p.text || "Extension UI update";
      return {
        icon: <Bell size={14} />,
        label,
        text,
        tone: p.notifyType === "error" ? "error" : p.notifyType === "warning" ? "warn" : "",
        dismissible: true
      };
    }
    case "extension_error": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = payload as any;
      return {
        icon: <AlertTriangle size={14} />,
        label: "Extension",
        text: `${p.extensionPath || "Extension"} failed${p.event ? ` during ${p.event}` : ""}: ${p.error || "Unknown error"}`,
        tone: "error",
        dismissible: true
      };
    }
    case "compaction_end": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = payload as any;
      return {
        icon: <AlertTriangle size={14} />,
        label: "Compaction",
        text: p.errorMessage ? `Compaction failed: ${p.errorMessage}` : p.aborted ? "Compaction cancelled" : "Compaction complete",
        tone: p.errorMessage || p.aborted ? "error" : "ok",
        dismissible: true
      };
    }
    default: {
      return {
        icon: <Info size={14} />,
        label: type || "Event",
        text: JSON.stringify(payload),
        tone: "",
        dismissible: true
      };
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatToastMs(ms: number): string {
  if (!ms || ms <= 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

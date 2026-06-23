import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { X, Check, AlertTriangle, Bell, Terminal } from "lucide-react";
import type { ActivityEvent } from "../../../shared/src/index.js";
import { stripAnsiDisplay } from "./helpers.js";

// ============================================================================
// Types
// ============================================================================

export type DialogItem = {
  id: string;
  event: Extract<ActivityEvent, { type: "extension_ui_request" }>;
  timestamp: number;
  responded: boolean;
};

type DialogContextValue = {
  dialogs: DialogItem[];
  pushDialog: (event: ActivityEvent) => void;
  dismissDialog: (id: string) => void;
  respondToDialog: (id: string, response: string) => Promise<void>;
};

// ============================================================================
// Context
// ============================================================================

const DialogContext = createContext<DialogContextValue>({
  dialogs: [],
  pushDialog: () => {},
  dismissDialog: () => {},
  respondToDialog: async () => {}
});

export function useInteractiveDialog() {
  return useContext(DialogContext);
}

// ============================================================================
// Provider
// ============================================================================

export function InteractiveDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialogs, setDialogs] = useState<DialogItem[]>([]);
  const respondingRef = useRef<Set<string>>(new Set());

  const pushDialog = useCallback((event: ActivityEvent) => {
    if (event.type !== "extension_ui_request") return;

    setDialogs((prev) => {
      // Replace existing dialog with same widgetKey or statusKey
      const key = event.widgetKey || event.statusKey;
      if (key) {
        const idx = prev.findIndex((d) => {
          const dk = d.event.widgetKey || d.event.statusKey;
          return dk === key && !d.responded;
        });
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], event, timestamp: Date.now() };
          return updated;
        }
      }
      return [...prev, { id: event.id, event, timestamp: Date.now(), responded: false }];
    });
  }, []);

  const dismissDialog = useCallback((id: string) => {
    setDialogs((prev) => prev.map((d) => d.id === id ? { ...d, responded: true } : d));
    // Remove after animation delay
    setTimeout(() => {
      setDialogs((prev) => prev.filter((d) => d.id !== id));
    }, 200);
  }, []);

  const respondToDialog = useCallback(async (id: string, response: string) => {
    if (respondingRef.current.has(id)) return;
    respondingRef.current.add(id);

    try {
      const res = await fetch("/api/extension-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: id, response })
      });
      if (!res.ok) {
        console.error("Failed to respond to extension UI:", res.statusText);
      }
    } catch (err) {
      console.error("Failed to respond to extension UI:", err);
    } finally {
      respondingRef.current.delete(id);
      // Mark as responded and remove
      setDialogs((prev) => prev.map((d) => d.id === id ? { ...d, responded: true } : d));
      setTimeout(() => {
        setDialogs((prev) => prev.filter((d) => d.id !== id));
      }, 200);
    }
  }, []);

  return (
    <DialogContext.Provider value={{ dialogs, pushDialog, dismissDialog, respondToDialog }}>
      {children}
      <InteractiveDialogContainer />
    </DialogContext.Provider>
  );
}

// ============================================================================
// Container: modal overlay
// ============================================================================

function InteractiveDialogContainer() {
  const { dialogs, dismissDialog } = useInteractiveDialog();

  // Close topmost dialog on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && dialogs.length > 0) {
        const top = dialogs[dialogs.length - 1];
        if (top && !isDialogRequired(top.event)) {
          e.preventDefault();
          dismissDialog(top.id);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialogs, dismissDialog]);

  if (dialogs.length === 0) return null;

  // Show only the topmost dialog
  const active = dialogs[dialogs.length - 1];
  if (!active || active.responded) return null;

  return (
    <div className="dialog-backdrop" onClick={() => {
      if (!isDialogRequired(active.event)) dismissDialog(active.id);
    }}>
      <InteractiveDialogCard
        item={active}
        onClickBackdrop={() => {
          if (!isDialogRequired(active.event)) dismissDialog(active.id);
        }}
      />
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function isDialogRequired(event: Extract<ActivityEvent, { type: "extension_ui_request" }>): boolean {
  // Dialogs with options or widget content require user interaction
  return Boolean(event.options) || Boolean(event.widgetKey);
}

function getDialogTone(event: Extract<ActivityEvent, { type: "extension_ui_request" }>): string {
  if (event.notifyType === "error") return "error";
  if (event.notifyType === "warning") return "warn";
  return "";
}

function getDialogIcon(event: Extract<ActivityEvent, { type: "extension_ui_request" }>): React.ReactNode {
  if (event.notifyType === "error") return <AlertTriangle size={18} />;
  if (event.options) return <Terminal size={18} />;
  return <Bell size={18} />;
}

// ============================================================================
// Card: the main dialog
// ============================================================================

function InteractiveDialogCard({ item }: {
  item: DialogItem;
}) {
  const { event } = item;
  const { respondToDialog, dismissDialog } = useInteractiveDialog();
  const tone = getDialogTone(event);
  const hasOptions = Array.isArray(event.options) && event.options.length > 0;
  const hasWidget = Array.isArray(event.widgetLines) && event.widgetLines.length > 0;
  const title = event.title ? stripAnsiDisplay(event.title).trim() : "";
  const message = event.message ? stripAnsiDisplay(event.message).trim() : (event.text ? stripAnsiDisplay(event.text).trim() : "");

  // Options selection state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [event.options]);

  // Scroll selected option into view
  useEffect(() => {
    if (hasOptions) {
      const el = optionRefs.current[selectedIndex];
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, hasOptions]);

  // Keyboard handler for the card
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (hasOptions) {
      const opts = event.options!;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(opts.length - 1, prev + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = opts[selectedIndex];
        if (selected !== undefined) {
          void respondToDialog(item.id, selected);
        }
      } else if (e.key === "Escape" && !isDialogRequired(event)) {
        e.preventDefault();
        dismissDialog(item.id);
      }
    } else if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      if (e.key === "Enter") {
        // Confirm / acknowledge
        void respondToDialog(item.id, "ok");
      } else if (!isDialogRequired(event)) {
        dismissDialog(item.id);
      }
    }
  }, [hasOptions, event, selectedIndex, item.id, respondToDialog, dismissDialog]);

  return (
    <div
      className={`dialog-card ${tone}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={title || "Extension dialog"}
      tabIndex={-1}
      ref={(el) => el?.focus()}
    >
      {/* Header */}
      <div className="dialog-header">
        <span className="dialog-header-icon">{getDialogIcon(event)}</span>
        <span className="dialog-header-title">{title || "Extension"}</span>
        {!isDialogRequired(event) && (
          <button
            className="dialog-close-btn"
            onClick={() => dismissDialog(item.id)}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="dialog-body">
        {/* Message / description */}
        {message && (
          <div className="dialog-message">{message}</div>
        )}

        {/* Widget text lines */}
        {hasWidget && (
          <div className="dialog-widget" ref={listRef}>
            {event.widgetLines!.map((line, i) => (
              <div key={i} className="dialog-widget-line">{stripAnsiDisplay(line)}</div>
            ))}
          </div>
        )}

        {/* Options list */}
        {hasOptions && (
          <div className="dialog-options" role="listbox" aria-label="Options">
            {event.options!.map((opt, i) => (
              <div
                key={i}
                ref={(el) => { optionRefs.current[i] = el; }}
                className={`dialog-option${i === selectedIndex ? " active" : ""}`}
                role="option"
                aria-selected={i === selectedIndex}
                onClick={() => void respondToDialog(item.id, opt)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="dialog-option-check">
                  {i === selectedIndex && <Check size={14} />}
                </span>
                <span className="dialog-option-text">{stripAnsiDisplay(opt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="dialog-footer">
        {hasOptions ? (
          <>
            <button
              className="dialog-btn dialog-btn-primary"
              onClick={() => {
                const opts = event.options!;
                const selected = opts[selectedIndex];
                if (selected !== undefined) void respondToDialog(item.id, selected);
              }}
            >
              Confirm
            </button>
            {!isDialogRequired(event) && (
              <button
                className="dialog-btn dialog-btn-secondary"
                onClick={() => dismissDialog(item.id)}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={() => void respondToDialog(item.id, "ok")}
          >
            OK
          </button>
        )}
      </div>
    </div>
  );
}

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ToastProvider, useToast } from "../src/lib/toast.js";
import type { ActivityEvent } from "../../shared/src/index.js";

// ---------------------------------------------------------------------------
// Test helper: component that exposes toast operations
// ---------------------------------------------------------------------------

function ToastTester({ onPush }: { onPush?: (push: ReturnType<typeof useToast>["pushToast"]) => void }) {
  const { toasts, pushToast, dismissToast } = useToast();
  // Expose pushToast for imperative testing
  onPush?.(pushToast);

  return (
    <div>
      <span data-testid="count">{toasts.length}</span>
      {toasts.map((t) => (
        <div key={t.id} data-testid={`toast-${t.id}`}>
          <span data-testid={`toast-type-${t.id}`}>{t.type}</span>
          <button data-testid={`dismiss-${t.id}`} onClick={() => dismissToast(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

function renderTester() {
  let pushRef: ReturnType<typeof useToast>["pushToast"] | undefined;
  const result = render(
    <ToastProvider>
      <ToastTester onPush={(p) => { pushRef = p; }} />
    </ToastProvider>
  );
  return { ...result, getPush: () => pushRef! };
}

// ---------------------------------------------------------------------------
// A minimal ActivityEvent for test payloads
// ---------------------------------------------------------------------------

function thinkingEvent(id = "t1", level = "high"): ActivityEvent {
  return { id, type: "thinking_level_changed", timestamp: Date.now(), level } as ActivityEvent;
}

function retryStartEvent(id = "r1", attempt = 1): ActivityEvent {
  return { id, type: "auto_retry_start", timestamp: Date.now(), attempt, maxAttempts: 3, delayMs: 5000, errorMessage: "Rate limit" } as ActivityEvent;
}

function retryEndEvent(id = "r2", attempt = 1, success = true): ActivityEvent {
  return { id, type: "auto_retry_end", timestamp: Date.now(), success, attempt, ...(success ? {} : { finalError: "Exhausted" }) } as ActivityEvent;
}

function retryPendingEvent(id = "rp1"): ActivityEvent {
  return { id, type: "agent_retry_pending", timestamp: Date.now() } as unknown as ActivityEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToastProvider", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders children and starts with empty toast stack", () => {
    renderTester();
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("pushToast adds a toast to the stack", () => {
    const { getPush } = renderTester();
    act(() => {
      getPush()({ id: "t1", type: "thinking_level_changed", payload: thinkingEvent("t1") });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("toast-type-t1").textContent).toBe("thinking_level_changed");
  });

  it("dismissToast removes a toast from the stack", () => {
    const { getPush } = renderTester();
    act(() => {
      getPush()({ id: "t1", type: "thinking_level_changed", payload: thinkingEvent("t1") });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    fireEvent.click(screen.getByTestId("dismiss-t1"));
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("auto-dismisses thinking_level_changed after 3 seconds", () => {
    vi.useFakeTimers();
    const { getPush } = renderTester();
    act(() => {
      getPush()({ id: "t1", type: "thinking_level_changed", payload: thinkingEvent("t1") });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByTestId("count").textContent).toBe("1");

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("auto-dismisses successful retry_end after 2 seconds", () => {
    vi.useFakeTimers();
    const { getPush } = renderTester();
    act(() => {
      getPush()({ id: "r2", type: "auto_retry_end", payload: retryEndEvent("r2", 1, true) });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    act(() => vi.advanceTimersByTime(1999));
    expect(screen.getByTestId("count").textContent).toBe("1");

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("does NOT auto-dismiss failed retry_end", () => {
    vi.useFakeTimers();
    const { getPush } = renderTester();
    act(() => {
      getPush()({ id: "r2", type: "auto_retry_end", payload: retryEndEvent("r2", 1, false) });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("replaces toasts in the same replace group", () => {
    const { getPush } = renderTester();

    // retry_start and retry_end with same attempt should replace each other
    act(() => {
      getPush()({ id: "rs1", type: "auto_retry_start", payload: retryStartEvent("rs1", 2) });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("toast-type-rs1").textContent).toBe("auto_retry_start");

    act(() => {
      getPush()({ id: "re2", type: "auto_retry_end", payload: retryEndEvent("re2", 2, true) });
    });
    // Should still be 1 — replaced, not added
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("toast-type-re2").textContent).toBe("auto_retry_end");
  });

  it("dismissGroups clears matching toasts on push", () => {
    const { getPush } = renderTester();

    // Push retry_pending first
    act(() => {
      getPush()({ id: "rp1", type: "agent_retry_pending", payload: retryPendingEvent("rp1") });
    });
    expect(screen.getByTestId("count").textContent).toBe("1");

    // Push retry_start with dismissGroups targeting retry-pending
    act(() => {
      getPush()({
        id: "rs1",
        type: "auto_retry_start",
        payload: retryStartEvent("rs1", 1),
        dismissGroups: ["retry-pending"]
      });
    });
    // retry_pending should be gone, only retry_start remains
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("toast-type-rs1").textContent).toBe("auto_retry_start");
  });

  it("caps toasts at MAX_TOASTS (5), keeping newest", () => {
    const { getPush } = renderTester();

    for (let i = 1; i <= 7; i++) {
      act(() => {
        getPush()({ id: `t${i}`, type: "thinking_level_changed", payload: thinkingEvent(`t${i}`) });
      });
    }
    // Only 5 remain
    expect(screen.getByTestId("count").textContent).toBe("5");
    // Oldest should be removed (t1, t2)
    expect(screen.queryByTestId("toast-type-t1")).toBeNull();
    expect(screen.queryByTestId("toast-type-t2")).toBeNull();
    // Newest should be present
    expect(screen.getByTestId("toast-type-t7").textContent).toBe("thinking_level_changed");
  });

  it("cleans up timers on dismiss", () => {
    vi.useFakeTimers();
    const { getPush } = renderTester();
    act(() => {
      getPush()({ id: "t1", type: "thinking_level_changed", payload: thinkingEvent("t1") });
    });
    // Dismiss before timeout
    fireEvent.click(screen.getByTestId("dismiss-t1"));
    expect(screen.getByTestId("count").textContent).toBe("0");

    // Timer should be cleared — advancing should not error or re-dismiss
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("count").textContent).toBe("0");
  });
});



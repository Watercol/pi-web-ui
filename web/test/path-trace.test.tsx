import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { traceEntryStatusColor, traceOverallStatus } from "../src/lib/helpers.js";
import type { ExecutionTrace, TraceEntry } from "../src/lib/helpers.js";
import type { ToolExecutionEvent } from "../../shared/src/index.js";
import { TraceCard } from "../src/main.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function thinkingEntry(key = "t1"): TraceEntry {
  return { kind: "thinking", block: { type: "thinking", thinking: "I need to read the file first" }, key };
}

function toolEntry(key: string, overrides: Partial<ToolExecutionEvent> = {}): Extract<TraceEntry, { kind: "tool" }> {
  return {
    kind: "tool",
    key,
    event: {
      toolCallId: key,
      toolName: "read",
      args: { path: "/foo/bar.ts" },
      status: "pending",
      ...overrides
    }
  };
}

// ---------------------------------------------------------------------------
// traceEntryStatusColor
// ---------------------------------------------------------------------------

describe("traceEntryStatusColor", () => {
  it("returns thinking for thinking entries", () => {
    expect(traceEntryStatusColor(thinkingEntry())).toBe("thinking");
  });

  it("returns pending for tool with status pending", () => {
    expect(traceEntryStatusColor(toolEntry("t2", { status: "pending" }))).toBe("pending");
  });

  it("returns running for tool with status running", () => {
    expect(traceEntryStatusColor(toolEntry("t3", { status: "running" }))).toBe("running");
  });

  it("returns complete for tool with status complete", () => {
    expect(traceEntryStatusColor(toolEntry("t4", { status: "complete" }))).toBe("complete");
  });

  it("returns complete for tool with no status but has result", () => {
    expect(traceEntryStatusColor(toolEntry("t5", { status: undefined, result: { content: [] } }))).toBe("complete");
  });

  it("returns error for tool with isError", () => {
    expect(traceEntryStatusColor(toolEntry("t6", { isError: true }))).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// traceOverallStatus
// ---------------------------------------------------------------------------

describe("traceOverallStatus", () => {
  it("returns active when streaming", () => {
    const entries: TraceEntry[] = [thinkingEntry(), toolEntry("t1", { status: "running" })];
    expect(traceOverallStatus(entries, true)).toBe("active");
  });

  it("returns error when any tool has error", () => {
    const entries: TraceEntry[] = [thinkingEntry(), toolEntry("t1", { isError: true })];
    expect(traceOverallStatus(entries, false)).toBe("error");
  });

  it("returns complete when all tools done and at least one tool exists", () => {
    const entries: TraceEntry[] = [thinkingEntry(), toolEntry("t1", { status: "complete" })];
    expect(traceOverallStatus(entries, false)).toBe("complete");
  });

  it("returns active when some tools are not complete", () => {
    const entries: TraceEntry[] = [thinkingEntry(), toolEntry("t1", { status: "running" })];
    expect(traceOverallStatus(entries, false)).toBe("active");
  });

  it("returns complete for thinking-only trace when not active", () => {
    const entries: TraceEntry[] = [thinkingEntry("th1"), thinkingEntry("th2")];
    expect(traceOverallStatus(entries, false)).toBe("complete");
  });

  it("returns active for thinking-only trace when active (streaming)", () => {
    const entries: TraceEntry[] = [thinkingEntry("th1")];
    expect(traceOverallStatus(entries, true)).toBe("active");
  });

  it("returns active for empty entries", () => {
    expect(traceOverallStatus([], false)).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// TraceCard component
// ---------------------------------------------------------------------------

describe("TraceCard", () => {
  // Ensure cleanup between tests to avoid element accumulation
  afterEach(() => { cleanup(); });

  it("renders null when trace has no entries", () => {
    const trace: ExecutionTrace = { id: "empty", entries: [] };
    const { container } = render(<TraceCard trace={trace} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders header with thinking and tool counts", () => {
    const trace: ExecutionTrace = {
      id: "t1",
      entries: [thinkingEntry("th1"), toolEntry("t1", { status: "complete" })]
    };
    const { container } = render(<TraceCard trace={trace} />);
    const header = container.querySelector(".trace-card-header");
    expect(header?.textContent).toContain("Trace");
    expect(header?.textContent).toContain("1 thinking");
    expect(header?.textContent).toContain("1 action");
  });

  it("renders collapsed by default for completed traces", () => {
    const trace: ExecutionTrace = {
      id: "t1",
      entries: [thinkingEntry("th2"), toolEntry("t2", { status: "complete" })]
    };
    const { container } = render(<TraceCard trace={trace} />);
    // Sub-path should not be visible when collapsed
    expect(container.querySelector(".sub-path")).toBeNull();
  });

  it("expands when header is clicked", () => {
    const trace: ExecutionTrace = {
      id: "t1",
      entries: [thinkingEntry("th3"), toolEntry("t3", { status: "complete" })]
    };
    const { container } = render(<TraceCard trace={trace} />);
    const header = container.querySelector(".trace-card-header") as HTMLElement;
    fireEvent.click(header);
    // Tool name "read" should now be visible in sub-path
    const subPath = container.querySelector(".sub-path");
    expect(subPath?.textContent).toContain("read");
  });

  it("shows Working label when active", () => {
    const trace: ExecutionTrace = {
      id: "t1",
      entries: [toolEntry("t1", { status: "running" })]
    };
    render(<TraceCard trace={trace} active />);
    const elements = screen.getAllByText("Working");
    expect(elements.length).toBeGreaterThan(0);
  });

  it("auto-expands when active", () => {
    const trace: ExecutionTrace = {
      id: "t1",
      entries: [toolEntry("t1", { status: "running" })]
    };
    const { container } = render(<TraceCard trace={trace} active />);
    // Should be visible when expanded
    const subPath = container.querySelector(".sub-path");
    expect(subPath?.textContent).toContain("read");
  });
});

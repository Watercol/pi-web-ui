import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { PiRpcClient } from "../src/pi-rpc-client.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakePi = path.join(testDir, "fixtures", "fake-pi.mjs");
const exitPi = path.join(testDir, "fixtures", "exit-pi.mjs");

function config(piBin = fakePi): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    cwd: process.cwd(),
    piBin,
    devAssets: true
  };
}

describe("PiRpcClient", () => {
  it("resolves pending requests by id and receives streamed events", async () => {
    const client = new PiRpcClient(config());
    const events: string[] = [];
    const activities: string[] = [];
    const toolArgs: unknown[] = [];
    client.on("error", () => undefined);
    client.on("event", (event) => events.push(event.type));
    client.on("activity", (event) => activities.push(event.type));
    client.on("messageUpdate", (message) => {
      const toolCall = message.content.find((block) => block.type === "toolCall");
      if (toolCall) toolArgs.push(toolCall.input);
    });
    client.start();

    const state = await client.refreshState();
    expect(state.sessionId).toBe("fake-session");

    const messages = await client.refreshMessages();
    expect(messages).toEqual([{ role: "assistant", content: "ready" }]);

    await client.prompt("hello");
    await waitFor(() => events.includes("agent_end"));
    expect(activities).toEqual(expect.arrayContaining([
      "turn_start",
      "thinking_level_changed",
      "session_info_changed",
      "auto_retry_start",
      "auto_retry_end",
      "extension_ui_request",
      "turn_end"
    ]));
    expect(activities).toContain("thinking_level_changed");
    expect(activities).toContain("session_info_changed");
    expect(toolArgs).toContainEqual({ path: "package.json" });
    expect(client.getMessages()).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "echo: hello",
        usage: {
          input: 1200,
          output: 80,
          cacheRead: 300,
          cacheWrite: 20,
          totalTokens: 1600,
          cost: { total: 0.0123 }
        },
        responseId: "fake-response-1"
      }
    ]);
    expect(client.getState().stats).toMatchObject({
      sessionId: "fake-session",
      tokens: {
        input: 1200,
        output: 80,
        cacheRead: 300,
        cacheWrite: 20,
        total: 1600
      },
      cost: 0.0123,
      contextUsage: {
        tokens: 1520,
        contextWindow: 100000,
        percent: 1.52
      }
    });

    client.stop();
    await waitFor(() => !client.getState().processRunning);
  });

  it("rejects all pending requests when the process exits", async () => {
    const client = new PiRpcClient(config(exitPi));
    client.on("error", () => undefined);
    client.start();

    const pending = client.request("get_state", {}, 5_000);
    await expect(pending).rejects.toThrow(/exited|socket|EPIPE|not running/i);
  });
});

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

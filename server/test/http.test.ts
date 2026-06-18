import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { createApp } from "../src/http.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const tempDirs: string[] = [];
const fakePi = path.join(testDir, "fixtures", "fake-pi.mjs");

function config(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    cwd: process.cwd(),
    piBin: fakePi,
    devAssets: true
  };
}

describe("HTTP API", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it("streams Pi events over SSE after prompt", async () => {
    const server = await startServer(config());
    servers.push(server);

    const eventResponse = await fetch(`${server.url}/api/events`);
    expect(eventResponse.ok).toBe(true);
    const reader = eventResponse.body?.getReader();
    if (!reader) throw new Error("Missing SSE body reader");

    const promptResponse = await fetch(`${server.url}/api/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "list files" })
    });
    expect(promptResponse.ok).toBe(true);

    const text = await readUntil(reader, "agent_end");
    expect(text).toContain("message_update");
    expect(text).toContain("extension_ui_request");
    expect(text).toContain("thinking_level_changed");
    expect(text).toContain("agent_end");
    await reader.cancel();
  });

  it("lists and switches models", async () => {
    const server = await startServer(config());
    servers.push(server);

    const modelsResponse = await fetch(`${server.url}/api/models`);
    expect(modelsResponse.ok).toBe(true);
    const modelsBody = (await modelsResponse.json()) as { models: Array<{ provider: string; id: string }> };
    expect(modelsBody.models).toContainEqual(expect.objectContaining({ provider: "fake", id: "fake/fast" }));

    const switchResponse = await fetch(`${server.url}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "fake", modelId: "fake/fast" })
    });
    expect(switchResponse.ok).toBe(true);

    const stateResponse = await fetch(`${server.url}/api/state`);
    const state = (await stateResponse.json()) as { model?: { provider?: string; id?: string } };
    expect(state.model).toMatchObject({ provider: "fake", id: "fake/fast" });
  });

  it("switches thinking levels", async () => {
    const server = await startServer(config());
    servers.push(server);

    const switchResponse = await fetch(`${server.url}/api/thinking-level`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "high" })
    });
    expect(switchResponse.ok).toBe(true);

    const stateResponse = await fetch(`${server.url}/api/state`);
    const state = (await stateResponse.json()) as { thinkingLevel?: string };
    expect(state.thinkingLevel).toBe("high");
  });

  it("lists, switches, and creates sessions", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-ui-agent-"));
    tempDirs.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const server = await startServer(config());
    servers.push(server);

    await waitForHttp(async () => {
      const stateResponse = await fetch(`${server.url}/api/state`);
      const state = (await stateResponse.json()) as { sessionId?: string };
      return state.sessionId === "fake-session";
    });

    const sessionsResponse = await fetch(`${server.url}/api/sessions`);
    expect(sessionsResponse.ok).toBe(true);
    const sessionsBody = (await sessionsResponse.json()) as { sessions: Array<{ path: string; id: string; name?: string }> };
    expect(sessionsBody.sessions).toHaveLength(1);
    expect(sessionsBody.sessions[0]).toMatchObject({ id: "fake-session", name: "Fake session" });

    const switchResponse = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath: sessionsBody.sessions[0]!.path })
    });
    expect(switchResponse.ok).toBe(true);

    const newResponse = await fetch(`${server.url}/api/session/new`, { method: "POST" });
    expect(newResponse.ok).toBe(true);

    const stateResponse = await fetch(`${server.url}/api/state`);
    const state = (await stateResponse.json()) as { sessionId?: string };
    expect(state.sessionId).toMatch(/^fake-session-/);
  });
});

async function startServer(config: ServerConfig) {
  const app = createApp(config);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        app.closeAllConnections();
        app.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const started = Date.now();
  while (!text.includes(needle) && Date.now() - started < 2_000) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function waitForHttp(assertion: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for HTTP condition");
}

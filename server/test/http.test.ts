import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { createApp } from "../src/http.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const servers: Awaited<ReturnType<typeof startServer>>[] = [];
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

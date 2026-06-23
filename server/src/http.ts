import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSwitchRequest, PromptRequest, ServerEvent, SessionSwitchRequest, ThinkingLevelSwitchRequest } from "../../shared/src/index.js";
import type { ServerConfig } from "./config.js";
import { PiRpcClient as PiRpcClientClass, type PiRpcClient } from "./pi-rpc-client.js";
import { listSessions } from "./sessions.js";

type ExtensionUiResponseRequest = {
  eventId: string;
  response: string;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MAX_FILE_DEPTH = 10;
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".vite", ".next", "__pycache__", ".venv", "venv", ".env"]);
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

export function createApp(config: ServerConfig, rpc: PiRpcClient = new PiRpcClientClass(config)): http.Server {
  const sseClients = new Set<ServerResponse>();

  const broadcast = (event: ServerEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
  };

  rpc.on("event", (event) => broadcast({ type: "pi_event", event }));
  rpc.on("state", (state) => broadcast({ type: "state", state }));
  rpc.on("messages", (messages) => broadcast({ type: "messages", messages }));
  rpc.on("error", (error) => broadcast({ type: "error", message: error.message }));
  rpc.on("messageStart", (message) => broadcast({ type: "message_start", message }));
  rpc.on("messageUpdate", (message) => broadcast({ type: "message_update", message }));
  rpc.on("messageEnd", (message) => broadcast({ type: "message_end", message }));
  rpc.on("toolStart", (event) => broadcast({ type: "tool_start", event }));
  rpc.on("toolUpdate", (event) => broadcast({ type: "tool_update", event }));
  rpc.on("toolEnd", (event) => broadcast({ type: "tool_end", event }));
  rpc.on("compactionStart", (reason) => broadcast({ type: "compaction_start", reason }));
  rpc.on("compactionEnd", (event) => broadcast({ type: "compaction_end", ...event }));
  rpc.on("queueUpdate", (queue) => broadcast({ type: "queue_update", queue }));
  rpc.on("agentStart", () => broadcast({ type: "agent_start" }));
  rpc.on("agentEnd", (messages, willRetry) => broadcast({ type: "agent_end", messages, willRetry }));
  rpc.on("activity", (event) => broadcast({ type: "activity", event }));
  rpc.start();

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: "Missing URL" });
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(`data: ${JSON.stringify({ type: "connected" } satisfies ServerEvent)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "state", state: rpc.getState() } satisfies ServerEvent)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "messages", messages: rpc.getMessages() } satisfies ServerEvent)}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, rpc);
        return;
      }

      await serveStatic(res, url.pathname, config.devAssets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  server.on("close", () => {
    for (const client of sseClients) client.end();
    rpc.stop();
  });

  return server;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, rpc: PiRpcClient): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, await rpc.refreshState().catch(() => rpc.getState()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/messages") {
    sendJson(res, 200, await rpc.refreshMessages().catch(() => rpc.getMessages()));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    const body = (await readJson(req)) as PromptRequest;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      sendJson(res, 400, { error: "Prompt message is required" });
      return;
    }
    sendJson(res, 200, await rpc.prompt(message));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/abort") {
    sendJson(res, 200, await rpc.abort());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const response = await rpc.getAvailableModels();
    sendJson(res, 200, response.data ?? { models: [] });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/model") {
    const body = (await readJson(req)) as ModelSwitchRequest;
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) {
      sendJson(res, 400, { error: "Model provider and modelId are required" });
      return;
    }
    sendJson(res, 200, await rpc.setModel(provider, modelId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/thinking-level") {
    const body = (await readJson(req)) as ThinkingLevelSwitchRequest;
    const level = typeof body.level === "string" ? body.level.trim() : "";
    if (!validThinkingLevels.has(level)) {
      sendJson(res, 400, { error: "Valid thinking level is required" });
      return;
    }
    sendJson(res, 200, await rpc.setThinkingLevel(level));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const scope = url.searchParams.get("scope") === "all" ? "all" : "current";
    sendJson(res, 200, { sessions: await listSessions(rpc.getState().cwd, scope) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    const body = (await readJson(req)) as SessionSwitchRequest;
    const sessionPath = typeof body.sessionPath === "string" ? body.sessionPath.trim() : "";
    if (!sessionPath) {
      sendJson(res, 400, { error: "Session path is required" });
      return;
    }
    sendJson(res, 200, await rpc.switchSession(sessionPath));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/new") {
    sendJson(res, 200, await rpc.newSession());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/commands") {
    const response = await rpc.getCommands();
    sendJson(res, 200, response.data ?? { commands: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    const stats = await rpc.refreshStats().catch(() => rpc.getSessionStats());
    sendJson(res, 200, stats ?? {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    const cwd = rpc.getState().cwd;
    if (!cwd) {
      sendJson(res, 200, { files: [] });
      return;
    }
    try {
      const files = await walkDir(cwd, cwd, 0);
      files.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      sendJson(res, 200, { files });
    } catch {
      sendJson(res, 200, { files: [] });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/extension-response") {
    const body = (await readJson(req)) as ExtensionUiResponseRequest;
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
    const response = typeof body.response === "string" ? body.response : "";
    if (!eventId) {
      sendJson(res, 400, { error: "eventId is required" });
      return;
    }
    sendJson(res, 200, await rpc.respondToExtensionUi(eventId, response));
    return;
  }

  // --- Built-in command endpoints ---

  if (req.method === "POST" && url.pathname === "/api/compact") {
    const body = (await readJson(req)) as { customInstructions?: string };
    sendJson(res, 200, await rpc.compact(body.customInstructions));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/export") {
    sendJson(res, 200, await rpc.exportHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/copy") {
    sendJson(res, 200, await rpc.getLastAssistantText());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/name") {
    const body = (await readJson(req)) as { name: string };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      sendJson(res, 400, { error: "Session name is required" });
      return;
    }
    sendJson(res, 200, await rpc.setSessionName(name));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/clone") {
    sendJson(res, 200, await rpc.clone());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/fork/messages") {
    sendJson(res, 200, await rpc.getForkMessages());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fork") {
    const body = (await readJson(req)) as { entryId: string };
    const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) {
      sendJson(res, 400, { error: "Entry ID is required" });
      return;
    }
    sendJson(res, 200, await rpc.fork(entryId));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function walkDir(dir: string, baseDir: string, depth: number): Promise<{ name: string; path: string; isDirectory: boolean }[]> {
  if (depth > MAX_FILE_DEPTH) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: { name: string; path: string; isDirectory: boolean }[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Skip hidden files/dirs and ignored directories
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;

    const relativePath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: relativePath, isDirectory: true });
      const subEntries = await walkDir(fullPath, baseDir, depth + 1);
      results.push(...subEntries);
    } else {
      results.push({ name: entry.name, path: relativePath, isDirectory: false });
    }
  }
  return results;
}

async function serveStatic(res: ServerResponse, pathname: string, devAssets: boolean): Promise<void> {
  const base = devAssets ? path.join(rootDir, "web") : path.join(rootDir, "dist", "web");
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(base, normalized));
  if (!filePath.startsWith(base)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    if (path.extname(normalized)) {
      sendJson(res, 404, { error: "Not found" });
    } else {
      await serveStatic(res, "/", devAssets);
    }
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

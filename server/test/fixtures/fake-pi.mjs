#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

let buffer = "";
const writes = [];
let currentModel = { id: "fake/model", provider: "fake", contextWindow: 100000, reasoning: true, thinkingLevelMap: { xhigh: "max" } };
let currentThinkingLevel = "medium";
let currentSession = {
  id: "fake-session",
  name: "Fake session",
  file: createSessionFile("fake-session", "Fake session", "hello from fake session")
};
const models = [
  currentModel,
  { id: "fake/fast", provider: "fake", contextWindow: 32000, reasoning: false },
  { id: "other/model", provider: "other", contextWindow: 64000, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" } }
];

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    writes.push(command);
    handle(command);
  }
});

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(command) {
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: currentModel,
        thinkingLevel: currentThinkingLevel,
        isStreaming: false,
        sessionFile: currentSession.file,
        sessionId: currentSession.id,
        sessionName: currentSession.name,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0
      }
    });
    return;
  }

  if (command.type === "new_session") {
    currentSession = {
      id: `fake-session-${Date.now()}`,
      name: undefined,
      file: createSessionFile(`fake-session-${Date.now()}`, undefined, "")
    };
    send({ id: command.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
    return;
  }

  if (command.type === "switch_session") {
    currentSession = {
      id: "switched-session",
      name: "Switched session",
      file: command.sessionPath
    };
    send({ id: command.id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }

  if (command.type === "get_available_models") {
    send({
      id: command.id,
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models }
    });
    return;
  }

  if (command.type === "set_model") {
    const model = models.find((candidate) => candidate.provider === command.provider && candidate.id === command.modelId);
    if (!model) {
      send({ id: command.id, type: "response", command: "set_model", success: false, error: `Model not found: ${command.provider}/${command.modelId}` });
      return;
    }
    currentModel = model;
    send({ id: command.id, type: "response", command: "set_model", success: true, data: model });
    return;
  }

  if (command.type === "set_thinking_level") {
    currentThinkingLevel = command.level;
    send({ id: command.id, type: "response", command: "set_thinking_level", success: true });
    send({ type: "thinking_level_changed", level: currentThinkingLevel });
    return;
  }

  if (command.type === "get_messages") {
    send({
      id: command.id,
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [{ role: "assistant", content: "ready" }] }
    });
    return;
  }

  if (command.type === "prompt") {
    send({ id: command.id, type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    send({ type: "thinking_level_changed", level: "high" });
    send({ type: "session_info_changed", name: "Fake session" });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 25, errorMessage: "temporary failure" });
    send({ type: "auto_retry_end", success: true, attempt: 1 });
    send({ type: "extension_ui_request", id: "ext-1", method: "notify", message: "Extension notice", notifyType: "info" });
    send({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `echo: ${command.message}` },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }
        ],
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
    });
    send({ type: "turn_end", toolResults: [] });
    send({
      type: "agent_end",
      messages: [
        { role: "user", content: command.message },
        {
          role: "assistant",
          content: `echo: ${command.message}`,
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
      ]
    });
    return;
  }

  if (command.type === "abort") {
    send({ id: command.id, type: "response", command: "abort", success: true, data: { writes } });
    return;
  }

  send({ id: command.id, type: "response", command: command.type, success: false, error: "unknown command" });
}

function createSessionFile(id, name, userMessage) {
  const cwd = process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR;
  const sessionsDir = agentDir
    ? path.join(agentDir, "sessions")
    : path.join(tmpdir(), "pi-web-ui-fake-agent", "sessions");
  const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = path.join(sessionsDir, safePath);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}_${id}.jsonl`);
  const now = new Date().toISOString();
  writeFileSync(file, `${JSON.stringify({ type: "session", id, timestamp: now, cwd })}\n`);
  if (name) {
    appendFileSync(file, `${JSON.stringify({ type: "session_info", id: `${id}-name`, parentId: null, timestamp: now, name })}\n`);
  }
  if (userMessage) {
    appendFileSync(file, `${JSON.stringify({
      type: "message",
      id: `${id}-message`,
      parentId: null,
      timestamp: now,
      message: { role: "user", content: userMessage, timestamp: Date.now() }
    })}\n`);
  }
  return file;
}

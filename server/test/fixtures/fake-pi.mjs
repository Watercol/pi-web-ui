#!/usr/bin/env node
import process from "node:process";

let buffer = "";
const writes = [];

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
        model: { id: "fake/model", provider: "fake" },
        thinkingLevel: "medium",
        isStreaming: false,
        sessionId: "fake-session",
        messageCount: 0,
        pendingMessageCount: 0
      }
    });
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
        ]
      }
    });
    send({ type: "turn_end", toolResults: [] });
    send({
      type: "agent_end",
      messages: [
        { role: "user", content: command.message },
        { role: "assistant", content: `echo: ${command.message}` }
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

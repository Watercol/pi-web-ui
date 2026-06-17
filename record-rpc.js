#!/usr/bin/env node
/**
 * Launches pi in RPC mode and records all stdin/stdout message traffic to a file.
 *
 * Usage: node record-rpc.js [output-file]
 *   Default output: ./rpc-traffic.jsonl
 *
 * The script presents a simple REPL:
 *   - Type a JSON command and press Enter to send it to pi.
 *     Shorthand: just type text to send as a prompt command.
 *   - Type .quit to exit.
 *
 * All events are logged to the output file in JSONL format with direction prefixes.
 */

const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const outputFile = process.argv[2] || path.join(__dirname, "rpc-traffic.jsonl");
const logStream = fs.createWriteStream(outputFile, { flags: "a" });

function log(direction, data) {
  const entry = {
    ts: new Date().toISOString(),
    dir: direction, // "IN" = stdin to pi, "OUT" = stdout from pi
    data: data,
  };
  logStream.write(JSON.stringify(entry) + "\n");
  console.log(`[${direction}] ${JSON.stringify(data)}`);
}

// Spawn pi
const pi = spawn("pi", ["--mode", "rpc", "--no-session"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

pi.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  log("ERR", text.trimEnd());
});

pi.on("close", (code) => {
  console.log(`\npi process exited with code ${code}`);
  logStream.end();
  process.exit(code ?? 1);
});

pi.on("error", (err) => {
  console.error("Failed to start pi:", err.message);
  process.exit(1);
});

// Attach JSONL reader to stdout
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        try {
          onLine(JSON.parse(line));
        } catch {
          onLine({ raw: line });
        }
      }
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      let line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.length > 0) {
        try {
          onLine(JSON.parse(line));
        } catch {
          onLine({ raw: line });
        }
      }
    }
  });
}

attachJsonlReader(pi.stdout, (event) => {
  log("OUT", event);
});

function send(cmd) {
  const line = JSON.stringify(cmd);
  log("IN", cmd);
  pi.stdin.write(line + "\n");
}

// REPL
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "rpc> ",
});

console.log(`Recording RPC traffic to: ${outputFile}`);
console.log('Type JSON commands or plain text (sent as "prompt"). .quit to exit.');
console.log("");

rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();

  if (trimmed === ".quit" || trimmed === ".exit") {
    send({ type: "abort" });
    setTimeout(() => {
      pi.kill();
      rl.close();
    }, 500);
    return;
  }

  if (trimmed === "") {
    rl.prompt();
    return;
  }

  // Try to parse as JSON
  try {
    const cmd = JSON.parse(trimmed);
    send(cmd);
  } catch {
    // Plain text → send as prompt
    send({ type: "prompt", message: trimmed });
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\nDone.");
  process.exit(0);
});

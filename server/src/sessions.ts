import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentMessage, PiSessionInfo } from "../../shared/src/index.js";

type SessionHeader = {
  type: "session";
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
};

type SessionEntry = {
  type?: string;
  timestamp?: string;
  name?: string;
  message?: AgentMessage;
};

const MAX_SESSION_FILES = 1000;

export async function listSessions(cwd: string, scope: "current" | "all" = "current"): Promise<PiSessionInfo[]> {
  const sessionsRoot = getSessionsRoot();
  const files = scope === "current"
    ? await listJsonlFiles(getDefaultSessionDir(cwd))
    : await listAllJsonlFiles(sessionsRoot);

  const infos = await Promise.all(files.slice(0, MAX_SESSION_FILES).map((file) => buildSessionInfo(file)));
  return infos
    .filter((info): info is PiSessionInfo => Boolean(info))
    .filter((info) => scope === "all" || pathsEqual(info.cwd, cwd))
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

async function buildSessionInfo(filePath: string): Promise<PiSessionInfo | undefined> {
  try {
    const stats = await stat(filePath);
    let header: SessionHeader | undefined;
    let name: string | undefined;
    let messageCount = 0;
    let firstMessage = "";
    let lastActivityTime: number | undefined;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const entry = parseJsonLine(line);
      if (!entry) continue;

      if (!header) {
        if (entry.type !== "session") return undefined;
        header = entry as SessionHeader;
        continue;
      }

      if (entry.type === "session_info") {
        name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
        continue;
      }

      if (entry.type !== "message" || !entry.message) continue;
      messageCount++;

      const activityTime = getMessageActivityTime(entry);
      if (typeof activityTime === "number") lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);

      if (!firstMessage && entry.message.role === "user") {
        firstMessage = extractTextContent(entry.message).trim();
      }
    }

    if (!header?.id) return undefined;

    const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    const modified = typeof lastActivityTime === "number" && lastActivityTime > 0
      ? new Date(lastActivityTime)
      : Number.isFinite(headerTime)
        ? new Date(headerTime)
        : stats.mtime;

    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
      created: Number.isFinite(headerTime) ? new Date(headerTime).toISOString() : stats.birthtime.toISOString(),
      modified: modified.toISOString(),
      messageCount,
      firstMessage: firstMessage || "(no messages)"
    };
  } catch {
    return undefined;
  }
}

function parseJsonLine(line: string): SessionEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as SessionEntry : undefined;
  } catch {
    return undefined;
  }
}

function getMessageActivityTime(entry: SessionEntry): number | undefined {
  const role = entry.message?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const timestamp = entry.message?.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  if (typeof entry.timestamp !== "string") return undefined;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractTextContent(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return typeof message.text === "string" ? message.text : "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join(" ");
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function listAllJsonlFiles(root: string): Promise<string[]> {
  try {
    const dirs = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      dirs.filter((entry) => entry.isDirectory()).map((entry) => listJsonlFiles(path.join(root, entry.name)))
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function getSessionsRoot(): string {
  return path.join(getAgentDir(), "sessions");
}

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR;
  if (envDir) return expandTildePath(envDir);
  return path.join(homedir(), ".pi", "agent");
}

function getDefaultSessionDir(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(getSessionsRoot(), safePath);
}

function expandTildePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homedir(), input.slice(2));
  return input;
}

function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

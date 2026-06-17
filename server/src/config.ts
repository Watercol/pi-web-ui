import { spawnSync } from "node:child_process";
import path from "node:path";

export type ServerConfig = {
  host: string;
  port: number;
  cwd: string;
  piBin: string;
  provider?: string;
  model?: string;
  devAssets: boolean;
};

export function parseArgs(argv: string[], env = process.env): ServerConfig {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3210,
    cwd: process.cwd(),
    piBin: env.PI_WEB_UI_PI_BIN || "pi",
    devAssets: env.NODE_ENV === "development"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    if (arg === "--host") config.host = next();
    else if (arg === "--port") config.port = Number.parseInt(next(), 10);
    else if (arg === "--cwd") config.cwd = path.resolve(next());
    else if (arg === "--pi-bin") config.piBin = next();
    else if (arg === "--provider") config.provider = next();
    else if (arg === "--model") config.model = next();
    else if (arg === "--prod-assets") config.devAssets = false;
    else if (arg === "--help" || arg === "-h") {
      throw new Error(helpText());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`Invalid --port value: ${String(config.port)}`);
  }

  return config;
}

export function checkPiBinary(piBin: string): void {
  const result = spawnSync(piBin, ["--help"], {
    timeout: 10_000,
    stdio: "pipe",
    windowsHide: true
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      const hint = piBin === "pi"
        ? "pi is not installed or not in your PATH."
        : `pi not found at: ${piBin}`;
      const message = [
        `\n  ${hint}`,
        "",
        "  Install pi first, then run pi-web-ui again:",
        "    npm install -g @earendil-works/pi-coding-agent",
        "",
        "  Or point to an existing pi binary:",
        `    pi-web-ui --pi-bin /path/to/pi`,
        ""
      ].join("\n");
      throw new Error(message);
    }
    throw new Error(`Failed to run pi: ${err.message}`);
  }
}

export function buildPiArgs(config: Pick<ServerConfig, "provider" | "model">): string[] {
  const args = ["--mode", "rpc"];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  return args;
}

export function helpText(): string {
  return [
    "Usage: pi-web-ui [options]",
    "",
    "Options:",
    "  --host <host>       Host to bind, default 127.0.0.1",
    "  --port <port>       Port to bind, default 3210",
    "  --cwd <dir>         Working directory for pi --mode rpc, default current directory",
    "  --pi-bin <path>     Pi executable, default PATH lookup for pi",
    "  --provider <name>   Provider passed to pi",
    "  --model <id>        Model passed to pi"
  ].join("\n");
}

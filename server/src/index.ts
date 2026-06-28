import { createApp } from "./http.js";
import { checkPiBinary, parseArgs } from "./config.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

function startViteWatch(rootDir: string): ChildProcess | null {
  if (!process.argv.includes("--dev-watch")) return null;

  console.log("[dev] Starting vite build --watch...");
  const child = spawn("npx", ["vite", "build", "web", "--outDir", "../dist/web", "--emptyOutDir", "--watch"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env, FORCE_COLOR: "1" }
  });

  let initialBuildDone = false;

  child.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString();
    process.stdout.write(`[vite] ${msg}`);
    if (!initialBuildDone && /built in/i.test(msg)) {
      initialBuildDone = true;
      console.log("[dev] Initial vite build complete. Watching for changes...");
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[vite] ${data.toString()}`);
  });

  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`[dev] vite watch exited with code ${code}`);
    }
  });

  return child;
}

try {
  const config = parseArgs(process.argv.slice(2));
  checkPiBinary(config.piBin);

  const rootDir = process.cwd();
  const viteWatch = startViteWatch(rootDir);

  const app: Server = createApp(config);

  app.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      const address = "address" in error && typeof error.address === "string" ? error.address : config.host;
      const port = "port" in error && typeof error.port === "number" ? error.port : config.port;
      console.error(`Port already in use: ${address}:${port}`);
      console.error(`Stop the existing pi-web-ui process, or run on another port: npm run dev -- --port ${port + 1}`);
    } else {
      console.error(error.message);
    }
    app.close(() => process.exit(1));
  });

  app.listen(config.port, config.host, () => {
    const serverAddress = app.address() as AddressInfo | null;
    const port = serverAddress?.port ?? config.port;
    const address = `http://${config.host}:${port}`;
    console.log(`Pi Web UI listening on ${address}`);
    console.log(`Pi RPC cwd: ${config.cwd}`);
    console.log(`Pi binary: ${config.piBin}`);
  });

  function shutdown(signal: string): void {
    console.log(`\nReceived ${signal}, shutting down...`);
    if (viteWatch) {
      viteWatch.kill();
    }
    app.close(() => {
      console.log("Pi Web UI stopped.");
      process.exit(0);
    });
    // Force exit after 5s if graceful shutdown hangs
    setTimeout(() => {
      console.error("Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 5_000);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

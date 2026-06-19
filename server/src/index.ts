import { createApp } from "./http.js";
import { checkPiBinary, parseArgs } from "./config.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

try {
  const config = parseArgs(process.argv.slice(2));
  checkPiBinary(config.piBin);
  const app: Server = createApp(config);

  app.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      const address = typeof error.address === "string" ? error.address : config.host;
      const port = typeof error.port === "number" ? error.port : config.port;
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

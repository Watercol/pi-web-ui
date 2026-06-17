import { createApp } from "./http.js";
import { checkPiBinary, parseArgs } from "./config.js";
import type { Server } from "node:http";

try {
  const config = parseArgs(process.argv.slice(2));
  checkPiBinary(config.piBin);
  const app: Server = createApp(config);

  app.listen(config.port, config.host, () => {
    const address = `http://${config.host}:${config.port}`;
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

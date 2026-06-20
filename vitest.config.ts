import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "web/test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    environment: "node",
    environmentMatchGlobs: [
      ["web/test/**", "jsdom"]
    ],
    setupFiles: ["web/test/setup.ts"]
  }
});

#!/usr/bin/env node
process.stdin.once("data", () => {
  setTimeout(() => process.exit(7), 10);
});

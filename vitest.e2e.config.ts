import { defineConfig } from "vitest/config";

// The end-to-end project: spawns dist/cli.js per scenario against a scripted
// model stub. Separate from vitest.config.ts so `npm test` stays the fast unit
// loop. Serial on purpose — every scenario spawns a process and binds a port.
// No retries: an e2e flake is a real bug, not a number to retry into green.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    globalSetup: ["tests/e2e/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    retry: 0,
  },
});

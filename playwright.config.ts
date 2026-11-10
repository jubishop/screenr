import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { browserConfig } from "./scripts/browser-config";

export default defineConfig({
  testDir: "tests/browser",
  // A focused test would let the full gate pass after running only that test.
  forbidOnly: true,
  fullyParallel: true,
  workers: 2,
  timeout: 90_000,
  // An expect waits for what a page shows, which load from parallel checks
  // can delay well past an idle machine's few seconds. Another member's
  // change reaches an open page only through its 3-second poll, which skips
  // while a read is pending, and once came after a 10-second bound (#626).
  // This bound only ends a hang; see memory/process-test-waits.md.
  expect: { timeout: 60_000 },
  reporter: [
    [process.env.CI ? "dot" : "line"],
    // An absolute path still loads from configurations that extend this one.
    [
      join(import.meta.dirname, "tests/browser/failure-line-reporter.ts"),
      { file: browserConfig.failureLines },
    ],
  ],
  use: { baseURL: browserConfig.baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx scripts/browser-server.ts",
    url: `${browserConfig.baseURL}/login`,
    cwd: browserConfig.root,
    reuseExistingServer: false,
    stdout: browserConfig.mode === "production" ? "pipe" : "ignore",
    timeout: 90_000,
  },
});

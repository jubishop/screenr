import { defineConfig } from "@playwright/test";
import { browserConfig } from "./scripts/browser-config";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: { baseURL: browserConfig.baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx scripts/browser-server.ts",
    url: `${browserConfig.baseURL}/login`,
    cwd: browserConfig.root,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});

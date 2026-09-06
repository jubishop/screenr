import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: "http://localhost:3055", trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx scripts/browser-server.ts",
    url: "http://localhost:3055/login",
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});

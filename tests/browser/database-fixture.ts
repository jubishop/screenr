import { test as base } from "../../scripts/browser-test";
import { browserConfig } from "../../scripts/browser-config";

process.env.DATABASE_URL = browserConfig.databaseURL;
process.env.BETTER_AUTH_URL = browserConfig.baseURL;
process.env.BETTER_AUTH_SECRET =
  "screenr-browser-test-only-secret-at-least-32-characters";
export const { db } = await import("../../src/server/db");

// Server modules share one pool in a worker. Keep it alive between spec files
// and close it only when every test using that worker has finished.
export const test = base.extend<{}, { database: typeof db }>({
  database: [
    async ({}, use) => {
      await use(db);
      await db.end();
    },
    { scope: "worker", auto: true },
  ],
});

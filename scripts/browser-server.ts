import { Pool } from "pg";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const base = new URL(
  process.env.TEST_DATABASE_URL ??
    "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test",
);
if (!base.pathname.endsWith("_test"))
  throw new Error("Browser tests require a dedicated test database.");
const adminURL = new URL(base);
adminURL.pathname = "/postgres";
const admin = new Pool({ connectionString: adminURL.href });
try {
  await admin.query("CREATE DATABASE screenr_browser_test");
} catch (error) {
  if ((error as { code: string }).code !== "42P04") throw error;
} finally {
  await admin.end();
}
base.pathname = "/screenr_browser_test";
process.env.DATABASE_URL = base.href;
process.env.TZ = "UTC";
process.env.BETTER_AUTH_URL = "http://localhost:3055";
process.env.BETTER_AUTH_SECRET =
  "screenr-browser-test-only-secret-at-least-32-characters";
process.env.EMAIL_TRANSPORT = "file";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";
process.env.SCREENR_TEST_TMDB_URL = "http://127.0.0.1:3056";
const { migrate } = await import("./migrate");
const { db } = await import("../src/server/db");
await migrate();
await db.query(
  'TRUNCATE "user", verification, "rateLimit", title, email_job RESTART IDENTITY CASCADE',
);
const { createInvitation } = await import("../src/server/invitations");
const { token } = await createInvitation(null, 12);
await mkdir(".cache", { recursive: true });
await writeFile(".cache/browser-invite.txt", token, { mode: 0o600 });
await db.end();
const fixture = {
  id: 987654,
  title: "The Lantern Room",
  name: "The Lantern Room",
  media_type: "movie",
  overview:
    "A quiet coastal town, an unexpected visitor, and one last summer to remember. A fictional title used only in automated browser tests.",
  release_date: "2026-06-12",
  poster_path: null,
};
const catalog = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify(
      request.url?.startsWith("/search/") ? { results: [fixture] } : fixture,
    ),
  );
}).listen(3056, "127.0.0.1");
const app = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3055",
  ],
  { stdio: "inherit", env: process.env },
);
function stop() {
  app.kill("SIGTERM");
  catalog.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => {
  catalog.close();
  process.exit(code ?? 0);
});

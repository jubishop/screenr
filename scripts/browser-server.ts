import { Pool } from "pg";
import { createServer, request as proxyRequest } from "node:http";
import { connect } from "node:net";
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
process.env.GOOGLE_CLIENT_ID = "screenr-browser-test";
process.env.GOOGLE_CLIENT_SECRET = "screenr-browser-test";
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
const trailerInvitation = await createInvitation(null, 1);
await writeFile(".cache/browser-trailer-invite.txt", trailerInvitation.token, {
  mode: 0o600,
});
const { startGoogleProvider } =
  await import("../tests/browser/google-provider");
const google = await startGoogleProvider();
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
  if (request.url?.endsWith("/videos")) {
    if (request.url === "/movie/987655/videos") {
      response.writeHead(503).end();
      return;
    }
    response.end(
      JSON.stringify({
        results:
          request.url === "/movie/987654/videos"
            ? [
                {
                  site: "YouTube",
                  type: "Trailer",
                  key: "Abcdef_1234",
                  name: "Official trailer",
                  official: true,
                },
              ]
            : request.url === "/movie/987656/videos"
              ? [
                  {
                    site: "YouTube",
                    type: "Trailer",
                    key: "invalid?autoplay=1",
                    name: "Invalid trailer",
                    official: true,
                  },
                ]
              : [],
      }),
    );
    return;
  }
  response.end(
    JSON.stringify(
      request.url?.startsWith("/search/")
        ? { results: [fixture] }
        : {
            ...fixture,
            id: Number(request.url?.split("/")[2]) || fixture.id,
          },
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
    "3059",
  ],
  { stdio: "inherit", env: process.env },
);
// Route OAuth at the HTTP server, including redirects back from the provider.
// Browser request interception does not reliably cover redirected requests.
const proxy = createServer((request, response) => {
  const upstream = proxyRequest(
    {
      hostname: "127.0.0.1",
      port: request.url?.startsWith("/api/auth/") ? 3058 : 3059,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (result) => {
      response.writeHead(result.statusCode!, result.headers);
      result.pipe(response);
    },
  );
  upstream.on("error", () =>
    response.writeHead(503).end("Test server starting"),
  );
  request.pipe(upstream);
});
proxy.on("upgrade", (request, socket, head) => {
  const upstream = connect(3059, "127.0.0.1", () => {
    upstream.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` +
        request.rawHeaders.reduce(
          (lines, value, index, all) =>
            index % 2 ? lines : lines + `${value}: ${all[index + 1]}\r\n`,
          "",
        ) +
        "\r\n",
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
proxy.listen(3055, "127.0.0.1");
function stop() {
  app.kill("SIGTERM");
  catalog.close();
  google.close();
  proxy.close();
  void db.end();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => {
  catalog.close();
  google.close();
  proxy.close();
  process.exit(code ?? 0);
});

import { Client, type Pool } from "pg";
import { browserConfig } from "./browser-config";
import { once } from "node:events";
import { createServer, type Server as HTTPServer } from "node:http";
import { createBrowserProxy } from "./browser-proxy";
import { createServer as reservePort, type Server } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const reservations = new Map<number, Server>();
const adminURL = new URL(browserConfig.databaseURL);
adminURL.pathname = "/postgres";
const admin = new Client({ connectionString: adminURL.href });
let app: ChildProcess | undefined;
let db: Pool | undefined;
let catalog: HTTPServer | undefined;
let google: HTTPServer | undefined;
let proxy: HTTPServer | undefined;
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  // Keep database locks until the app has stopped using its fixtures.
  if (app?.pid && app.exitCode === null && app.signalCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    const timer = setTimeout(() => app?.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  for (const server of [catalog, google, proxy]) {
    server?.closeAllConnections();
    server?.close();
  }
  for (const server of reservations.values()) server.close();
  await db?.end();
  await admin.end();
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
admin.on("error", (error) => {
  console.error("Browser database lock connection failed:", error.message);
  void stop(1);
});
async function releasePort(port: number) {
  await new Promise<void>((resolve, reject) =>
    reservations
      .get(port)!
      .close((error) => (error ? reject(error) : resolve())),
  );
  reservations.delete(port);
}
try {
  // Reserve all four ports before any migration, reset, or capture-file write.
  // Hold each reservation until its owning server is ready to listen.
  for (const port of [
    browserConfig.port,
    browserConfig.catalogPort,
    browserConfig.googlePort,
    browserConfig.appPort,
  ]) {
    // Readiness probes may reach a reservation before the real server.
    // Close them immediately so they cannot delay release of the port.
    const server = reservePort((socket) => socket.destroy());
    reservations.set(port, server);
    server.listen(port, "127.0.0.1");
    try {
      await once(server, "listening");
    } catch {
      throw new Error(
        `Browser fixture port ${port} is in use. Stop its owner or set SCREENR_BROWSER_PORT to a free four-port range.`,
      );
    }
  }
  await admin.connect();
  // Session locks on the common admin database also protect explicit database
  // overrides and prevent two runs in one checkout from sharing capture files.
  for (const resource of [
    `checkout:${browserConfig.root}`,
    `database:${browserConfig.databaseName}`,
  ]) {
    const { rows } = await admin.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [`screenr-browser:${resource}`],
    );
    if (!rows[0].acquired)
      throw new Error(
        `Browser fixture ${resource} is already in use by another run.`,
      );
  }
  try {
    await admin.query(`CREATE DATABASE "${browserConfig.databaseName}"`);
  } catch (error) {
    if ((error as { code: string }).code !== "42P04") throw error;
  }
  process.env.DATABASE_URL = browserConfig.databaseURL;
  process.env.TZ = "UTC";
  process.env.BETTER_AUTH_URL = browserConfig.baseURL;
  process.env.BETTER_AUTH_SECRET =
    "screenr-browser-test-only-secret-at-least-32-characters";
  process.env.EMAIL_TRANSPORT = "file";
  process.env.GOOGLE_CLIENT_ID = "screenr-browser-test";
  process.env.GOOGLE_CLIENT_SECRET = "screenr-browser-test";
  process.env.SCREENR_TEST_TMDB_URL = browserConfig.catalogURL;
  const { migrate } = await import("./migrate");
  db = (await import("../src/server/db")).db;
  await migrate();
  await db.query(
    'TRUNCATE "user", verification, "rateLimit", title, email_job RESTART IDENTITY CASCADE',
  );
  const { createInvitation } = await import("../src/server/invitations");
  const { token } = await createInvitation(null, 12);
  await mkdir(".cache", { recursive: true });
  await writeFile(".cache/browser-invite.txt", token, { mode: 0o600 });
  const availabilityInvitation = await createInvitation(null, 1);
  await writeFile(
    ".cache/browser-availability-invite.txt",
    availabilityInvitation.token,
    { mode: 0o600 },
  );
  const trailerInvitation = await createInvitation(null, 1);
  await writeFile(
    ".cache/browser-trailer-invite.txt",
    trailerInvitation.token,
    {
      mode: 0o600,
    },
  );
  const feedInvitation = await createInvitation(null, 12);
  await writeFile(".cache/browser-feed-invite.txt", feedInvitation.token, {
    mode: 0o600,
  });
  const commentInvitation = await createInvitation(null, 7);
  await writeFile(
    ".cache/browser-comment-invite.txt",
    commentInvitation.token,
    {
      mode: 0o600,
    },
  );
  const sharingInvitation = await createInvitation(null, 3);
  await writeFile(
    ".cache/browser-sharing-invite.txt",
    sharingInvitation.token,
    {
      mode: 0o600,
    },
  );
  const listInvitation = await createInvitation(null, 1);
  await writeFile(".cache/browser-invite-list.txt", listInvitation.token, {
    mode: 0o600,
  });
  const watchInvitation = await createInvitation(null, 2);
  await writeFile(".cache/browser-watch-invite.txt", watchInvitation.token, {
    mode: 0o600,
  });
  const nestedInvitation = await createInvitation(null, 8);
  await writeFile(".cache/browser-nested-invite.txt", nestedInvitation.token, {
    mode: 0o600,
  });
  const friendsInvitation = await createInvitation(null, 3);
  await writeFile(
    ".cache/browser-friends-invite.txt",
    friendsInvitation.token,
    {
      mode: 0o600,
    },
  );
  const { startGoogleProvider } =
    await import("../tests/browser/google-provider");
  const reactionInvitation = await createInvitation(null, 2);
  await writeFile(
    ".cache/browser-reaction-invite.txt",
    reactionInvitation.token,
    { mode: 0o600 },
  );
  await releasePort(browserConfig.googlePort);
  google = await startGoogleProvider();
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
  let availabilityFailure = false;
  catalog = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/availability-failure") {
      availabilityFailure = request.method === "POST";
      response.end("{}");
      return;
    }
    if (request.url?.endsWith("/watch/providers")) {
      const [, kind, id] = request.url.split("/");
      if (id === "987662" || (id === "987660" && availabilityFailure)) {
        response.writeHead(503).end();
        return;
      }
      const provider = (provider_id: number, provider_name: string) => ({
        provider_id,
        provider_name,
        logo_path: "/test-provider.png",
      });
      response.end(
        JSON.stringify({
          id: Number(id),
          results: {
            CA: { flatrate: [provider(600, "Canada only")] },
            ...(id === "987660"
              ? {
                  US: {
                    link: `https://www.themoviedb.org/${kind}/${id}/watch?locale=US`,
                    flatrate: [provider(101, "Harbor Stream")],
                    free: [provider(102, "Lantern Free")],
                    ads: [provider(103, "Coast TV")],
                    rent: [provider(104, "Harbor Store")],
                    buy: [provider(104, "Harbor Store")],
                  },
                }
              : {}),
          },
        }),
      );
      return;
    }
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
    const searchQuery = new URL(
      request.url ?? "/",
      browserConfig.catalogURL,
    ).searchParams.get("query");
    const searchResults =
      searchQuery === "no matching suggestions"
        ? []
        : [
            {
              ...fixture,
              ...(searchQuery === "first suggestion fixture"
                ? { id: 998011, title: "The First Signal" }
                : {}),
              ...(searchQuery === "second suggestion fixture"
                ? { id: 998012, title: "The Second Signal" }
                : {}),
            },
          ];
    response.end(
      JSON.stringify(
        request.url?.startsWith("/search/")
          ? { results: searchResults }
          : {
              ...fixture,
              id: Number(request.url?.split("/")[2]) || fixture.id,
              ...(request.url === "/tv/998001"
                ? { name: "The Harbor Signal", first_air_date: "2025-09-01" }
                : {}),
              ...(request.url === "/movie/987658"
                ? {
                    title: "The Painted Sky",
                    name: "The Painted Sky",
                    poster_path: "/test-poster.png",
                  }
                : {}),
            },
      ),
    );
  });
  await releasePort(browserConfig.catalogPort);
  catalog.listen(browserConfig.catalogPort, "127.0.0.1");
  await once(catalog, "listening");
  await releasePort(browserConfig.appPort);
  app = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(browserConfig.appPort),
    ],
    { stdio: "inherit", env: process.env },
  );
  app.on("error", (error) => {
    console.error(error);
    void stop(1);
  });
  app.on("exit", (code) => void stop(code ?? 1));
  // Route OAuth at the HTTP server, including redirects back from the provider.
  // Browser request interception does not reliably cover redirected requests.
  proxy = createBrowserProxy(browserConfig);
  await releasePort(browserConfig.port);
  proxy.listen(browserConfig.port, "127.0.0.1");
  await once(proxy, "listening");
  console.log(
    `Browser fixture: ${browserConfig.baseURL} (${browserConfig.databaseName})`,
  );
} catch (error) {
  console.error(error);
  await stop(1);
}

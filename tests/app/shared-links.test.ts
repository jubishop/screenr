import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  db,
  bearerFor,
  captureFailures,
  failureEvents,
  assertNotLogged,
} from "./social-fixture";

// The share extension's `resolve-title` action (docs/title-catalog.md#shared-links):
// TMDB, IMDb, and JustWatch links name one title, and Netflix and other links
// leave a search for the member to start from.

const { migrate } = await import("../../scripts/migrate");
const { GET } = await import("../../src/app/api/screenr/[action]/route");
const { resolveSharedTitle, sharedSearchText } =
  await import("../../src/server/shared-links");

// `drop` ends the connection without an answer, as a network failure does.
type Reply = { status: number; body: string; location?: string; drop?: true };
let catalogRequests: string[] = [];
let pageRequests: string[] = [];
let detailsStatus = 200;
let findResults: Record<string, unknown> = {};
let pages: Record<string, Reply> = {};

const catalog = createServer((request, response) => {
  const url = new URL(request.url!, "http://catalog");
  catalogRequests.push(url.pathname + url.search);
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const find = /^\/find\/(tt\d+)$/.exec(url.pathname);
  // A list stands in for an answer that is not an object.
  if (find && Array.isArray(findResults[find[1]]))
    return send(200, findResults[find[1]]);
  if (find && url.searchParams.get("external_source") === "imdb_id")
    return send(200, {
      movie_results: [],
      tv_results: [],
      tv_episode_results: [],
      tv_season_results: [],
      person_results: [],
      ...(findResults[find[1]] as object),
    });
  const details = /^\/(movie|tv)\/(\d+)$/.exec(url.pathname);
  // A movie's details carry its release dates, which TMDB sends as an empty
  // list when the movie has none.
  if (details && detailsStatus === 200)
    return send(
      200,
      details[1] === "movie"
        ? {
            id: Number(details[2]),
            title: "Shared Movie",
            release_dates: { results: [] },
          }
        : { id: Number(details[2]), name: "Shared Show" },
    );
  send(details ? detailsStatus : 404, {});
});

// JustWatch's and Netflix's pages.
const sitePages = createServer((request, response) => {
  pageRequests.push(request.url!);
  const page = pages[request.url!] ?? { status: 404, body: "" };
  if (page.drop) return request.socket.destroy();
  response.writeHead(page.status, {
    "Content-Type": "text/html",
    ...(page.location && { Location: page.location }),
  });
  response.end(page.body);
});

// A JustWatch title page carries its IMDb ID in the page's embedded state.
const justWatchPage = (...imdbIds: string[]) => ({
  status: 200,
  body: `<html><head><title>Shared Movie streaming</title></head><body><script>window.__DATA__=[${imdbIds
    .map((id) => `"ExternalIds","${id}","Q1"`)
    .join(",")}]</script></body></html>`,
});

const listen = async (server: typeof catalog) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

before(async () => {
  await migrate();
  process.env.SCREENR_TEST_TMDB_URL = await listen(catalog);
  process.env.SCREENR_TEST_PAGES_URL = await listen(sitePages);
  process.env.TMDB_READ_TOKEN = "shared-links-test-token";
});
beforeEach(async () => {
  catalogRequests = [];
  pageRequests = [];
  detailsStatus = 200;
  findResults = {
    tt0000042: { movie_results: [{ id: 42, title: "Shared Movie" }] },
    tt0000043: { tv_results: [{ id: 43, name: "Shared Show" }] },
    tt0000044: {
      tv_episode_results: [{ id: 9001, show_id: 43, name: "Pilot" }],
    },
  };
  pages = {};
  await db.query(
    'TRUNCATE "user", verification, title RESTART IDENTITY CASCADE',
  );
});
after(async () => {
  for (const server of [catalog, sitePages]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.end();
});

const resolved = async (url: string, text = "") =>
  (await resolveSharedTitle(url, text)).title?.id ?? null;

test("TMDB links name their movie or show, in any of TMDB's page paths", async () => {
  for (const [url, id] of [
    ["https://www.themoviedb.org/movie/42-shared-movie", "movie:42"],
    ["https://themoviedb.org/movie/42?language=en-US", "movie:42"],
    ["http://www.themoviedb.org/tv/43-shared-show/watch", "tv:43"],
    ["https://www.themoviedb.org/tv/43/season/1/episode/2", "tv:43"],
    ["https://WWW.THEMOVIEDB.ORG/tv/43#overview", "tv:43"],
  ])
    assert.equal(await resolved(url), id, url);
  const result = await resolveSharedTitle(
    "https://www.themoviedb.org/movie/42",
    "",
  );
  assert.equal(result.title?.name, "Shared Movie");
  assert.equal(
    (await db.query("SELECT name FROM title WHERE id='movie:42'")).rows[0].name,
    "Shared Movie",
  );
});

test("IMDb links resolve through TMDB's find by IMDb ID", async () => {
  for (const [url, id] of [
    ["https://www.imdb.com/title/tt0000042/", "movie:42"],
    ["https://m.imdb.com/title/tt0000042/?ref_=ext_shr_lnk", "movie:42"],
    ["https://imdb.com/title/tt0000043", "tv:43"],
    ["https://www.imdb.com/de/title/tt0000043/episodes/?season=1", "tv:43"],
    // An episode's page opens its show.
    ["https://www.imdb.com/title/tt0000044/", "tv:43"],
  ])
    assert.equal(await resolved(url), id, url);
  assert.ok(
    catalogRequests.includes("/find/tt0000042?external_source=imdb_id"),
  );
});

test("an invalid TMDB find answer fails and logs its lookup", async () => {
  findResults.tt0000045 = [{ id: 45, title: "Private Find Result" }];
  const printed = captureFailures();
  try {
    await assert.rejects(
      resolveSharedTitle("https://www.imdb.com/title/tt0000045/", ""),
      { status: 502, message: "The catalog returned an invalid title." },
    );
  } finally {
    mock.restoreAll();
  }
  assert.equal(printed.length, 1, printed.join("\n"));
  const { stack, ...fields } = JSON.parse(printed[0]);
  assert.deepEqual(fields, {
    event: "catalog response invalid",
    lookup: "find",
    error: "AppError",
  });
  assertNotLogged(printed, ["Private Find Result"]);
});

test("a link TMDB does not know leaves a search of the shared text", async () => {
  detailsStatus = 404;
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.themoviedb.org/movie/99",
      "Lost Film (2001) - The Movie Database (TMDB)",
    ),
    { title: null, query: "Lost Film" },
  );
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.imdb.com/title/tt0000099/",
      "Unknown Show (TV Series 2019–2021) - IMDb",
    ),
    { title: null, query: "Unknown Show" },
  );
});

test("JustWatch links resolve through the IMDb ID on the title's page", async () => {
  pages["/us/movie/shared-movie"] = justWatchPage("tt0000042");
  assert.deepEqual(
    await resolved(
      "https://www.justwatch.com/us/movie/shared-movie?utm_source=share",
    ),
    "movie:42",
  );
  // Only the page's path reaches JustWatch, and its redirects stay there.
  pages["/de/serie/geteilt"] = {
    status: 301,
    body: "",
    location: "/de/Serie/Geteilt",
  };
  pages["/de/Serie/Geteilt"] = justWatchPage("tt0000043", "tt0000043");
  assert.equal(
    await resolved("https://justwatch.com/de/serie/geteilt"),
    "tv:43",
  );
  assert.deepEqual(pageRequests, [
    "/us/movie/shared-movie",
    "/de/serie/geteilt",
    "/de/Serie/Geteilt",
  ]);
});

test("a JustWatch page without one IMDb ID leaves a search of the link's name", async () => {
  pages["/us/movie/dune-2021"] = justWatchPage("tt0000042", "tt0000043");
  pages["/us/tv-show/the-long-winter"] = { status: 503, body: "" };
  pages["/us/movie/elsewhere"] = {
    status: 302,
    body: "",
    location: "http://127.0.0.1:9/us/movie/elsewhere",
  };
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.justwatch.com/us/movie/dune-2021",
      "",
    ),
    { title: null, query: "dune" },
  );
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.justwatch.com/us/tv-show/the-long-winter/season-2",
      "",
    ),
    { title: null, query: "the long winter" },
  );
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.justwatch.com/us/movie/elsewhere",
      "",
    ),
    { title: null, query: "elsewhere" },
  );
  pages["/us/movie/unreachable"] = { status: 200, body: "", drop: true };
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.justwatch.com/us/movie/unreachable",
      "",
    ),
    { title: null, query: "unreachable" },
  );
  assert.equal(catalogRequests.length, 0);
});

test("a JustWatch page follows at most three redirects", async () => {
  // Three redirects within the site reach the title page.
  pages["/us/movie/moved"] = {
    status: 301,
    body: "",
    location: "/us/movie/moved/1",
  };
  pages["/us/movie/moved/1"] = {
    status: 302,
    body: "",
    location: "/us/movie/moved/2",
  };
  pages["/us/movie/moved/2"] = {
    status: 307,
    body: "",
    location: "/us/movie/moved/3",
  };
  pages["/us/movie/moved/3"] = justWatchPage("tt0000042");
  assert.equal(
    await resolved("https://www.justwatch.com/us/movie/moved"),
    "movie:42",
  );
  // A redirect loop stops at the fourth redirect and leaves the search.
  pages["/us/movie/loop"] = {
    status: 301,
    body: "",
    location: "/us/movie/loop",
  };
  pageRequests = [];
  assert.deepEqual(
    await resolveSharedTitle("https://www.justwatch.com/us/movie/loop", ""),
    { title: null, query: "loop" },
  );
  assert.deepEqual(pageRequests, Array(4).fill("/us/movie/loop"));
});

test("a JustWatch page over 5 MB leaves a search of the link's name", async () => {
  // Both pages name an IMDb ID, so only the size limit separates them.
  const page = justWatchPage("tt0000042").body;
  pages["/us/movie/largest"] = { status: 200, body: page.padEnd(5_000_000) };
  pages["/us/movie/too-large"] = { status: 200, body: page.padEnd(5_000_001) };
  assert.equal(
    await resolved("https://www.justwatch.com/us/movie/largest"),
    "movie:42",
  );
  catalogRequests = [];
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.justwatch.com/us/movie/too-large",
      "",
    ),
    { title: null, query: "too large" },
  );
  assert.equal(catalogRequests.length, 0);
});

test("Netflix links search for the name on the title's page", async () => {
  // The page's <title> is only "Netflix"; its heading names the title.
  pages["/title/80057281"] = {
    status: 200,
    body: "<html><head><title>Netflix</title></head><body><h1>Stranger Things</h1><h1>Other</h1></body></html>",
  };
  pages["/title/80100172"] = {
    status: 301,
    body: "",
    location: "/title/80100172/",
  };
  pages["/title/80100172/"] = {
    status: 200,
    body: '<h1 class="title">Tom &amp; Jerry&#39;s &#x201C;Dark&#x201D;</h1>',
  };
  pages["/title/80000001"] = { status: 200, body: "<h1>Netflix</h1>" };
  for (const [url, text, query] of [
    [
      "https://www.netflix.com/title/80057281?s=i&trkid=1",
      "Netflix",
      "Stranger Things",
    ],
    ["https://www.netflix.com/gb/title/80057281", "", "Stranger Things"],
    ["https://netflix.com/title/80100172", "", "Tom & Jerry's “Dark”"],
    // Without a name on the page, the shared text is the search.
    ["https://www.netflix.com/title/80000001", "Watch Dark | Netflix", "Dark"],
    ["https://www.netflix.com/title/80000002", "Dark | Netflix", "Dark"],
    ["https://www.netflix.com/title/80000002", "", ""],
  ])
    assert.deepEqual(
      await resolveSharedTitle(url, text),
      { title: null, query },
      url,
    );
  assert.deepEqual(pageRequests, [
    "/title/80057281",
    "/title/80057281",
    "/title/80100172",
    "/title/80100172/",
    "/title/80000001",
    "/title/80000002",
    "/title/80000002",
  ]);
  assert.equal(catalogRequests.length, 0);
});

test("other links leave a search of the shared text", async () => {
  assert.deepEqual(
    await resolveSharedTitle(
      "https://www.netflix.com/browse",
      "Stranger Things | Netflix Official Site",
    ),
    { title: null, query: "Stranger Things" },
  );
  assert.deepEqual(
    await resolveSharedTitle(
      "",
      "Check out “Night Crossing” on Screenr https://example.com/night",
    ),
    { title: null, query: "Night Crossing" },
  );
  assert.deepEqual(
    await resolveSharedTitle("https://tv.apple.com/us/movie/dune", ""),
    { title: null, query: "" },
  );
  // Only TMDB, JustWatch, and Netflix title pages are ever fetched.
  assert.equal(catalogRequests.length, 0);
  assert.equal(pageRequests.length, 0);
});

test("a link inside the shared text counts when the share has no link", async () => {
  assert.equal(
    await resolved(
      "",
      "Watch this! https://www.imdb.com/title/tt0000042/?ref_=ext_shr_lnk",
    ),
    "movie:42",
  );
  assert.equal(await resolved("not a link", "javascript:alert(1)"), null);
});

test("the search text drops site names, years, and links from page titles", () => {
  for (const [text, query] of [
    ["Stranger Things | Netflix Official Site", "Stranger Things"],
    ["Watch Stranger Things | Netflix", "Stranger Things"],
    ["Netflix", ""],
    ["The Shawshank Redemption (1994) - IMDb", "The Shawshank Redemption"],
    ["Fight Club (1999) — The Movie Database (TMDB)", "Fight Club"],
    ["Balitanghali (TV Series) — The Movie Database (TMDB)", "Balitanghali"],
    ["Breaking Bad (TV Series 2008–2013) - IMDb", "Breaking Bad"],
    [
      "Mission: Impossible - Dead Reckoning",
      "Mission: Impossible - Dead Reckoning",
    ],
    ['I love "Paper Lanterns"! https://example.com', "Paper Lanterns"],
    ["Check out Harbor Lights on Netflix", "Harbor Lights"],
    [
      "  Spider-Man:   Across the Spider-Verse  ",
      "Spider-Man: Across the Spider-Verse",
    ],
    ["https://example.com/only-a-link", ""],
  ])
    assert.equal(sharedSearchText(text), query, text);
  assert.equal(sharedSearchText("x".repeat(400)).length, 120);
});

test("resolve-title answers the share extension with a title or a search", async (t) => {
  // The unavailable catalog logs a failure line, which this test reads.
  const printed = captureFailures(t);
  await db.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES('viewer','Viewer','viewer@example.test',true,now(),now())`);
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES('viewer','viewer','Viewer')",
  );
  const token = await bearerFor("viewer");
  const resolve = async (query: Record<string, string>) => {
    const response = await GET(
      new Request(
        `http://localhost:3000/api/screenr/resolve-title?${new URLSearchParams(query)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      { params: Promise.resolve({ action: "resolve-title" }) },
    );
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(
    await resolve({ url: "https://www.imdb.com/title/tt0000043/" }),
    {
      status: 200,
      body: {
        title: {
          id: "tv:43",
          kind: "tv",
          tmdb_id: 43,
          name: "Shared Show",
          overview: "",
          poster_path: null,
          release_date: "",
        },
        query: "",
      },
    },
  );
  assert.deepEqual(
    await resolve({
      url: "https://www.netflix.com/title/1",
      text: "Harbor Lights | Netflix",
    }),
    { status: 200, body: { title: null, query: "Harbor Lights" } },
  );
  assert.deepEqual(await resolve({ url: "x".repeat(2049) }), {
    status: 400,
    body: { error: "Share a shorter link." },
  });
  detailsStatus = 503;
  assert.deepEqual(
    await resolve({ url: "https://www.themoviedb.org/movie/42" }),
    {
      status: 502,
      body: {
        error:
          "The movie catalog is temporarily unavailable. Please try again.",
      },
    },
  );
  assert.deepEqual(failureEvents(printed), ["catalog request failed"]);
});

import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  useDatabase,
  db,
  person,
  friend,
  captureFailures,
  failureEvents,
} from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { findTitles } = await import("../../src/server/title-viewing");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { releaseCalendar } = await import("../../src/server/title-release");
useDatabase();

// TMDB's user score (docs/title-catalog.md#tmdb-user-score-implementation):
// the average rating TMDB members give a title, as a whole percentage, once
// at least 20 members have rated it. The date is fixed so release data, which
// the same details carry, never depends on when the suite runs.
mock.method(releaseCalendar, "today", () => "2026-10-25");

type Votes = { vote_average?: unknown; vote_count?: unknown };
function movie(id: number, votes: Votes, name = `Movie ${id}`) {
  return {
    id,
    title: name,
    overview: "A fictional movie.",
    release_date: "2024-01-01",
    release_dates: {
      results: [
        {
          iso_3166_1: "US",
          release_dates: [{ type: 3, release_date: "2024-01-01T00:00:00Z" }],
        },
      ],
    },
    ...votes,
  };
}
function show(id: number, votes: Votes) {
  return {
    id,
    name: `Show ${id}`,
    overview: "A fictional show.",
    first_air_date: "2023-01-01",
    networks: [],
    seasons: [],
    ...votes,
  };
}
const votes = (average: unknown, count: unknown) => ({
  vote_average: average,
  vote_count: count,
});

// The fake catalog answers details from `catalog`, by path, and search from
// `results`. A missing entry answers 404; `failing` fails every details
// request but not search.
let catalog: Record<string, unknown>;
let results: unknown[];
let failing: boolean;
let detailRequests: string[];
let searchRequests: number;
const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://catalog");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname.startsWith("/search/")) {
    searchRequests++;
    response.end(JSON.stringify({ results }));
    return;
  }
  if (url.pathname.endsWith("/watch/providers")) {
    response.end(
      JSON.stringify({
        id: Number(url.pathname.split("/")[2]),
        results: { US: { free: [] } },
      }),
    );
    return;
  }
  if (url.pathname.endsWith("/videos")) {
    response.end(JSON.stringify({ results: [] }));
    return;
  }
  detailRequests.push(request.url!);
  const body = catalog[url.pathname];
  if (failing || !body) response.writeHead(failing ? 503 : 404).end("{}");
  else response.end(JSON.stringify(body));
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "score-test-token";
});
let viewer: string;
beforeEach(async () => {
  catalog = {};
  results = [];
  failing = false;
  detailRequests = [];
  searchRequests = 0;
  viewer = await person("viewer");
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function titlePage(id: string) {
  const screen = await loadScreen(viewer, `/titles/${id.replace(":", "/")}`);
  if (screen.kind !== "title") throw new Error("Expected a title screen");
  return screen;
}
const score = async (id: string) => (await titlePage(id)).tmdb_score;

test("title pages show TMDB's average times 10, rounded, once 20 members have rated the title", async () => {
  catalog = {
    "/movie/601": movie(601, votes(7.3, 20)),
    "/movie/602": movie(602, votes(7.3, 19)),
    // Halves round up.
    "/movie/603": movie(603, votes(7.25, 4810)),
    "/movie/604": movie(604, votes(7.249, 4810)),
    "/movie/605": movie(605, votes(10, 21)),
    "/movie/606": movie(606, votes(0, 20)),
    // TMDB reports an unreleased title as 0 with no votes.
    "/movie/607": movie(607, votes(0, 0)),
    "/tv/608": show(608, votes(8.436, 12950)),
  };
  assert.equal(await score("movie:601"), 73);
  assert.equal(await score("movie:602"), null);
  assert.equal(await score("movie:603"), 73);
  assert.equal(await score("movie:604"), 72);
  assert.equal(await score("movie:605"), 100);
  assert.equal(await score("movie:606"), 0);
  assert.equal(await score("movie:607"), null);
  assert.equal(await score("tv:608"), 84);
  // The score comes from the details each title page already requests.
  assert.deepEqual(detailRequests, [
    "/movie/601?append_to_response=release_dates",
    "/movie/602?append_to_response=release_dates",
    "/movie/603?append_to_response=release_dates",
    "/movie/604?append_to_response=release_dates",
    "/movie/605?append_to_response=release_dates",
    "/movie/606?append_to_response=release_dates",
    "/movie/607?append_to_response=release_dates",
    "/tv/608",
  ]);
  const page = await titlePage("movie:601");
  assert.equal(detailRequests.length, 8, "stored details are reused");
  assert.equal("vote_average" in page.title, false);
  assert.equal("vote_count" in page.title, false);
});

test("missing, non-numeric, or out-of-range TMDB votes show no score and keep the title", async () => {
  const cases: Votes[] = [
    {},
    votes(null, 300),
    votes("7.3", 300),
    votes(7.3, "300"),
    votes(7.3, null),
    votes(10.01, 300),
    votes(-0.1, 300),
    votes(7.3, -20),
    votes(7.3, 20.5),
    votes(7.3, 2 ** 31),
    votes([7.3], 300),
  ];
  for (const [index, value] of cases.entries()) {
    const id = 611 + index;
    catalog[`/movie/${id}`] = movie(id, value);
    const page = await titlePage(`movie:${id}`);
    assert.equal(page.title.name, `Movie ${id}`, JSON.stringify(value));
    assert.equal(page.tmdb_score, null, JSON.stringify(value));
    assert.equal(page.release.status, "ok", JSON.stringify(value));
  }
  const { rows } = await db.query(
    "SELECT count(*)::int AS stored FROM title WHERE vote_average IS NOT NULL AND vote_count IS NOT NULL",
  );
  assert.equal(rows[0].stored, 0, "invalid votes are stored as unknown");
});

test("the score follows the title cache: reused for a day, then refreshed, and kept through a failed refresh", async (t) => {
  // The failed refresh logs a failure line, which this test reads.
  const printed = captureFailures(t);
  catalog = { "/movie/631": movie(631, votes(7.3, 120)) };
  assert.equal(await score("movie:631"), 73);
  catalog["/movie/631"] = movie(631, votes(8.1, 150));
  assert.equal(await score("movie:631"), 73);
  assert.equal(detailRequests.length, 1);

  await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
  failing = true;
  assert.equal(await score("movie:631"), 73);
  assert.equal(detailRequests.length, 2);

  await db.query("UPDATE title SET retry_after=now()-interval '1 second'");
  failing = false;
  assert.equal(await score("movie:631"), 81);
  assert.equal(detailRequests.length, 3);

  // Details that drop below the vote threshold, or lose their votes, show
  // none.
  await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
  catalog["/movie/631"] = movie(631, {});
  assert.equal(await score("movie:631"), null);
  assert.deepEqual(failureEvents(printed), ["catalog request failed"]);
});

test("title lists and search results carry the stored score, and search summaries store it for new titles", async (t) => {
  // Each failed details request logs a failure line, which this test reads.
  const printed = captureFailures(t);
  const other = await person("other");
  await friend(viewer, other);
  // Stored, current titles: one rated, one with too few votes, one unrated,
  // and one the friend recommends.
  for (const [id, average, count] of [
    ["movie:641", 6.84, 412],
    ["tv:642", 9.1, 12],
    ["movie:643", null, null],
    ["movie:646", 7.77, 64],
  ] as const) {
    const [kind, tmdbId] = id.split(":");
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,release,vote_average,vote_count)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        kind,
        tmdbId,
        `Listed ${tmdbId}`,
        kind === "movie"
          ? { theatrical: ["2026-10-20"], digital: [] }
          : { premiere: "2020-01-01", network: "Netflix", seasons: [] },
        average,
        count,
      ],
    );
    if (id === "movie:646")
      await updateTitleActivity(other, id, "recommended", true);
    else
      for (const user of [viewer, other])
        await updateTitleActivity(user, id, "want_to_watch", true);
  }
  const scores = (titles: { id: string; tmdb_score: number | null }[]) =>
    Object.fromEntries(titles.map((title) => [title.id, title.tmdb_score]));
  const listed = { "movie:641": 68, "tv:642": null, "movie:643": null };

  const together = await loadScreen(viewer, "/watch-together?with=other");
  if (together.kind !== "watch-together" || "mode" in together)
    throw new Error("Expected Watch together");
  assert.deepEqual(scores(together.titles), listed);
  const theaters = await loadScreen(
    viewer,
    "/watch-together?with=other&mode=theaters",
  );
  if (theaters.kind !== "watch-together")
    throw new Error("Expected Watch together");
  assert.deepEqual(scores(theaters.titles), {
    "movie:641": 68,
    "movie:643": null,
  });
  const wanted = await loadScreen(
    viewer,
    "/people/other/want-to-watch?mode=theaters",
  );
  if (wanted.kind !== "want-to-watch")
    throw new Error("Expected Want to watch");
  assert.deepEqual(scores(wanted.titles), {
    "movie:641": 68,
    "movie:643": null,
  });
  const find = await loadScreen(viewer, "/search");
  if (find.kind !== "search") throw new Error("Expected Find a title");
  assert.deepEqual(scores(find.recommendations), { "movie:646": 78 });
  assert.deepEqual(scores(find.suggestions), { "movie:646": 78 });
  assert.equal(detailRequests.length, 0, "current titles need no request");

  // A new search result keeps the search summary's score even when its
  // details cannot load. A stored title keeps its own details' score.
  failing = true;
  results = [
    {
      id: 644,
      media_type: "movie",
      title: "Searched 644",
      ...votes(5.56, 87),
    },
    { id: 645, media_type: "tv", name: "Searched 645", ...votes(6, 19) },
    { id: 641, media_type: "movie", title: "Listed 641", ...votes(9.9, 999) },
  ];
  const found = await findTitles("searched", "viewer");
  assert.deepEqual(scores(found), {
    "movie:644": 56,
    "tv:645": null,
    "movie:641": 68,
  });
  assert.ok(found.every((title) => !("vote_average" in title)));
  assert.equal(searchRequests, 1);
  assert.deepEqual(detailRequests.sort(), [
    "/movie/644?append_to_response=release_dates",
    "/tv/645",
  ]);
  // Once the details load, they replace the summary's score.
  await db.query("UPDATE title SET retry_after=NULL");
  failing = false;
  catalog["/movie/644"] = movie(644, votes(5.84, 90), "Searched 644");
  assert.equal(await score("movie:644"), 58);
  assert.deepEqual(failureEvents(printed), [
    "catalog request failed",
    "catalog request failed",
  ]);
});

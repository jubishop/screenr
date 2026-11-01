import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReleaseTitle } from "../../src/shared";
import { useDatabase, db, denied, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { saveServices } = await import("../../src/server/streaming-services");
const { releaseCalendar } = await import("../../src/server/title-release");
useDatabase();

// In theaters on Want to watch pages and Watch together
// (docs/want-to-watch.md#in-theaters, docs/watch-together.md): movies whose
// release status says In theaters, and movies whose release data cannot be
// loaded. Each test fixes the US date, so the window's edges never depend on
// when the suite runs.
let today: string;
mock.method(releaseCalendar, "today", () => today);

// A TMDB stand-in that answers movie and show details from `details`, by
// path. A missing entry, or any title while `failing`, answers 503, so its
// release data cannot be loaded. Watch provider requests are recorded:
// In theaters reads none.
let details: Record<string, unknown>;
let failing: boolean;
let providerRequests: string[];
const catalog = createServer((request, response) => {
  const url = new URL(request.url!, "http://catalog");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname.endsWith("/watch/providers")) {
    providerRequests.push(url.pathname);
    response.end(JSON.stringify({ id: 0, results: { US: { free: [] } } }));
    return;
  }
  const body = details[url.pathname];
  if (failing || !body) response.writeHead(503).end("{}");
  else response.end(JSON.stringify(body));
});
before(async () => {
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "in-theaters-test-token";
});
beforeEach(async () => {
  await db.query("TRUNCATE title CASCADE");
  today = "2026-10-25";
  details = {};
  failing = false;
  providerRequests = [];
});
after(async () => {
  catalog.closeAllConnections();
  await new Promise<void>((resolve) => catalog.close(() => resolve()));
});

// Stores a title as due for a refresh, so the first list that shows it reads
// its details from the catalog. The details match the stored ones, so only
// the release data changes. TMDB release types: 2 limited theatrical,
// 3 theatrical, 4 digital. Without releases, the catalog fails for it.
async function title(
  id: string,
  name: string,
  releases?: [type: number, date: string][],
) {
  const [kind, tmdbId] = id.split(":");
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name,fetched_at) VALUES($1,$2,$3,$4,'epoch')",
    [id, kind, tmdbId, name],
  );
  if (releases)
    details[`/${kind}/${tmdbId}`] =
      kind === "movie"
        ? {
            id: Number(tmdbId),
            title: name,
            release_date: "",
            release_dates: {
              results: [
                {
                  iso_3166_1: "US",
                  release_dates: releases.map(([type, date]) => ({
                    type,
                    release_date: `${date}T00:00:00.000Z`,
                  })),
                },
              ],
            },
          }
        : {
            id: Number(tmdbId),
            name,
            first_air_date: releases[0]?.[1] ?? "",
            networks: [{ id: 1, name: "Netflix", origin_country: "" }],
          };
  return id;
}

// Saves Want to watch for each title, the first newest, an hour apart
// before `start`.
async function want(owner: string, titles: string[], start = "2026-10-01") {
  for (const id of titles)
    await updateTitleActivity(owner, id, "want_to_watch", true);
  await db.query(
    `UPDATE feed_item f SET activity_at=$3::timestamptz-(o.n||' hours')::interval
    FROM unnest($2::text[]) WITH ORDINALITY o(title_id,n)
    WHERE f.owner_id=$1 AND f.title_id=o.title_id AND f.item_type='want_to_watch'`,
    [owner, titles, start],
  );
}

async function wantToWatch(viewer: string, username: string) {
  const screen = await loadScreen(
    viewer,
    `/people/${username}/want-to-watch?mode=theaters`,
  );
  if (screen.kind !== "want-to-watch" || !("mode" in screen))
    throw new Error("Expected In theaters on a Want to watch page");
  return screen;
}
async function together(viewer: string, username: string) {
  const screen = await loadScreen(
    viewer,
    `/watch-together?with=${username}&mode=theaters`,
  );
  if (screen.kind !== "watch-together" || !("mode" in screen))
    throw new Error("Expected In theaters on Watch together");
  return screen;
}
// Each listed movie, and whether it is in theaters or its release data is
// unavailable.
const listed = (screen: { titles: ReleaseTitle[] }) =>
  screen.titles.map(({ id, release }) => [
    id,
    release.in_theaters ? "in theaters" : release.status,
  ]);

test("In theaters on a Want to watch page lists the owner's Want to watch movies in US theaters, newest first, whatever services the viewer saved", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await saveServices(alice, ["service:netflix"]);
  // The window runs from the latest US theatrical date through the 44 days
  // after it.
  const opening = await title("movie:11", "Opening Today", [[3, today]]);
  const lastDay = await title("movie:12", "Last Day", [[3, "2026-09-11"]]);
  const ended = await title("movie:13", "Ended Yesterday", [[3, "2026-09-10"]]);
  const tomorrow = await title("movie:14", "Opens Tomorrow", [
    [3, "2026-10-26"],
  ]);
  const limited = await title("movie:15", "Limited Run", [
    [2, "2026-10-10"],
    [4, "2026-11-20"],
  ]);
  const digital = await title("movie:16", "Digital Only", [[4, "2026-10-20"]]);
  const unknown = await title("movie:17", "Release Unknown");
  const show = await title("tv:18", "Premiering Show", [[0, "2026-10-20"]]);
  const unknownShow = await title("tv:19", "Unknown Show");
  const alicesOnly = await title("movie:20", "Alice Only", [[3, today]]);
  await want(alice, [alicesOnly]);
  await want(ben, [
    show,
    opening,
    unknownShow,
    ended,
    lastDay,
    tomorrow,
    unknown,
    digital,
    limited,
  ]);

  const screen = await wantToWatch(alice, "ben");
  assert.equal(screen.mode, "theaters");
  assert.equal(screen.owner.username, "ben");
  assert.equal(screen.hasWantToWatch, true);
  assert.deepEqual(listed(screen), [
    [opening, "in theaters"],
    [lastDay, "in theaters"],
    [unknown, "unavailable"],
    [limited, "in theaters"],
  ]);
  // Cards show the release status as #310 derives it, and no viewing options.
  const byId = Object.fromEntries(screen.titles.map((t) => [t.id, t]));
  assert.deepEqual(byId[limited].release, {
    status: "ok",
    in_theaters: true,
    upcoming: [
      { kind: "digital", date: "2026-11-20", label: "Digital Nov 20" },
    ],
  });
  assert.equal(byId[opening].name, "Opening Today");
  assert.equal("viewing" in byId[opening], false);
  assert.equal("viewerHasServices" in screen, false);
  assert.deepEqual(providerRequests, []);

  // The viewer's services never change it, and the owner's own page lists
  // the same movies.
  await saveServices(alice, []);
  await saveServices(ben, ["service:amc-plus"]);
  assert.deepEqual(await wantToWatch(alice, "ben"), screen);
  assert.deepEqual((await wantToWatch(ben, "ben")).titles, screen.titles);

  // At home is unchanged without the mode.
  const home = await loadScreen(alice, "/people/ben/want-to-watch");
  assert.equal(home.kind, "want-to-watch");
  assert.equal("mode" in home, false);
  assert.equal("viewerHasServices" in home, true);
  providerRequests = [];

  // A movie leaves on the next read after its Want to watch is removed, or
  // when its window ends.
  await updateTitleActivity(ben, opening, "want_to_watch", false);
  assert.deepEqual(listed(await wantToWatch(alice, "ben")), [
    [lastDay, "in theaters"],
    [unknown, "unavailable"],
    [limited, "in theaters"],
  ]);
  today = "2026-10-26";
  assert.deepEqual(listed(await wantToWatch(alice, "ben")), [
    [tomorrow, "in theaters"],
    [unknown, "unavailable"],
    [limited, "in theaters"],
  ]);
  assert.deepEqual(providerRequests, []);
});

test("In theaters on Watch together lists only movies in theaters that both people want, newest shared first", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await saveServices(alice, ["service:netflix"]);
  const first = await title("movie:31", "Shared First", [[3, "2026-10-20"]]);
  const second = await title("movie:32", "Shared Second", [[2, "2026-10-01"]]);
  const unknown = await title("movie:33", "Shared Unknown");
  const old = await title("movie:34", "Shared Old", [[3, "2026-01-01"]]);
  const show = await title("tv:35", "Shared Show", [[0, "2026-10-01"]]);
  const alicesOnly = await title("movie:36", "Only Alice", [[3, today]]);
  const bensOnly = await title("movie:37", "Only Ben", [[3, today]]);
  const camsToo = await title("movie:38", "Alice and Cam", [[3, today]]);
  await want(alice, [second, first, unknown, old, show, alicesOnly, camsToo]);
  await want(ben, [first], "2026-10-02");
  await want(ben, [show, old, unknown, second, bensOnly], "2026-09-01");
  await want(cam, [camsToo]);

  // The later of the two additions orders shared movies, so Ben's newer
  // choice puts the first movie ahead of Alice's newer one.
  const screen = await together(alice, "ben");
  assert.equal(screen.mode, "theaters");
  assert.deepEqual(
    screen.participants.map((p) => p.username),
    ["alice", "ben"],
  );
  assert.deepEqual(listed(screen), [
    [first, "in theaters"],
    [second, "in theaters"],
    [unknown, "unavailable"],
  ]);
  assert.equal("viewing" in screen.titles[0], false);
  assert.equal("viewerHasServices" in screen, false);
  assert.deepEqual((await together(ben, "alice")).titles, screen.titles);
  assert.deepEqual(listed(await together(alice, "cam")), [
    [camsToo, "in theaters"],
  ]);
  assert.deepEqual(providerRequests, []);

  // At home is unchanged without the mode, and still lists every shared
  // title.
  const home = await loadScreen(alice, "/watch-together?with=ben");
  if (home.kind !== "watch-together" || "mode" in home)
    throw new Error("Expected At home on Watch together");
  assert.deepEqual(
    home.titles.map((t) => t.id),
    [first, second, unknown, old, show],
  );
  providerRequests = [];

  // Removing either person's Want to watch removes the movie on the next
  // read.
  await updateTitleActivity(ben, first, "want_to_watch", false);
  assert.deepEqual(listed(await together(alice, "ben")), [
    [second, "in theaters"],
    [unknown, "unavailable"],
  ]);
  await updateTitleActivity(alice, second, "want_to_watch", false);
  assert.deepEqual(listed(await together(alice, "ben")), [
    [unknown, "unavailable"],
  ]);
});

test("In theaters keeps empty pages and lists every movie under unknown release data when the catalog fails", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const empty = await wantToWatch(alice, "alice");
  assert.deepEqual(empty.titles, []);
  assert.equal(empty.hasWantToWatch, false);
  assert.deepEqual((await together(alice, "ben")).titles, []);

  // Shows alone leave In theaters empty while the owner still has Want to
  // watch titles.
  const show = await title("tv:41", "Only a Show", [[0, "2026-10-01"]]);
  await want(alice, [show]);
  const showsOnly = await wantToWatch(alice, "alice");
  assert.deepEqual(showsOnly.titles, []);
  assert.equal(showsOnly.hasWantToWatch, true);

  failing = true;
  const movies = [
    await title("movie:42", "Outage One", [[3, today]]),
    await title("movie:43", "Outage Two", [[3, today]]),
  ];
  await want(alice, movies);
  await want(ben, movies);
  for (const screen of [
    await wantToWatch(alice, "alice"),
    await wantToWatch(ben, "alice"),
    await together(alice, "ben"),
  ])
    assert.deepEqual(listed(screen), [
      [movies[0], "unavailable"],
      [movies[1], "unavailable"],
    ]);

  // Once the catalog answers again, the movies return to the list.
  failing = false;
  await db.query("UPDATE title SET retry_after=NULL");
  assert.deepEqual(listed(await together(alice, "ben")), [
    [movies[0], "in theaters"],
    [movies[1], "in theaters"],
  ]);
});

test("In theaters follows the friendship and blocking rules on both pages", async () => {
  const { alice, ben, cam, outsider } = await setup();
  const movie = await title("movie:51", "Now Showing", [[3, today]]);
  await want(ben, [movie]);
  await want(alice, [movie]);
  const page = "/people/ben/want-to-watch?mode=theaters";
  const pair = "/watch-together?with=ben&mode=theaters";
  assert.deepEqual(listed(await wantToWatch(ben, "ben")), [
    [movie, "in theaters"],
  ]);
  await assert.rejects(loadScreen(alice, page), denied.wantToWatch);
  await assert.rejects(loadScreen(alice, pair), denied.watchTogether);
  await changeRelationship(alice, ben, "request");
  await assert.rejects(loadScreen(alice, page), denied.wantToWatch);
  await assert.rejects(loadScreen(alice, pair), denied.watchTogether);
  await changeRelationship(ben, alice, "accept");
  assert.deepEqual(listed(await wantToWatch(alice, "ben")), [
    [movie, "in theaters"],
  ]);
  assert.deepEqual(listed(await together(alice, "ben")), [
    [movie, "in theaters"],
  ]);
  // Friends of friends, outsiders, yourself, and missing members get nothing.
  await friend(ben, cam);
  await assert.rejects(
    loadScreen(cam, "/people/alice/want-to-watch?mode=theaters"),
    denied.wantToWatch,
  );
  await assert.rejects(
    loadScreen(cam, "/watch-together?with=alice&mode=theaters"),
    denied.watchTogether,
  );
  await assert.rejects(loadScreen(outsider, page), denied.wantToWatch);
  await assert.rejects(
    loadScreen(alice, "/watch-together?with=alice&mode=theaters"),
    denied.watchTogether,
  );
  await assert.rejects(loadScreen(alice, "/watch-together?mode=theaters"), {
    status: 400,
    message: "Choose one friend from their profile.",
  });
  await assert.rejects(
    loadScreen(alice, "/people/missing/want-to-watch?mode=theaters"),
    denied.wantToWatch,
  );
  // Unfriending or blocking ends access on the next read.
  await changeRelationship(ben, alice, "remove");
  await assert.rejects(loadScreen(alice, page), denied.wantToWatch);
  await assert.rejects(loadScreen(alice, pair), denied.watchTogether);
  await friend(alice, ben);
  assert.equal((await together(alice, "ben")).titles.length, 1);
  await changeRelationship(ben, alice, "block");
  await assert.rejects(loadScreen(alice, page), denied.wantToWatch);
  await assert.rejects(loadScreen(alice, pair), denied.watchTogether);
  await assert.rejects(
    loadScreen(ben, "/people/alice/want-to-watch?mode=theaters"),
    denied.wantToWatch,
  );
  await assert.rejects(
    loadScreen(ben, "/watch-together?with=alice&mode=theaters"),
    denied.watchTogether,
  );
  // Each member can still open their own page.
  assert.equal((await wantToWatch(alice, "alice")).titles.length, 1);
});

test("In theaters reads release data for the list's movies in one query", async (t) => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const movies: string[] = [];
  for (let n = 100; n < 130; n++)
    movies.push(await title(`movie:${n}`, `Showing ${n}`, [[3, today]]));
  await want(ben, [...movies, await title("tv:130", "Show", [[0, today]])]);
  const query = t.mock.method(db, "query");
  const releaseReads = () =>
    query.mock.calls.filter((call) =>
      /FROM title WHERE id=ANY/.test(String(call.arguments[0])),
    ).length;
  const first = await wantToWatch(alice, "ben");
  // Every movie appears, with no feed-sized cutoff.
  assert.equal(first.titles.length, 30);
  assert.equal(releaseReads(), 1);
  query.mock.resetCalls();
  assert.deepEqual(await wantToWatch(alice, "BEN"), first);
  assert.equal(releaseReads(), 1);
});

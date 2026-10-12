import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { useDatabase, db, person, friend } from "./social-fixture";
import type { TitleViewing } from "../../src/shared";
const { findTitles } = await import("../../src/server/title-viewing");
const { getTitle, getTitleAvailability } =
  await import("../../src/server/catalog");
const { loadScreen } = await import("../../src/server/screens");
const { updateTitleActivity } = await import("../../src/server/title-actions");
useDatabase();

let items: { id: number; title: string; name: string; media_type: string }[];
let failure = false,
  slow = false,
  searchDelay = 0,
  active = 0,
  maximum = 0;
let providers: string[] = [],
  details = 0;
const catalog = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url?.startsWith("/search/")) {
    const body = JSON.stringify({ results: items });
    if (searchDelay) setTimeout(() => response.end(body), searchDelay);
    else response.end(body);
  } else if (request.url?.endsWith("/watch/providers")) {
    providers.push(request.url);
    active++;
    maximum = Math.max(maximum, active);
    response.on("close", () => active--);
    if (slow) return;
    if (failure) {
      response.writeHead(503).end();
      return;
    }
    response.end(
      JSON.stringify({
        id: Number(request.url.split("/")[2]),
        results: {
          US: {
            flatrate: [
              {
                provider_id: 528,
                provider_name: "AMC+ Amazon Channel",
                logo_path: null,
              },
            ],
            free: [
              { provider_id: 73, provider_name: "Tubi TV", logo_path: null },
            ],
          },
        },
      }),
    );
  } else {
    details++;
    response.end(
      JSON.stringify({
        id: Number(request.url?.split("/")[2]),
        title: "Detailed title",
        name: "Detailed title",
        overview: "Full overview",
      }),
    );
  }
});
before(async () => {
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "streaming-test-token";
});
beforeEach(async () => {
  await db.query("TRUNCATE title CASCADE");
  items = [
    {
      id: 93901,
      title: "Search summary",
      name: "Search summary",
      media_type: "movie",
    },
    { id: 93901, title: "TV summary", name: "TV summary", media_type: "tv" },
  ];
  failure = slow = false;
  searchDelay = 0;
  providers = [];
  details = 0;
  active = maximum = 0;
});
after(async () => {
  catalog.closeAllConnections();
  await new Promise<void>((resolve) => catalog.close(() => resolve()));
});

test("search enriches movie and TV summaries and caches availability without replacing full details", async () => {
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name,overview) VALUES('movie:93901','movie',93901,'Full title','Full overview')",
  );
  const result = await findTitles("streaming");
  assert.deepEqual(
    result.map((t) => t.id),
    ["movie:93901", "tv:93901"],
  );
  assert.ok(result.every((t) => t.viewing.status === "ok"));
  assert.equal(result[0].viewing.sections[0].services[0].name, "AMC+");
  assert.equal(result[0].viewing.sections[1].services[0].name, "Tubi TV");
  assert.equal((await getTitle("movie:93901")).name, "Full title");
  assert.equal(details, 0);
  assert.equal((await getTitle("tv:93901")).name, "Detailed title");
  assert.equal(details, 1);
  await findTitles("streaming");
  assert.equal(providers.length, 2);
});

test("failed list refresh retains older options and an initial failure stays unknown with retry backoff", async () => {
  await findTitles("streaming");
  await db.query(
    "UPDATE title_availability SET fetched_at=now()-interval '2 days',refresh_after=now()-interval '1 second'",
  );
  failure = true;
  items.push({
    id: 93902,
    title: "Unknown",
    name: "Unknown",
    media_type: "movie",
  });
  const result = await findTitles("streaming");
  assert.deepEqual(
    result.map((t) => t.viewing.status),
    ["stale", "stale", "unavailable"],
  );
  assert.equal(result[0].viewing.sections[0].services[0].name, "AMC+");
  const requests = providers.length;
  await findTitles("streaming");
  assert.equal(providers.length, requests);
});

test("a cold list bounds concurrent provider requests and returns every title during a slow outage", async () => {
  items = Array.from({ length: 30 }, (_, i) => ({
    id: 94000 + i,
    title: `Title ${i}`,
    name: `Title ${i}`,
    media_type: "movie",
  }));
  slow = true;
  const start = Date.now();
  const result = await findTitles("streaming");
  assert.equal(result.length, 30);
  assert.ok(result.every((t) => t.viewing.status === "unavailable"));
  assert.ok(maximum <= 4, `Observed ${maximum} concurrent provider requests`);
  assert.ok(
    providers.length < items.length,
    "Must stop new provider work when the list's refresh budget expires",
  );
  assert.ok(
    Date.now() - start < 6000,
    "A provider outage must not hold the list for every per-title timeout",
  );
});

test("slow catalog search leaves time to return titles within the browser search deadline", async () => {
  items = Array.from({ length: 12 }, (_, i) => ({
    id: 95000 + i,
    title: `Delayed title ${i}`,
    name: `Delayed title ${i}`,
    media_type: "movie",
  }));
  searchDelay = 6000;
  slow = true;
  const start = Date.now();
  const result = await findTitles("streaming");
  assert.equal(result.length, 12);
  assert.ok(result.every((t) => t.viewing.status === "unavailable"));
  assert.ok(
    Date.now() - start < 9500,
    "Optional providers must not exhaust the ten-second browser deadline",
  );
});

test("suggestion and Watch together lists read cached availability in one query and refresh only expired or missing titles", async (t) => {
  const alice = await person("alice"),
    ben = await person("ben"),
    cam = await person("cam");
  await friend(alice, ben);
  await friend(cam, ben);
  const netflix = {
    link: null,
    providers: {
      flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: null }],
    },
  };
  // Fresh, older with failure backoff, failed with backoff, expired, missing.
  const cache: [string, string, string | null, string | null][] = [
    ["movie:96001", "fresh", "now()", "now()+interval '1 day'"],
    ["movie:96002", "fresh", "now()", "now()+interval '1 day'"],
    [
      "tv:96003",
      "stale",
      "now()-interval '2 days'",
      "now()+interval '5 minutes'",
    ],
    ["movie:96004", "failed", null, "now()+interval '5 minutes'"],
    [
      "movie:96005",
      "expired",
      "now()-interval '2 days'",
      "now()-interval '1 second'",
    ],
    ["tv:96006", "missing", null, null],
  ];
  for (const [id, state, fetched, refresh] of cache) {
    const [kind, tmdbId] = id.split(":");
    await db.query(
      "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,$2,$3,$4)",
      [id, kind, tmdbId, `Listed ${state} ${tmdbId}`],
    );
    if (refresh)
      await db.query(
        `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
        VALUES($1,'US',$2,${fetched ?? "NULL"},${refresh})`,
        [id, fetched ? netflix : null],
      );
    for (const user of [alice, ben])
      await updateTitleActivity(user, id, "want_to_watch", true);
  }
  const query = t.mock.method(db, "query");
  const cacheReads = () =>
    query.mock.calls.filter((call) =>
      /\bFROM title_availability\b/.test(String(call.arguments[0])),
    ).length;
  const viewing = (titles: { id: string; viewing: TitleViewing }[]) =>
    Object.fromEntries(titles.map((title) => [title.id, title.viewing]));
  const expected = {
    "movie:96001": ["ok", "Netflix"],
    "movie:96002": ["ok", "Netflix"],
    "tv:96003": ["stale", "Netflix"],
    "movie:96004": ["unavailable", undefined],
    "movie:96005": ["ok", "AMC+"],
    "tv:96006": ["ok", "AMC+"],
  };

  const together = await loadScreen(alice, "/watch-together?with=ben");
  if (together.kind !== "watch-together")
    throw new Error("Expected Watch together");
  assert.equal(together.titles.length, cache.length);
  assert.equal(cacheReads(), 1);
  assert.deepEqual(providers.sort(), [
    "/movie/96005/watch/providers",
    "/tv/96006/watch/providers",
  ]);
  const shared = viewing(together.titles);
  for (const [id, [status, service]] of Object.entries(expected)) {
    assert.equal(shared[id].status, status, id);
    assert.equal(shared[id].sections[0]?.services[0].name, service, id);
  }

  query.mock.resetCalls();
  providers = [];
  const search = await loadScreen(cam, "/search");
  if (search.kind !== "search") throw new Error("Expected search");
  assert.equal(search.suggestions.length, cache.length);
  assert.equal(cacheReads(), 1);
  assert.deepEqual(providers, []);
  const suggested = viewing(search.suggestions);
  assert.deepEqual(suggested, shared);
  // A list entry matches the title screen's single-title result.
  for (const [id] of cache) {
    const { status, checked_at, sections } = await getTitleAvailability(id);
    assert.deepEqual(suggested[id], { status, checked_at, sections }, id);
  }
  assert.deepEqual(providers, []);
});

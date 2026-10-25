import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  useDatabase,
  db,
  denied,
  friend,
  person,
  setup,
} from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");
const { saveServices } = await import("../../src/server/streaming-services");
useDatabase();

// A TMDB stand-in that answers each title's US watch providers. A title
// without offers fails, so its availability is unknown.
type Offer = { provider_id: number; provider_name: string; logo_path: null };
let offers: Record<string, Partial<Record<string, Offer[]>>> = {};
let providerRequests: string[] = [];
const catalog = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  const match = /^\/(movie|tv)\/(\d+)\/watch\/providers$/.exec(
    request.url ?? "",
  );
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  providerRequests.push(request.url!);
  const listed = offers[`${match[1]}:${match[2]}`];
  if (!listed) {
    response.writeHead(503).end();
    return;
  }
  response.end(
    JSON.stringify({ id: Number(match[2]), results: { US: listed } }),
  );
});
before(async () => {
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "want-to-watch-test-token";
});
beforeEach(async () => {
  await db.query("TRUNCATE title CASCADE");
  offers = {};
  providerRequests = [];
});
after(async () => {
  catalog.closeAllConnections();
  await new Promise<void>((resolve) => catalog.close(() => resolve()));
});

const offer = (provider_id: number, provider_name: string): Offer => ({
  provider_id,
  provider_name,
  logo_path: null,
});
const netflix = offer(1796, "Netflix with ads"),
  amcChannel = offer(528, "AMC+ Amazon Channel"),
  tubi = offer(73, "Tubi TV");

async function title(id: string, name: string, listed?: (typeof offers)[0]) {
  const [kind, tmdbId] = id.split(":");
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,$2,$3,$4)",
    [id, kind, tmdbId, name],
  );
  if (listed) offers[id] = listed;
  return id;
}

// Saves Want to watch for each title, the first newest.
async function want(owner: string, titles: string[]) {
  for (const id of titles)
    await updateTitleActivity(owner, id, "want_to_watch", true);
  await db.query(
    `UPDATE feed_item f SET activity_at='2026-10-01'::timestamptz-(o.n||' hours')::interval
    FROM unnest($2::text[]) WITH ORDINALITY o(title_id,n)
    WHERE f.owner_id=$1 AND f.title_id=o.title_id AND f.item_type='want_to_watch'`,
    [owner, titles],
  );
}

async function page(viewer: string, username: string) {
  const screen = await loadScreen(viewer, `/people/${username}/want-to-watch`);
  if (screen.kind !== "want-to-watch")
    throw new Error("Expected Want to watch");
  return screen;
}
const listed = (screen: Awaited<ReturnType<typeof page>>) =>
  screen.titles.map((t) => [t.id, t.access]);

test("a friend's Want to watch page lists titles on the viewer's services or free, newest first, and never reveals the owner's services", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await saveServices(alice, ["service:netflix"]);
  await saveServices(ben, ["service:amc-plus", "service:hulu"]);
  const free = await title("tv:2", "Free Show", { ads: [tubi] });
  const subscription = await title("movie:8", "Netflix Movie", {
    flatrate: [netflix],
  });
  const ownersService = await title("movie:3", "AMC Movie", {
    flatrate: [amcChannel],
  });
  const rental = await title("movie:4", "Rental Movie", {
    rent: [offer(8, "Netflix")],
    buy: [offer(526, "AMC+")],
  });
  const unknown = await title("tv:5", "Unknown Show");
  const stale = await title("movie:6", "Older Free Movie");
  await db.query(
    `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
    VALUES($1,'US',$2,now()-interval '2 days',now()-interval '1 second')`,
    [stale, { link: null, providers: { free: [tubi] } }],
  );
  const alicesOnly = await title("movie:7", "Alice Only", { ads: [tubi] });
  await want(alice, [alicesOnly]);
  await want(ben, [free, ownersService, subscription, rental, unknown, stale]);

  const screen = await page(alice, "ben");
  assert.equal(screen.owner.username, "ben");
  assert.equal(screen.owner.user_id, ben);
  assert.deepEqual(listed(screen), [
    [free, "available"],
    [subscription, "available"],
    [unknown, "unknown"],
    [stale, "available"],
  ]);
  const byId = Object.fromEntries(screen.titles.map((t) => [t.id, t]));
  assert.deepEqual(byId[subscription].matchingServiceIds, ["service:netflix"]);
  assert.equal(
    byId[subscription].viewing.sections[0].services[0].name,
    "Netflix",
  );
  assert.deepEqual(byId[free].matchingServiceIds, []);
  assert.equal(byId[free].viewing.sections[0].key, "free");
  assert.equal(byId[stale].viewing.status, "stale");
  assert.equal(byId[unknown].viewing.status, "unavailable");
  assert.equal(screen.viewerHasServices, true);
  assert.equal(screen.hasWantToWatch, true);

  // The owner's saved services never reach the viewer: the response is the
  // same whatever the owner saves.
  for (const id of ["service:amc-plus", "service:hulu"])
    assert.equal(JSON.stringify(screen).includes(id), false, id);
  await saveServices(ben, ["service:netflix"]);
  assert.deepEqual(await page(alice, "ben"), screen);
  await saveServices(ben, []);
  assert.deepEqual(await page(alice, "ben"), screen);

  // On their own page, the owner's services decide.
  await saveServices(ben, ["service:amc-plus"]);
  const own = await page(ben, "ben");
  assert.equal(own.owner.username, "ben");
  assert.deepEqual(listed(own), [
    [free, "available"],
    [ownersService, "available"],
    [unknown, "unknown"],
    [stale, "available"],
  ]);
  assert.deepEqual(
    own.titles.find((t) => t.id === ownersService)?.matchingServiceIds,
    ["service:amc-plus"],
  );

  // Without saved services, only free options count, and the page says so.
  await saveServices(alice, []);
  const unsaved = await page(alice, "ben");
  assert.equal(unsaved.viewerHasServices, false);
  assert.deepEqual(listed(unsaved), [
    [free, "available"],
    [unknown, "unknown"],
    [stale, "available"],
  ]);
});

test("titles moved off Want to watch drop out on the next read, and a new save puts a title first", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const titles = [
    await title("movie:11", "First", { free: [tubi] }),
    await title("tv:12", "Second", { ads: [tubi] }),
    await title("movie:13", "Third", { free: [tubi] }),
    await title("tv:14", "Fourth", { free: [tubi] }),
  ];
  await want(ben, titles);
  assert.deepEqual(
    (await page(alice, "ben")).titles.map((t) => t.id),
    titles,
  );
  await updateTitleActivity(ben, "movie:11", "want_to_watch", false);
  await updateTitleActivity(ben, "tv:12", "recommended", true);
  await updateWatchStatus(ben, "movie:13", "watching");
  assert.deepEqual(
    (await page(alice, "ben")).titles.map((t) => t.id),
    ["tv:14"],
  );
  await updateTitleActivity(ben, "movie:11", "want_to_watch", true);
  const restored = await page(alice, "ben");
  assert.deepEqual(
    restored.titles.map((t) => t.id),
    ["movie:11", "tv:14"],
  );
  assert.equal(restored.hasWantToWatch, true);
});

test("a page with nothing watchable still reports that the owner has Want to watch titles", async () => {
  const alice = await person("alice");
  const empty = await page(alice, "alice");
  assert.deepEqual(empty.titles, []);
  assert.equal(empty.hasWantToWatch, false);
  assert.equal(empty.viewerHasServices, false);
  await want(alice, [
    await title("movie:21", "Subscription Only", { flatrate: [netflix] }),
    await title("movie:22", "Rental Only", { rent: [offer(8, "Netflix")] }),
  ]);
  const unwatchable = await page(alice, "alice");
  assert.deepEqual(unwatchable.titles, []);
  assert.equal(unwatchable.hasWantToWatch, true);
});

test("Want to watch pages read cached availability in one query and reuse it", async (t) => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const titles: string[] = [];
  for (let n = 100; n < 160; n++)
    titles.push(await title(`movie:${n}`, `Free ${n}`, { free: [tubi] }));
  await want(ben, titles);
  const query = t.mock.method(db, "query");
  const cacheReads = () =>
    query.mock.calls.filter((call) =>
      /\bFROM title_availability\b/.test(String(call.arguments[0])),
    ).length;
  const first = await page(alice, "ben");
  // Every title appears, with no feed-sized cutoff.
  assert.equal(first.titles.length, 60);
  assert.equal(cacheReads(), 1);
  assert.equal(providerRequests.length, 60);
  query.mock.resetCalls();
  assert.deepEqual(await page(alice, "BEN"), first);
  assert.equal(cacheReads(), 1);
  assert.equal(providerRequests.length, 60);
});

test("Want to watch pages follow the friendship and blocking rules", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await want(ben, [await title("movie:31", "Free Movie", { free: [tubi] })]);
  const path = "/people/ben/want-to-watch";
  // Each member can open their own page.
  assert.deepEqual(
    (await page(ben, "ben")).titles.map((t) => t.id),
    ["movie:31"],
  );
  await assert.rejects(loadScreen(alice, path), denied.wantToWatch);
  await changeRelationship(alice, ben, "request");
  await assert.rejects(loadScreen(alice, path), denied.wantToWatch);
  await assert.rejects(
    loadScreen(ben, "/people/alice/want-to-watch"),
    denied.wantToWatch,
  );
  await changeRelationship(ben, alice, "accept");
  assert.deepEqual(
    (await page(alice, "ben")).titles.map((t) => t.id),
    ["movie:31"],
  );
  // Friends of friends and missing members get nothing.
  await friend(ben, cam);
  await assert.rejects(
    loadScreen(cam, "/people/alice/want-to-watch"),
    denied.wantToWatch,
  );
  await assert.rejects(loadScreen(outsider, path), denied.wantToWatch);
  await assert.rejects(
    loadScreen(alice, "/people/missing/want-to-watch"),
    denied.wantToWatch,
  );
  await changeRelationship(ben, alice, "remove");
  await assert.rejects(loadScreen(alice, path), denied.wantToWatch);
  await friend(alice, ben);
  assert.equal((await page(alice, "ben")).owner.username, "ben");
  await changeRelationship(ben, alice, "block");
  await assert.rejects(loadScreen(alice, path), denied.wantToWatch);
  await assert.rejects(
    loadScreen(ben, "/people/alice/want-to-watch"),
    denied.wantToWatch,
  );
});

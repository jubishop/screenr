import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const { db } = await import("../../src/server/db");
const { migrate } = await import("../../scripts/migrate");
const { loadScreen } = await import("../../src/server/screens");

const provider = {
  provider_id: 101,
  provider_name: "Harbor Stream",
  logo_path: "/harbor.jpg",
  display_priority: 1,
};
const categories = ["flatrate", "free", "ads", "rent", "buy"] as const;
let payload: unknown;
let status: number;
let slow: boolean;
let requests: { path: string; authorization?: string }[];
const catalog = createServer((request, response) => {
  if (request.url?.endsWith("/watch/providers")) {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
    });
    if (slow) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        results: [
          {
            site: "YouTube",
            type: "Trailer",
            key: "Abcdef_1234",
            name: "Trailer",
          },
        ],
      }),
    );
  }
});

function options(kind = "movie") {
  return {
    id: 42,
    results: {
      US: {
        link: `https://www.themoviedb.org/${kind}/42-title/watch?locale=US`,
        ...Object.fromEntries(
          categories.map((category) => [category, [provider]]),
        ),
      },
      CA: { flatrate: [{ ...provider, provider_name: "Canada only" }] },
    },
  };
}
before(async () => {
  await migrate();
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "availability-test-token";
});
beforeEach(async () => {
  payload = options();
  status = 200;
  slow = false;
  requests = [];
  await db.query('TRUNCATE "user", title RESTART IDENTITY CASCADE');
  await db.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES('viewer','Viewer','viewer@example.test',true,now(),now())`);
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES('viewer','viewer','Viewer')",
  );
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('movie:42','movie',42,'Test Movie'), ('tv:42','tv',42,'Test Show')`);
  await db.query(`INSERT INTO conversation(id,owner_id,title_id,recommended)
    VALUES('00000000-0000-4000-8000-000000000006','viewer','movie:42',true)`);
});
after(async () => {
  catalog.closeAllConnections();
  await new Promise<void>((resolve) => catalog.close(() => resolve()));
  await db.end();
});

async function screen(kind = "movie") {
  const result = await loadScreen("viewer", `/titles/${kind}/42`);
  assert.equal(result.kind, "title");
  if (result.kind !== "title") throw new Error("Expected a title screen");
  assert.equal(
    result.title.name,
    kind === "movie" ? "Test Movie" : "Test Show",
  );
  assert.equal(result.trailer?.key, "Abcdef_1234");
  if (kind === "movie") assert.equal(result.conversations.length, 1);
  return result.availability;
}

for (const kind of ["movie", "tv"]) {
  test(`${kind} title screens include US watch options and cache every viewing category`, async () => {
    payload = options(kind);
    const availability = await screen(kind);
    assert.equal(availability?.status, "ok");
    assert.equal(availability.country, "US");
    assert.equal(availability.link, options(kind).results.US.link);
    assert.ok(availability.checked_at);
    assert.ok(Date.now() - Date.parse(availability.checked_at) < 10_000);
    assert.deepEqual(
      availability.providers,
      Object.fromEntries(
        categories.map((category) => [
          category,
          [
            {
              provider_id: 101,
              provider_name: "Harbor Stream",
              logo_path: "/harbor.jpg",
            },
          ],
        ]),
      ),
    );
    assert.deepEqual(requests, [
      {
        path: `/${kind}/42/watch/providers`,
        authorization: "Bearer availability-test-token",
      },
    ]);
    payload = { id: 42, results: {} };
    assert.deepEqual(await screen(kind), availability);
    assert.equal(requests.length, 1);
  });
}

test("movie and TV with the same TMDB number have independent availability", async () => {
  await screen();
  payload = { id: 42, results: {} };
  const tv = await screen("tv");
  assert.equal(tv.status, "ok");
  assert.deepEqual(tv.providers, {});
  assert.equal(requests.length, 2);
  assert.equal(
    (await screen()).providers.flatrate?.[0].provider_name,
    "Harbor Stream",
  );
});

for (const results of [
  {},
  { CA: options().results.CA },
  { US: { link: options().results.US.link } },
]) {
  test(`successful empty US availability is cached: ${JSON.stringify(results)}`, async () => {
    payload = { id: 42, results };
    const empty = await screen();
    assert.equal(empty.status, "ok");
    assert.deepEqual(empty.providers, {});
    assert.ok(empty.checked_at);
    payload = options();
    assert.deepEqual(await screen(), empty);
    assert.equal(requests.length, 1);
    await db.query(
      "UPDATE title_availability SET refresh_after=now()-interval '1 second', fetched_at=now()-interval '25 hours'",
    );
    assert.equal((await screen()).providers.buy?.[0].provider_id, 101);
    assert.equal(requests.length, 2);
  });
}

test("successful availability stays cached for 24 hours and then refreshes on demand", async () => {
  await screen();
  payload = { id: 42, results: {} };
  await db.query(
    "UPDATE title_availability SET fetched_at=fetched_at-interval '23 hours', refresh_after=refresh_after-interval '23 hours'",
  );
  assert.equal((await screen()).providers.flatrate?.[0].provider_id, 101);
  assert.equal(requests.length, 1);
  await db.query(
    "UPDATE title_availability SET fetched_at=fetched_at-interval '2 hours', refresh_after=refresh_after-interval '2 hours'",
  );
  const refreshed = await screen();
  assert.equal(refreshed.status, "ok");
  assert.deepEqual(refreshed.providers, {});
  assert.equal(requests.length, 2);
});

test("a successful refresh removes offers which are no longer listed", async () => {
  await screen();
  await db.query(
    "UPDATE title_availability SET refresh_after=now()-interval '1 second', fetched_at=now()-interval '25 hours'",
  );
  payload = { id: 42, results: {} };
  const refreshed = await screen();
  assert.equal(refreshed.status, "ok");
  assert.deepEqual(refreshed.providers, {});
  assert.ok(Date.now() - Date.parse(refreshed.checked_at!) < 10_000);
});

for (const failure of ["http", "timeout", "malformed", "configuration"]) {
  test(`a ${failure} failure preserves the last success and backs off before recovering`, async () => {
    const initial = await screen();
    const age = "2020-01-01T00:00:00.000Z";
    await db.query(
      "UPDATE title_availability SET refresh_after=now()-interval '1 second', fetched_at=$1",
      [age],
    );
    const testURL = process.env.SCREENR_TEST_TMDB_URL;
    status = failure === "http" ? 503 : 200;
    slow = failure === "timeout";
    if (failure === "malformed")
      payload = { id: 42, results: { US: { rent: "invalid" } } };
    if (failure === "configuration") {
      delete process.env.SCREENR_TEST_TMDB_URL;
      delete process.env.TMDB_READ_TOKEN;
    }
    try {
      const stale = await screen();
      assert.equal(stale.status, "stale");
      assert.equal(stale.checked_at, age);
      assert.deepEqual(stale.providers, initial.providers);
      assert.equal(stale.link, initial.link);
      const count = requests.length;
      assert.deepEqual(await screen(), stale);
      assert.equal(requests.length, count);
    } finally {
      process.env.SCREENR_TEST_TMDB_URL = testURL;
      process.env.TMDB_READ_TOKEN = "availability-test-token";
      status = 200;
      slow = false;
    }
    payload = { id: 42, results: {} };
    await db.query(
      "UPDATE title_availability SET refresh_after=now()-interval '1 second'",
    );
    const recovered = await screen();
    assert.equal(recovered.status, "ok");
    assert.deepEqual(recovered.providers, {});
    assert.notEqual(recovered.checked_at, age);
  });
}

for (const invalid of [
  null,
  {},
  { id: 42, results: [] },
  { id: 99, results: {} },
  { id: 42, results: { US: null } },
  { id: 42, results: { US: { flatrate: [{}] } } },
  {
    id: 42,
    results: { US: { link: "javascript:alert(1)", rent: [provider] } },
  },
]) {
  test(`malformed availability does not become a successful empty result: ${JSON.stringify(invalid)}`, async () => {
    payload = invalid;
    const unavailable = await screen();
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.checked_at, null);
    assert.equal(unavailable.link, null);
    assert.deepEqual(unavailable.providers, {});
    payload = options();
    assert.deepEqual(await screen(), unavailable);
    assert.equal(requests.length, 1);
  });
}

test("an initial HTTP failure can recover after the retry delay", async () => {
  status = 503;
  assert.equal((await screen()).status, "unavailable");
  assert.equal((await screen()).status, "unavailable");
  assert.equal(requests.length, 1);
  status = 200;
  await db.query(
    "UPDATE title_availability SET refresh_after=now()-interval '1 second'",
  );
  assert.equal((await screen()).status, "ok");
  assert.equal(requests.length, 2);
});

test("unsafe or absent logos do not remove otherwise usable providers", async () => {
  payload = {
    id: 42,
    results: {
      US: {
        rent: [{ ...provider, logo_path: "https://other.example/logo.svg" }],
        buy: [{ ...provider, logo_path: null }],
      },
    },
  };
  const result = await screen();
  assert.equal(result.status, "ok");
  assert.equal(result.providers.rent?.[0].logo_path, null);
  assert.equal(result.providers.buy?.[0].logo_path, null);
});

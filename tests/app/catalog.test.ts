import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { db, cookieFor } from "./social-fixture";

const { migrate } = await import("../../scripts/migrate");
const { loadScreen } = await import("../../src/server/screens");
const { POST } = await import("../../src/app/api/screenr/[action]/route");

const official = {
  site: "YouTube",
  type: "Trailer",
  key: "Abcdef_1234",
  name: "Official trailer",
  official: true,
};
let videos: unknown;
let status = 200;
let slow = false;
// Title details respond separately so a refresh can fail on its own.
let details: { status: number; slow: boolean; body: unknown; delay: number };
let delay = 0;
let active = 0;
let maximum = 0;
let providerRequests = 0;
let requests: { path: string; authorization?: string }[] = [];
const catalog = createServer((request, response) => {
  active++;
  maximum = Math.max(maximum, active);
  response.on("close", () => active--);
  const path = request.url!;
  const reply = (code: number, body: unknown, wait = delay) =>
    setTimeout(() => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    }, wait);
  if (path.endsWith("/watch/providers")) {
    providerRequests++;
    reply(200, { id: Number(path.split("/")[2]), results: {} });
    return;
  }
  requests.push({ path, authorization: request.headers.authorization });
  if (/^\/(movie|tv)\/\d+$/.test(path)) {
    if (!details.slow) reply(details.status, details.body, details.delay);
    return;
  }
  if (slow) return; // Exercise the real network timeout.
  reply(status, videos);
});

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "catalog-test-token";
});
beforeEach(async () => {
  videos = { results: [official] };
  status = 200;
  slow = false;
  details = {
    status: 200,
    slow: false,
    body: { id: 42, title: "Renamed Movie", name: "Renamed Show" },
    delay: 0,
  };
  delay = active = maximum = providerRequests = 0;
  requests = [];
  await db.query(
    'TRUNCATE "user", verification, title RESTART IDENTITY CASCADE',
  );
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
  return result;
}

for (const kind of ["movie", "tv"]) {
  test(`${kind} title screens prefer a valid official YouTube trailer and cache it`, async () => {
    videos = {
      results: [
        { ...official, official: false, key: "Unofficial1" },
        { ...official, type: "Teaser", key: "Teaser_1234" },
        { ...official, site: "Vimeo" },
        { ...official, key: "bad?autoplay=1" },
        official,
      ],
    };
    const result = await screen(kind);
    assert.deepEqual(result.trailer, {
      key: official.key,
      name: official.name,
    });
    assert.equal(
      result.title.name,
      kind === "movie" ? "Test Movie" : "Test Show",
    );
    if (kind === "movie") assert.equal(result.conversations.length, 1);
    assert.deepEqual(requests, [
      {
        path: `/${kind}/42/videos`,
        authorization: "Bearer catalog-test-token",
      },
    ]);
    videos = { results: [] };
    assert.deepEqual((await screen(kind)).trailer, result.trailer);
    assert.equal(requests.length, 1);
  });
}

test("uses an unofficial trailer when there is no valid official trailer", async () => {
  videos = { results: [{ ...official, official: false }] };
  assert.deepEqual((await screen()).trailer, {
    key: official.key,
    name: official.name,
  });
});

for (const unavailable of [
  null,
  {},
  { results: null },
  { results: [] },
  {
    results: [
      null,
      false,
      "video",
      {},
      { ...official, type: "Clip" },
      { ...official, site: "Vimeo" },
      { ...official, key: "https://evil.example/video" },
      { ...official, key: 123 },
      { ...official, name: " " },
    ],
  },
]) {
  test(`unavailable or invalid metadata does not remove title details or conversations: ${JSON.stringify(unavailable)}`, async () => {
    videos = unavailable;
    const result = await screen();
    assert.equal(result.trailer, null);
    assert.equal(result.title.name, "Test Movie");
    assert.equal(result.conversations.length, 1);
  });
}

test("caches an absent trailer and refreshes expired public metadata", async () => {
  videos = { results: [] };
  assert.equal((await screen()).trailer, null);
  videos = { results: [official] };
  assert.equal((await screen()).trailer, null);
  assert.equal(requests.length, 1);
  await db.query(
    "UPDATE title_trailer SET expires_at=now()-interval '1 second'",
  );
  assert.deepEqual((await screen()).trailer, {
    key: official.key,
    name: official.name,
  });
  assert.equal(requests.length, 2);
});

for (const failure of ["http", "timeout", "configuration"]) {
  test(`a trailer ${failure} failure preserves the title and conversations`, async () => {
    status = failure === "http" ? 503 : 200;
    slow = failure === "timeout";
    const testURL = process.env.SCREENR_TEST_TMDB_URL;
    if (failure === "configuration") {
      delete process.env.SCREENR_TEST_TMDB_URL;
      delete process.env.TMDB_READ_TOKEN;
    }
    try {
      const result = await screen();
      assert.equal(result.trailer, null);
      assert.equal(result.title.name, "Test Movie");
      assert.equal(result.conversations.length, 1);
      const count = requests.length;
      await screen();
      assert.equal(
        requests.length,
        count,
        "failed requests must not repeat on each page refresh",
      );
    } finally {
      process.env.SCREENR_TEST_TMDB_URL = testURL;
      process.env.TMDB_READ_TOKEN = "catalog-test-token";
    }
  });
}

const detailRequests = (kind = "movie") =>
  requests.filter((request) => request.path === `/${kind}/42`).length;

for (const failure of ["http", "timeout", "not found", "invalid"]) {
  test(`a stale stored title renders during a TMDB ${failure} failure and backs off`, async () => {
    await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
    details.status =
      failure === "http" ? 503 : failure === "not found" ? 404 : 200;
    details.slow = failure === "timeout";
    if (failure === "invalid") details.body = { id: 42 };
    for (const kind of ["movie", "tv"]) {
      const result = await screen(kind);
      assert.equal(
        result.title.name,
        kind === "movie" ? "Test Movie" : "Test Show",
      );
      assert.deepEqual(Object.keys(result.title).sort(), [
        "id",
        "kind",
        "name",
        "overview",
        "poster_path",
        "release_date",
        "tmdb_id",
      ]);
      assert.equal(result.conversations.length, kind === "movie" ? 1 : 0);
      assert.equal(result.trailer?.key, official.key);
      assert.equal(detailRequests(kind), 1);
      await screen(kind);
      assert.equal(
        detailRequests(kind),
        1,
        "failed refreshes must not repeat on each page refresh",
      );
    }
  });
}

test("a failed title refresh retries after its delay and recovers fresh details", async () => {
  await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
  details.status = 503;
  assert.equal((await screen()).title.name, "Test Movie");
  await db.query("UPDATE title SET retry_after=now()-interval '1 second'");
  details.status = 200;
  assert.equal((await screen()).title.name, "Renamed Movie");
  assert.equal(detailRequests(), 2);
  assert.equal((await screen()).title.name, "Renamed Movie");
  assert.equal(detailRequests(), 2);
});

test("a title missing from storage still needs the catalog", async () => {
  details.status = 404;
  await assert.rejects(loadScreen("viewer", "/titles/movie/43"), {
    status: 404,
  });
  details.status = 503;
  await assert.rejects(loadScreen("viewer", "/titles/movie/43"), {
    status: 502,
  });
});

test("a cold title page requests details, trailer, and availability together", async () => {
  delay = 100;
  details.delay = 300; // Optional metadata arrives before the title is stored.
  details.body = { id: 43, title: "Cold Movie" };
  const result = await loadScreen("viewer", "/titles/movie/43");
  if (result.kind !== "title") throw new Error("Expected a title screen");
  assert.equal(result.title.name, "Cold Movie");
  assert.equal(maximum, 3, "Expected parallel catalog requests");
  assert.equal(result.trailer?.key, official.key);
  assert.equal(result.availability.status, "ok");
  const count = requests.length + providerRequests;
  await loadScreen("viewer", "/titles/movie/43");
  assert.equal(requests.length + providerRequests, count);
});

test("actions and comments on a stored title skip the catalog after TMDB drops it", async () => {
  await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
  details.status = 404;
  const cookie = await cookieFor("viewer");
  const post = (action: string, data: unknown) =>
    POST(
      new Request(`http://localhost:3000/api/screenr/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify(data),
      }),
      { params: Promise.resolve({ action }) },
    );
  const removed = await post("activity", {
    title: "movie:42",
    field: "recommended",
    value: false,
  });
  assert.equal(removed.status, 200);
  assert.equal(
    (
      await db.query(
        "SELECT active FROM feed_item WHERE owner_id='viewer' AND title_id='movie:42' AND item_type='recommended'",
      )
    ).rows[0].active,
    false,
  );
  const comment = await post("title-comment", {
    title: "movie:42",
    body: "Still here",
    spoiler: false,
  });
  assert.equal(comment.status, 200);
  assert.equal(detailRequests(), 0);
  const missing = await post("activity", {
    title: "movie:43",
    field: "want_to_watch",
    value: true,
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/movie/43"],
  );
});

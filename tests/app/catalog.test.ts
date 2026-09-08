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
let requests: { path: string; authorization?: string }[] = [];
const catalog = createServer((request, response) => {
  if (request.url?.endsWith("/watch/providers")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: 42, results: {} }));
    return;
  }
  requests.push({
    path: request.url!,
    authorization: request.headers.authorization,
  });
  if (slow) return; // Exercise the real network timeout.
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(videos));
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

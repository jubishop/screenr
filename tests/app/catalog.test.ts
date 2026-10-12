import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { db, cookieFor } from "./social-fixture";

const { migrate } = await import("../../scripts/migrate");
const { loadScreen } = await import("../../src/server/screens");
const { GET, POST } = await import("../../src/app/api/screenr/[action]/route");
const { getTitle, searchTitles } = await import("../../src/server/catalog");

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
// Title details and search respond separately so each can fail on its own.
// `text` replaces the JSON body, and `reset` drops the connection unanswered.
type Reply = {
  status: number;
  slow: boolean;
  body: unknown;
  delay: number;
  text?: string;
  reset?: boolean;
};
let details: Reply;
let search: Reply;
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
  const reply = (
    code: number,
    body: unknown,
    wait = delay,
    text = JSON.stringify(body),
  ) =>
    setTimeout(() => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(text);
    }, wait);
  const send = ({ status, slow, body, delay, text, reset }: Reply) => {
    if (reset) response.destroy();
    else if (!slow) reply(status, body, delay, text);
  };
  if (path.endsWith("/watch/providers")) {
    providerRequests++;
    reply(200, { id: Number(path.split("/")[2]), results: {} });
    return;
  }
  requests.push({ path, authorization: request.headers.authorization });
  if (/^\/(movie|tv)\/\d+$/.test(path)) return send(details);
  if (path.startsWith("/search/multi?")) return send(search);
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
  search = { status: 200, slow: false, body: { results: [] }, delay: 0 };
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

for (const failure of [
  "http",
  "timeout",
  "not found",
  "invalid",
  "mismatched ID",
]) {
  test(`a stale stored title renders during a TMDB ${failure} failure and backs off`, async () => {
    await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
    details.status =
      failure === "http" ? 503 : failure === "not found" ? 404 : 200;
    details.slow = failure === "timeout";
    if (failure === "invalid") details.body = { id: 42 };
    if (failure === "mismatched ID")
      details.body = { id: 43, title: "Other Movie", name: "Other Show" };
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
    assert.deepEqual(
      (await db.query("SELECT id FROM title ORDER BY id")).rows,
      [{ id: "movie:42" }, { id: "tv:42" }],
    );
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

const unavailable = {
  status: 502,
  message: "The movie catalog is temporarily unavailable. Please try again.",
};
const invalidTitle = {
  status: 502,
  message: "The catalog returned an invalid title.",
};
const invalidResults = {
  status: 502,
  message: "The catalog returned invalid search results.",
};
// A title page that fails on details can leave optional metadata requests in
// flight, so these assertions read only title-detail and search requests.
const lookups = () =>
  requests
    .map((request) => request.path)
    .filter((path) => /^\/(movie|tv)\/\d+$|^\/search\//.test(path));
const storedTitle = async (id: string) =>
  (
    await db.query(
      "SELECT id,kind,tmdb_id,name,overview,poster_path,release_date FROM title WHERE id=$1",
      [id],
    )
  ).rows[0];

test("a title missing from storage still needs the catalog", async () => {
  details.status = 404;
  await assert.rejects(loadScreen("viewer", "/titles/movie/43"), {
    status: 404,
    message: "Title not found.",
  });
  details.status = 503;
  await assert.rejects(loadScreen("viewer", "/titles/movie/43"), unavailable);
});

// Every TMDB failure except a 404 means the catalog is unavailable.
const failures: Record<string, Partial<Reply>> = {
  "server error": { status: 500 },
  outage: { status: 503 },
  "rate limit": { status: 429 },
  "rejected token": { status: 401 },
  "malformed JSON": { text: "{not json" },
  "dropped connection": { reset: true },
};
for (const [failure, reply] of Object.entries(failures)) {
  test(`a TMDB ${failure} makes a cold title and search unavailable`, async () => {
    Object.assign(details, reply);
    Object.assign(search, reply);
    await assert.rejects(getTitle("movie:43"), unavailable);
    await assert.rejects(searchTitles("night"), unavailable);
    assert.deepEqual(lookups(), [
      "/movie/43",
      "/search/multi?query=night&include_adult=false",
    ]);
    assert.equal(await storedTitle("movie:43"), undefined);
  });
}

test("an unconfigured catalog makes a cold title and search unavailable", async () => {
  const testURL = process.env.SCREENR_TEST_TMDB_URL;
  delete process.env.SCREENR_TEST_TMDB_URL;
  delete process.env.TMDB_READ_TOKEN;
  try {
    const unconfigured = {
      status: 503,
      message: "The movie catalog is not configured yet.",
    };
    await assert.rejects(getTitle("movie:43"), unconfigured);
    await assert.rejects(searchTitles("night"), unconfigured);
    assert.deepEqual(lookups(), []);
  } finally {
    process.env.SCREENR_TEST_TMDB_URL = testURL;
    process.env.TMDB_READ_TOKEN = "catalog-test-token";
  }
});

for (const [kind, body] of [
  ["movie", null],
  ["movie", []],
  ["movie", { title: "Missing ID" }],
  ["movie", { id: 0, title: "Zero ID" }],
  ["movie", { id: -43, title: "Negative ID" }],
  ["movie", { id: 4.3, title: "Fractional ID" }],
  ["movie", { id: "43", title: "Text ID" }],
  ["movie", { id: 2 ** 53, title: "Unsafe ID" }],
  ["movie", { id: 43 }],
  ["movie", { id: 43, title: "" }],
  ["movie", { id: 43, title: 43 }],
  ["movie", { id: 43, name: "Show name only" }],
  ["tv", { id: 43, title: "Movie title only" }],
] as const) {
  test(`a cold ${kind} rejects invalid TMDB details: ${JSON.stringify(body)}`, async () => {
    details.body = body;
    await assert.rejects(getTitle(`${kind}:43`), invalidTitle);
    assert.equal(await storedTitle(`${kind}:43`), undefined);
  });
}

test("cold title details for another TMDB ID store and update nothing", async () => {
  const titles = async () =>
    (await db.query("SELECT * FROM title ORDER BY id")).rows;
  const existing = await titles();
  details.body = { id: 42, title: "Other Movie", name: "Other Show" };
  for (const kind of ["movie", "tv"])
    await assert.rejects(getTitle(`${kind}:43`), invalidTitle);
  assert.deepEqual(await titles(), existing);
});

test("cold title details keep each kind's fields and only text values", async () => {
  details.body = {
    id: 43,
    title: "Cold Movie",
    name: "Not the movie title",
    overview: 7,
    release_date: 2024,
    first_air_date: "2001-01-01",
  };
  const movie = {
    id: "movie:43",
    kind: "movie",
    tmdb_id: 43,
    name: "Cold Movie",
    overview: "",
    poster_path: null,
    release_date: "",
  };
  assert.deepEqual(await getTitle("movie:43"), movie);
  assert.deepEqual(await storedTitle("movie:43"), movie);
  details.body = {
    id: 43,
    name: "Cold Show",
    title: "Not the show name",
    overview: "Plot",
    first_air_date: "2024-05-01",
    release_date: "1999-01-01",
    poster_path: "/show.jpg",
  };
  const show = {
    id: "tv:43",
    kind: "tv",
    tmdb_id: 43,
    name: "Cold Show",
    overview: "Plot",
    poster_path: "/show.jpg",
    release_date: "2024-05-01",
  };
  assert.deepEqual(await getTitle("tv:43"), show);
  assert.deepEqual(await storedTitle("tv:43"), show);
});

test("cold title details keep only a single-segment TMDB poster path", async () => {
  const posters: [unknown, string | null][] = [
    ["/Poster-1_a.jpg", "/Poster-1_a.jpg"],
    ["https://evil.example/poster.jpg", null],
    ["//evil.example/poster.jpg", null],
    ["/../poster.jpg", null],
    ["/w500/poster.jpg", null],
    ["/poster.jpg?size=original", null],
    ["/poster.jpg\n/evil.jpg", null],
    ["poster.jpg", null],
    ["/", null],
    [43, null],
  ];
  for (const [index, [poster_path, expected]] of posters.entries()) {
    const id = 100 + index;
    details.body = { id, title: "Poster", poster_path };
    assert.equal(
      (await getTitle(`movie:${id}`)).poster_path,
      expected,
      JSON.stringify(poster_path),
    );
    assert.equal((await storedTitle(`movie:${id}`)).poster_path, expected);
  }
});

test("search skips queries under two characters and rejects ones over 120", async () => {
  for (const query of ["", " ", "a", " a ", "\ta\n"])
    assert.deepEqual(await searchTitles(query), []);
  await assert.rejects(searchTitles("a".repeat(121)), {
    status: 400,
    message: "Use a shorter search.",
  });
  assert.deepEqual(lookups(), []);
  for (const query of ["ab", "a".repeat(120), "Tom & Jerry"])
    assert.deepEqual(await searchTitles(query), []);
  assert.deepEqual(lookups(), [
    "/search/multi?query=ab&include_adult=false",
    `/search/multi?query=${"a".repeat(120)}&include_adult=false`,
    "/search/multi?query=Tom%20%26%20Jerry&include_adult=false",
  ]);
});

test("search keeps valid movie and TV results and drops other media", async () => {
  search.body = {
    results: [
      { media_type: "person", id: 7, name: "An Actor" },
      {
        media_type: "movie",
        id: 43,
        title: "Found Movie",
        overview: "Plot",
        poster_path: "/movie.jpg",
        release_date: "2024-01-02",
      },
      { media_type: "collection", id: 8, name: "A Collection" },
      { id: 9, title: "No media type" },
      null,
      "movie",
      {
        media_type: "tv",
        id: 44,
        name: "Found Show",
        poster_path: "https://evil.example/show.jpg",
        first_air_date: "2023-03-04",
      },
    ],
  };
  assert.deepEqual(await searchTitles("found"), [
    {
      id: "movie:43",
      kind: "movie",
      tmdb_id: 43,
      name: "Found Movie",
      overview: "Plot",
      poster_path: "/movie.jpg",
      release_date: "2024-01-02",
    },
    {
      id: "tv:44",
      kind: "tv",
      tmdb_id: 44,
      name: "Found Show",
      overview: "",
      poster_path: null,
      release_date: "2023-03-04",
    },
  ]);
});

for (const body of [
  null,
  [],
  {},
  { results: null },
  { results: {} },
  { results: "movie" },
]) {
  test(`search rejects invalid TMDB results: ${JSON.stringify(body)}`, async () => {
    search.body = body;
    await assert.rejects(searchTitles("night"), invalidResults);
  });
}

test("search rejects an invalid movie or TV result", async () => {
  for (const result of [
    { media_type: "movie", id: 0, title: "Zero ID" },
    { media_type: "tv", id: 44, title: "Movie title only" },
  ]) {
    search.body = {
      results: [{ media_type: "movie", id: 43, title: "Valid" }, result],
    };
    await assert.rejects(searchTitles("night"), invalidTitle);
  }
});

test("the search API returns catalog errors with their statuses", async () => {
  const cookie = await cookieFor("viewer");
  const find = async (q: string) => {
    const response = await GET(
      new Request(
        `http://localhost:3000/api/screenr/search?${new URLSearchParams({ q })}`,
        { headers: { Cookie: cookie } },
      ),
      { params: Promise.resolve({ action: "search" }) },
    );
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await find("a"), { status: 200, body: [] });
  assert.deepEqual(await find("a".repeat(121)), {
    status: 400,
    body: { error: "Use a shorter search." },
  });
  search.status = 503;
  assert.deepEqual(await find("night"), {
    status: 502,
    body: { error: unavailable.message },
  });
  search.status = 200;
  search.body = null;
  assert.deepEqual(await find("night"), {
    status: 502,
    body: { error: invalidResults.message },
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

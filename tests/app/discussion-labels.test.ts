import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  useDatabase,
  db,
  cookieFor,
  friend,
  setup,
  assertRouteError,
} from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { thread } = await import("../../src/server/feed");
const { createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { titleSeasons, seasonEpisodes } =
  await import("../../src/server/catalog");
const { GET, POST } = await import("../../src/app/api/screenr/[action]/route");

useDatabase();

// TMDB's season list and season details. Show 8 lists Specials and two
// seasons; show 9 fails; show 10 returns malformed details.
const catalog = createServer((request, response) => {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/tv/8")
    return reply(200, {
      id: 8,
      name: "Test Show",
      seasons: [
        { season_number: 0, name: "Specials", episode_count: 2 },
        { season_number: 1, name: "Season 1", episode_count: 3 },
        { season_number: 2, name: "The Return", episode_count: 4 },
        { season_number: 1.5, name: "Invalid", episode_count: 1 },
        null,
      ],
    });
  if (request.url === "/tv/8/season/2")
    return reply(200, {
      season_number: 2,
      episodes: [
        { episode_number: 1, name: "Homecoming" },
        { episode_number: 2, name: 7 },
        { episode_number: 0, name: "Invalid" },
        { episode_number: 4, name: "  The Long Night  " },
      ],
    });
  if (request.url === "/tv/9") return reply(503, {});
  if (request.url === "/tv/10") return reply(200, { id: 10, seasons: "none" });
  reply(404, {});
});

before(async () => {
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "labels-test-token";
});
after(() => catalog.close());

async function show(id = 8) {
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,'tv',$2,'Test Show') ON CONFLICT DO NOTHING",
    [`tv:${id}`, id],
  );
}

test("TV comments take an optional season or episode label shown in every feed", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await show();
  const season = await createTitleComment(
    alice,
    "tv:8",
    "Season talk",
    true,
    2,
  );
  const episode = await createTitleComment(
    alice,
    "tv:8",
    "Episode talk",
    false,
    2,
    4,
  );
  const plain = await createTitleComment(alice, "tv:8", "Show talk", false);
  const unlabeled = await createTitleComment(
    alice,
    "tv:8",
    "Null label",
    false,
    null,
    null,
  );
  for (const path of ["/", "/titles/tv/8", "/people/alice"]) {
    const screen = await loadScreen(ben, path);
    assert.ok("conversations" in screen && screen.conversations);
    const label = (id: string) => {
      const item = screen.conversations.find((c) => c.id === id)!;
      return [item.season, item.episode];
    };
    assert.deepEqual(label(season), [2, null]);
    assert.deepEqual(label(episode), [2, 4]);
    assert.deepEqual(label(plain), [null, null]);
    assert.deepEqual(label(unlabeled), [null, null]);
  }
  // Deleting the starting text keeps the label for the remaining replies.
  await removeComment(alice, season);
  assert.deepEqual(
    await db
      .query(
        "SELECT season_number,episode_number FROM title_comment WHERE id=$1",
        [season],
      )
      .then((result) => result.rows),
    [{ season_number: 2, episode_number: null }],
  );

  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:8','movie',8,'Test Film') ON CONFLICT DO NOTHING",
  );
  await assert.rejects(
    createTitleComment(alice, "movie:8", "Movie season", false, 1),
    {
      status: 400,
      message: "Season and episode labels are only for TV shows.",
    },
  );
  await assert.rejects(
    createTitleComment(alice, "tv:8", "Episode alone", false, null, 3),
    { status: 400, message: "Choose a season for the episode." },
  );
  for (const invalid of [0, -1, 1.5, "2", 100_001, true])
    await assert.rejects(
      createTitleComment(alice, "tv:8", "Bad season", false, invalid),
      { status: 400, message: "Invalid season." },
    );
  for (const invalid of [0, -1, 2.5, "4", 100_001])
    await assert.rejects(
      createTitleComment(alice, "tv:8", "Bad episode", false, 1, invalid),
      { status: 400, message: "Invalid episode." },
    );

  // The title comment action passes the label through the API route.
  const response = await POST(
    new Request("http://localhost:3000/api/screenr/title-comment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Cookie: await cookieFor(alice),
      },
      body: JSON.stringify({
        title: "tv:8",
        body: "From the route",
        spoiler: false,
        season: 1,
        episode: 3,
      }),
    }),
    { params: Promise.resolve({ action: "title-comment" }) },
  );
  assert.equal(response.status, 200);
  const routed = (await thread(ben, (await response.json()).id)).conversation;
  assert.deepEqual([routed.season, routed.episode], [1, 3]);
});

test("season and episode pickers read TMDB's lists for TV titles", async () => {
  const { alice } = await setup();
  await show();
  assert.deepEqual(await titleSeasons("tv:8"), [
    { number: 1, name: "Season 1" },
    { number: 2, name: "The Return" },
  ]);
  assert.deepEqual(await seasonEpisodes("tv:8", 2), [
    { number: 1, name: "Homecoming" },
    { number: 2, name: "" },
    { number: 4, name: "The Long Night" },
  ]);
  await assert.rejects(titleSeasons("movie:8"), {
    status: 404,
    message: "Seasons are only for TV shows.",
  });
  await assert.rejects(seasonEpisodes("tv:8", 3), { status: 404 });
  for (const season of [0, -1, 1.5, Number.NaN])
    await assert.rejects(seasonEpisodes("tv:8", season), {
      status: 400,
      message: "Invalid season.",
    });
  await assert.rejects(titleSeasons("tv:9"), { status: 502 });
  await assert.rejects(titleSeasons("tv:10"), { status: 502 });

  const cookie = await cookieFor(alice);
  const get = (path: string, action: string) =>
    GET(
      new Request(`http://localhost:3000/api/screenr/${path}`, {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ action }) },
    );
  const seasons = await get("seasons?title=tv:8", "seasons");
  assert.equal(seasons.status, 200);
  assert.deepEqual(await seasons.json(), {
    seasons: [
      { number: 1, name: "Season 1" },
      { number: 2, name: "The Return" },
    ],
  });
  const episodes = await get("episodes?title=tv:8&season=2", "episodes");
  assert.equal(episodes.status, 200);
  assert.equal((await episodes.json()).episodes.length, 3);
  await assertRouteError(
    await get("episodes?title=tv:8&season=x", "episodes"),
    {
      status: 400,
      message: "Invalid season.",
    },
  );
  await assertRouteError(
    await GET(
      new Request("http://localhost:3000/api/screenr/seasons?title=tv:8"),
      { params: Promise.resolve({ action: "seasons" }) },
    ),
    { status: 401, message: "Sign in to continue." },
  );
});

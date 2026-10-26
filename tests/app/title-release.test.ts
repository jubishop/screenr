import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { useDatabase, db, person, friend } from "./social-fixture";
import type { TitleRelease } from "../../src/shared";
const { loadScreen } = await import("../../src/server/screens");
const { findTitles } = await import("../../src/server/title-viewing");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");
const { saveServices } = await import("../../src/server/streaming-services");
const { releaseCalendar, theatricalWindowDays } =
  await import("../../src/server/title-release");
useDatabase();

// Each test fixes the US date, so the window's edges never depend on when
// the suite runs.
let today: string;
mock.method(releaseCalendar, "today", () => today);

// TMDB release types: 1 premiere, 2 limited theatrical, 3 theatrical,
// 4 digital, 5 physical, 6 TV.
type Release = [type: number, date: string, note?: string];
const at = (date: string) => `${date}T00:00:00.000Z`;
function movie(
  id: number,
  us: Release[] | null,
  elsewhere: Record<string, Release[]> = {},
) {
  const country = (iso_3166_1: string, releases: Release[]) => ({
    iso_3166_1,
    release_dates: releases.map(([type, date, note = ""]) => ({
      certification: "",
      descriptors: [],
      iso_639_1: "",
      note,
      release_date: at(date),
      type,
    })),
  });
  return {
    id,
    title: `Movie ${id}`,
    overview: "A fictional movie.",
    release_date: "2026-01-01",
    release_dates: {
      results: [
        ...Object.entries(elsewhere).map(([iso, releases]) =>
          country(iso, releases),
        ),
        ...(us ? [country("US", us)] : []),
      ],
    },
  };
}
function show(
  id: number,
  details: {
    first_air_date?: string;
    networks?: { name: string; origin_country: string }[];
    seasons?: [number, string | null][];
    next?: [season: number, episode: number, date: string];
  },
) {
  return {
    id,
    name: `Show ${id}`,
    overview: "A fictional show.",
    first_air_date: details.first_air_date ?? "",
    networks: (details.networks ?? []).map((network, index) => ({
      id: index + 1,
      logo_path: null,
      ...network,
    })),
    seasons: (details.seasons ?? []).map(([season_number, air_date]) => ({
      season_number,
      air_date,
      name: `Season ${season_number}`,
      episode_count: 8,
    })),
    next_episode_to_air: details.next
      ? {
          season_number: details.next[0],
          episode_number: details.next[1],
          air_date: details.next[2],
        }
      : null,
  };
}
const netflix = { name: "Netflix", origin_country: "" };
const hbo = { name: "HBO", origin_country: "US" };

// The fake catalog answers details from `catalog`, by path, and search from
// `results`. A missing entry answers 404.
let catalog: Record<string, unknown>;
let results: unknown[];
let failing: boolean;
let slow: boolean;
let detailRequests: string[];
let active = 0,
  maximum = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://catalog");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname.startsWith("/search/")) {
    response.end(JSON.stringify({ results }));
    return;
  }
  if (url.pathname.endsWith("/watch/providers")) {
    response.end(
      JSON.stringify({
        id: Number(url.pathname.split("/")[2]),
        results: {
          US: {
            flatrate: [
              { provider_id: 8, provider_name: "Netflix", logo_path: null },
            ],
          },
        },
      }),
    );
    return;
  }
  if (url.pathname.endsWith("/videos")) {
    response.end(JSON.stringify({ results: [] }));
    return;
  }
  detailRequests.push(request.url!);
  active++;
  maximum = Math.max(maximum, active);
  response.on("close", () => active--);
  if (slow) return;
  const body = catalog[url.pathname];
  if (failing || !body) response.writeHead(failing ? 503 : 404).end("{}");
  else response.end(JSON.stringify(body));
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "release-test-token";
});
let viewer: string;
beforeEach(async () => {
  await db.query("TRUNCATE title CASCADE");
  today = "2026-10-25";
  catalog = {};
  results = [];
  failing = slow = false;
  detailRequests = [];
  active = maximum = 0;
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
const release = async (id: string) => (await titlePage(id)).release;
const none: TitleRelease = { status: "ok", in_theaters: false, upcoming: [] };
const inTheaters: TitleRelease = {
  status: "ok",
  in_theaters: true,
  upcoming: [],
};
const unavailable: TitleRelease = {
  status: "unavailable",
  in_theaters: false,
  upcoming: [],
};

test("a movie is in theaters from its latest US theatrical release through the window's last day", async () => {
  assert.equal(theatricalWindowDays, 45);
  catalog = {
    "/movie/501": movie(501, [[3, "2026-10-25"]]),
    // Limited releases count; 44 days before today is the window's last day.
    "/movie/502": movie(502, [[2, "2026-09-11"]]),
    "/movie/503": movie(503, [[3, "2026-09-10"]]),
    // A re-release is the latest theatrical release.
    "/movie/504": movie(504, [
      [3, "2019-07-26"],
      [4, "2019-11-25"],
      [3, "2026-10-02", "Re-release"],
    ]),
    "/movie/505": movie(505, [[3, "2026-10-26"]]),
  };
  assert.deepEqual(await release("movie:501"), inTheaters);
  assert.deepEqual(await release("movie:502"), inTheaters);
  assert.deepEqual(await release("movie:503"), none);
  assert.deepEqual(await release("movie:504"), inTheaters);
  assert.deepEqual(await release("movie:505"), {
    status: "ok",
    in_theaters: false,
    upcoming: [
      { kind: "theatrical", date: "2026-10-26", label: "In theaters Oct 26" },
    ],
  });
  // The status follows today's date without refetching the stored dates.
  const requests = detailRequests.length;
  today = "2026-10-26";
  assert.deepEqual(await release("movie:505"), inTheaters);
  assert.deepEqual(await release("movie:502"), none);
  today = "2026-12-09";
  assert.deepEqual(await release("movie:505"), inTheaters);
  today = "2026-12-10";
  assert.deepEqual(await release("movie:505"), none);
  assert.equal(detailRequests.length, requests);
});

test("upcoming US theatrical and digital dates are labeled, and digital dates are never Subs or Free", async () => {
  catalog = {
    "/movie/511": movie(511, [
      [1, "2026-11-01", "Premiere"],
      [2, "2026-11-21"],
      [3, "2026-12-05"],
      [4, "2026-12-09"],
      [5, "2026-11-30", "Blu-ray"],
      [6, "2026-11-28", "Broadcast"],
    ]),
    // A streaming original with only a digital release.
    "/movie/512": movie(512, [[4, "2026-11-14", "Netflix"]]),
    "/movie/513": movie(513, [
      [3, "2026-10-10"],
      [4, "2026-11-18"],
    ]),
    // Already out on digital: a later digital date, such as a streaming
    // service's arrival, is not a release.
    "/movie/514": movie(514, [
      [3, "2026-06-01"],
      [4, "2026-07-15"],
      [4, "2026-11-17", "Netflix"],
    ]),
    "/movie/515": movie(515, [[3, "2027-01-08"]]),
  };
  assert.deepEqual(await release("movie:511"), {
    status: "ok",
    in_theaters: false,
    upcoming: [
      { kind: "theatrical", date: "2026-11-21", label: "In theaters Nov 21" },
      { kind: "digital", date: "2026-12-09", label: "Digital Dec 9" },
    ],
  });
  const original = await titlePage("movie:512");
  assert.deepEqual(original.release, {
    status: "ok",
    in_theaters: false,
    upcoming: [
      { kind: "digital", date: "2026-11-14", label: "Digital Nov 14" },
    ],
  });
  // Where to watch keeps only its own Subs and Free offers.
  assert.deepEqual(
    original.availability.sections.map((section) => [
      section.label,
      section.services.map((service) => service.name),
    ]),
    [["Subs", ["Netflix"]]],
  );
  assert.deepEqual(await release("movie:513"), {
    status: "ok",
    in_theaters: true,
    upcoming: [
      { kind: "digital", date: "2026-11-18", label: "Digital Nov 18" },
    ],
  });
  assert.deepEqual(await release("movie:514"), none);
  assert.deepEqual((await release("movie:515")).upcoming, [
    {
      kind: "theatrical",
      date: "2027-01-08",
      label: "In theaters Jan 8, 2027",
    },
  ]);
});

test("past dates, missing US data, and other countries' dates show no label", async () => {
  catalog = {
    "/movie/521": movie(521, [
      [3, "2020-02-14"],
      [4, "2020-05-01"],
    ]),
    // Another country's theatrical run and digital date never stand in.
    "/movie/522": movie(522, null, {
      GB: [[3, "2026-10-20"]],
      CA: [[4, "2026-11-20"]],
    }),
    "/movie/523": movie(
      523,
      [
        [1, "2026-11-02"],
        [5, "2026-12-01"],
        [6, "2026-12-20"],
      ],
      { FR: [[3, "2026-11-04"]] },
    ),
    // A show on another country's network only.
    "/tv/524": show(524, {
      first_air_date: "2026-11-04",
      networks: [{ name: "BBC One", origin_country: "GB" }],
      seasons: [[1, "2026-11-04"]],
    }),
  };
  assert.deepEqual(await release("movie:521"), none);
  assert.deepEqual(await release("movie:522"), none);
  assert.deepEqual(await release("movie:523"), none);
  assert.deepEqual(await release("tv:524"), none);
});

test("shows give a premiere with its network and a next-season premiere, never weekly episode dates", async () => {
  catalog = {
    "/tv/531": show(531, {
      first_air_date: "2026-11-04",
      networks: [netflix],
      seasons: [[1, "2026-11-04"]],
      next: [1, 1, "2026-11-04"],
    }),
    // The first US or worldwide network names the premiere.
    "/tv/532": show(532, {
      first_air_date: "2026-12-25",
      networks: [{ name: "BBC One", origin_country: "GB" }, hbo],
    }),
    "/tv/533": show(533, {
      first_air_date: "2023-01-15",
      networks: [hbo],
      seasons: [
        [0, "2026-12-01"],
        [1, "2023-01-15"],
        [2, "2025-04-13"],
        [3, "2027-01-08"],
      ],
    }),
    // TMDB dates a new season through its first episode before the season.
    "/tv/534": show(534, {
      first_air_date: "2024-03-01",
      networks: [netflix],
      seasons: [
        [1, "2024-03-01"],
        [2, null],
      ],
      next: [2, 1, "2026-12-01"],
    }),
    // A season on the air: the next episode is weekly, not a premiere.
    "/tv/535": show(535, {
      first_air_date: "2026-10-13",
      networks: [netflix],
      seasons: [[1, "2026-10-13"]],
      next: [1, 5, "2026-10-27"],
    }),
    // A renewed show with no announced date.
    "/tv/536": show(536, {
      first_air_date: "2022-02-17",
      networks: [netflix],
      seasons: [
        [1, "2022-02-17"],
        [2, "2025-01-16"],
        [3, null],
      ],
    }),
    // An unreleased show with no date yet.
    "/tv/537": show(537, { networks: [netflix], seasons: [[1, null]] }),
  };
  assert.deepEqual(await release("tv:531"), {
    status: "ok",
    in_theaters: false,
    upcoming: [
      {
        kind: "premiere",
        date: "2026-11-04",
        label: "Premieres Nov 4 on Netflix",
      },
    ],
  });
  assert.deepEqual((await release("tv:532")).upcoming, [
    { kind: "premiere", date: "2026-12-25", label: "Premieres Dec 25 on HBO" },
  ]);
  assert.deepEqual((await release("tv:533")).upcoming, [
    {
      kind: "season_premiere",
      date: "2027-01-08",
      label: "Season 3 premieres Jan 8, 2027",
    },
  ]);
  assert.deepEqual((await release("tv:534")).upcoming, [
    {
      kind: "season_premiere",
      date: "2026-12-01",
      label: "Season 2 premieres Dec 1",
    },
  ]);
  assert.deepEqual(await release("tv:535"), none);
  assert.deepEqual(await release("tv:536"), none);
  assert.deepEqual(await release("tv:537"), none);
  // Once the show premieres, its premiere label ends.
  today = "2026-11-04";
  assert.deepEqual(await release("tv:531"), none);
});

test("release dates follow the title cache: reused for a day, then refreshed, and kept through a failed refresh", async () => {
  catalog = { "/movie/541": movie(541, [[3, "2026-11-06"]]) };
  const upcoming = (date: string, label: string) => ({
    status: "ok",
    in_theaters: false,
    upcoming: [{ kind: "theatrical", date, label }],
  });
  assert.deepEqual(
    await release("movie:541"),
    upcoming("2026-11-06", "In theaters Nov 6"),
  );
  assert.deepEqual(detailRequests, [
    "/movie/541?append_to_response=release_dates",
  ]);
  await release("movie:541");
  assert.equal(detailRequests.length, 1);

  await db.query("UPDATE title SET fetched_at=now()-interval '2 days'");
  failing = true;
  const stale = await titlePage("movie:541");
  assert.equal(stale.title.name, "Movie 541");
  assert.deepEqual(stale.release, upcoming("2026-11-06", "In theaters Nov 6"));
  assert.equal(detailRequests.length, 2);
  await release("movie:541");
  assert.equal(detailRequests.length, 2, "a failed refresh backs off");

  await db.query("UPDATE title SET retry_after=now()-interval '1 second'");
  failing = false;
  catalog["/movie/541"] = movie(541, [[3, "2026-11-13"]]);
  assert.deepEqual(
    await release("movie:541"),
    upcoming("2026-11-13", "In theaters Nov 13"),
  );
  assert.equal(detailRequests.length, 3);
});

test("details without usable release dates keep the title and its last dates, and retry after the failure delay", async () => {
  catalog = {
    "/movie/551": { ...movie(551, []), release_dates: "unavailable" },
    "/movie/552": movie(552, [[3, "2026-11-06"]]),
  };
  const cold = await titlePage("movie:551");
  assert.equal(cold.title.name, "Movie 551");
  assert.deepEqual(cold.release, unavailable);
  await release("movie:551");
  assert.equal(detailRequests.length, 1, "the next attempt waits");
  await db.query("UPDATE title SET retry_after=now()-interval '1 second'");
  catalog["/movie/551"] = movie(551, [[4, "2026-11-20"]]);
  assert.equal(
    (await release("movie:551")).upcoming[0].label,
    "Digital Nov 20",
  );

  await release("movie:552");
  await db.query(
    "UPDATE title SET fetched_at=now()-interval '2 days' WHERE id='movie:552'",
  );
  const { release_dates: _dropped, ...withoutDates } = movie(552, []);
  catalog["/movie/552"] = { ...withoutDates, title: "Renamed 552" };
  const page = await titlePage("movie:552");
  assert.equal(page.title.name, "Renamed 552");
  assert.equal(page.release.upcoming[0].label, "In theaters Nov 6");
  const requests = detailRequests.length;
  await release("movie:552");
  assert.equal(detailRequests.length, requests);
});

test("failed release data leaves title details, Where to watch, conversations, and every listed title", async () => {
  const other = await person("other");
  await friend(viewer, other);
  const entries: string[] = [];
  for (const id of [561, 562, 563]) {
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,fetched_at)
      VALUES($1,'movie',$2,$3,now()-interval '2 days')`,
      [`movie:${id}`, id, `Stored ${id}`],
    );
    for (const user of [viewer, other])
      entries.push(
        await updateTitleActivity(user, `movie:${id}`, "want_to_watch", true),
      );
  }
  await addComment(viewer, entries[1], "Worth seeing.", false);
  failing = true;
  const page = await titlePage("movie:561");
  assert.equal(page.title.name, "Stored 561");
  assert.deepEqual(page.release, unavailable);
  assert.equal(page.availability.sections[0].services[0].name, "Netflix");
  assert.ok(page.conversations.some((c) => c.comments.length === 1));

  const together = await loadScreen(viewer, "/watch-together?with=other");
  if (together.kind !== "watch-together")
    throw new Error("Expected Watch together");
  assert.deepEqual(
    together.titles.map((title) => [title.name, title.release.status]),
    [
      ["Stored 563", "unavailable"],
      ["Stored 562", "unavailable"],
      ["Stored 561", "unavailable"],
    ],
  );
  assert.ok(together.titles.every((title) => title.viewing.status === "ok"));

  results = [564, 565, 566].map((id) => ({
    id,
    media_type: "movie",
    title: `Searched ${id}`,
  }));
  const found = await findTitles("searched");
  assert.deepEqual(
    found.map((title) => [title.name, title.release.status]),
    [
      ["Searched 564", "unavailable"],
      ["Searched 565", "unavailable"],
      ["Searched 566", "unavailable"],
    ],
  );
});

test("title lists read stored release data in one query and refresh only missing or expired titles", async (t) => {
  const other = await person("other");
  await friend(viewer, other);
  const stored = (date: string) =>
    JSON.stringify({ theatrical: [date], digital: [] });
  // Fresh, expired, summary-only, and failed with backoff.
  const rows: [string, string | null, string][] = [
    ["movie:571", stored("2026-10-20"), "now()"],
    ["movie:572", stored("2026-11-20"), "now()-interval '2 days'"],
    ["tv:573", null, "'epoch'"],
    ["movie:574", null, "'epoch'"],
  ];
  for (const [id, release, fetched] of rows) {
    const [kind, tmdbId] = id.split(":");
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,release,fetched_at,retry_after)
      VALUES($1,$2,$3,$4,$5,${fetched},$6)`,
      [
        id,
        kind,
        tmdbId,
        `Listed ${tmdbId}`,
        release,
        id === "movie:574" ? new Date(Date.now() + 300_000) : null,
      ],
    );
    for (const user of [viewer, other])
      await updateTitleActivity(user, id, "want_to_watch", true);
  }
  catalog = {
    "/movie/571": movie(571, [[3, "2026-12-01"]]),
    "/movie/572": movie(572, [[3, "2026-11-27"]]),
    "/tv/573": show(573, { first_air_date: "2027-02-01", networks: [netflix] }),
    "/movie/574": movie(574, [[3, "2026-12-01"]]),
  };
  const query = t.mock.method(db, "query");
  const releaseReads = () =>
    query.mock.calls.filter((call) =>
      /FROM title WHERE id=ANY/.test(String(call.arguments[0])),
    ).length;
  const together = await loadScreen(viewer, "/watch-together?with=other");
  if (together.kind !== "watch-together")
    throw new Error("Expected Watch together");
  assert.equal(releaseReads(), 1);
  assert.deepEqual(detailRequests.sort(), [
    "/movie/572?append_to_response=release_dates",
    "/tv/573",
  ]);
  const labels = Object.fromEntries(
    together.titles.map((title) => [
      title.id,
      title.release.in_theaters
        ? "In theaters"
        : title.release.status === "ok"
          ? title.release.upcoming.map((date) => date.label).join(", ")
          : "unavailable",
    ]),
  );
  assert.deepEqual(labels, {
    "movie:571": "In theaters",
    "movie:572": "In theaters Nov 27",
    "tv:573": "Premieres Feb 1, 2027 on Netflix",
    "movie:574": "unavailable",
  });

  // The other lists reuse the refreshed rows.
  query.mock.resetCalls();
  detailRequests = [];
  const releases = Object.fromEntries(
    together.titles.map((title) => [title.id, title.release]),
  );
  await saveServices(viewer, ["service:netflix"]);
  const wanted = await loadScreen(viewer, "/people/other/want-to-watch");
  if (wanted.kind !== "want-to-watch")
    throw new Error("Expected Want to watch");
  assert.equal(releaseReads(), 1);
  assert.deepEqual(
    Object.fromEntries(wanted.titles.map((title) => [title.id, title.release])),
    releases,
  );
  query.mock.resetCalls();
  await db.query("DELETE FROM feed_item WHERE owner_id=$1", [viewer]);
  const search = await loadScreen(viewer, "/search");
  if (search.kind !== "search") throw new Error("Expected search");
  assert.equal(releaseReads(), 1);
  assert.deepEqual(detailRequests, []);
  assert.deepEqual(
    Object.fromEntries(
      search.suggestions.map((title) => [title.id, title.release]),
    ),
    releases,
  );
  // A list entry matches the title page.
  for (const title of together.titles)
    assert.deepEqual(await release(title.id), title.release, title.id);
});

test("Find a title bounds release requests and keeps its search deadline during a catalog outage", async () => {
  results = Array.from({ length: 12 }, (_, i) => ({
    id: 580 + i,
    media_type: "movie",
    title: `Outage ${i}`,
  }));
  slow = true;
  const start = Date.now();
  const found = await findTitles("outage");
  assert.equal(found.length, 12);
  assert.ok(found.every((title) => title.release.status === "unavailable"));
  assert.ok(found.every((title) => title.viewing.status === "ok"));
  assert.ok(maximum <= 4, `Observed ${maximum} concurrent detail requests`);
  assert.ok(
    detailRequests.length < results.length,
    "Must stop new detail requests when the list's refresh budget expires",
  );
  assert.ok(
    Date.now() - start < 6000,
    "An outage must not hold the list for every per-title timeout",
  );
});

test("Find a title results carry release status from full details, not the search summary", async () => {
  results = [
    {
      id: 591,
      media_type: "movie",
      title: "Summary 591",
      release_date: "2026-10-01",
    },
    {
      id: 592,
      media_type: "tv",
      name: "Summary 592",
      first_air_date: "2026-11-01",
    },
  ];
  catalog = {
    "/movie/591": movie(591, [[3, "2026-10-09"]]),
    "/tv/592": show(592, {
      first_air_date: "2026-11-04",
      networks: [netflix],
    }),
  };
  const found = await findTitles("summary");
  assert.deepEqual(
    found.map((title) => [title.name, title.release]),
    [
      ["Summary 591", inTheaters],
      [
        "Summary 592",
        {
          status: "ok",
          in_theaters: false,
          upcoming: [
            {
              kind: "premiere",
              date: "2026-11-04",
              label: "Premieres Nov 4 on Netflix",
            },
          ],
        },
      ],
    ],
  );
  await findTitles("summary");
  assert.equal(
    detailRequests.length,
    2,
    "Stored details serve the next search",
  );
});

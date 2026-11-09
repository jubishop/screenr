import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { db, captureFailures, assertNotLogged } from "./social-fixture";
import type { WatchProviders } from "../../src/server/watch-sources";

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
// What a title screen shows for options(): its one provider under both Subs
// and Free.
const harbor = [
  { label: "Subs", services: ["Harbor Stream"] },
  { label: "Free", services: ["Harbor Stream"] },
];
// TMDB's provider lists for a title, as the cache keeps them.
async function cachedProviders(id = "movie:42") {
  const { rows } = await db.query<{
    availability: { providers: WatchProviders };
  }>("SELECT availability FROM title_availability WHERE title_id=$1", [id]);
  return rows[0].availability.providers;
}
before(async () => {
  await migrate();
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "availability-test-token";
});
// The fields of the failure lines a test captured with captureFailures(t),
// without their stacks.
const failureLines = (printed: string[]) =>
  printed.map((line) => {
    const { stack, ...fields } = JSON.parse(line);
    return fields;
  });
const outage = { event: "catalog request failed", status: 503 };
const timedOut = {
  event: "catalog request failed",
  error: "DOMException",
  name: "TimeoutError",
};
const invalidProviders = {
  event: "catalog response invalid",
  lookup: "providers",
  error: "Error",
};
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
  await db.query(`INSERT INTO conversation(id,owner_id,title_id)
    VALUES('00000000-0000-4000-8000-000000000006','viewer','movie:42');
    INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
    VALUES('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000006','viewer','movie:42','recommended',true)`);
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
    assert.equal(availability.link, options(kind).results.US.link);
    assert.ok(availability.checked_at);
    assert.ok(Date.now() - Date.parse(availability.checked_at) < 10_000);
    assert.deepEqual(displayed(availability), harbor);
    assert.deepEqual(
      await cachedProviders(`${kind}:42`),
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

// Clients show only the sections, so TMDB's raw provider lists, rentals and
// purchases included, stay in the cache, and every result is for the US.
test("title screens send no provider lists or country", async () => {
  const availability = await screen();
  assert.equal(availability.status, "ok");
  assert.equal("providers" in availability, false);
  assert.equal("country" in availability, false);
});

test("movie and TV with the same TMDB number have independent availability", async () => {
  await screen();
  payload = { id: 42, results: {} };
  const tv = await screen("tv");
  assert.equal(tv.status, "ok");
  assert.deepEqual(tv.sections, []);
  assert.equal(requests.length, 2);
  assert.deepEqual(displayed(await screen()), harbor);
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
    assert.deepEqual(empty.sections, []);
    assert.ok(empty.checked_at);
    payload = options();
    assert.deepEqual(await screen(), empty);
    assert.equal(requests.length, 1);
    await db.query(
      "UPDATE title_availability SET refresh_after=now()-interval '1 second', fetched_at=now()-interval '25 hours'",
    );
    assert.deepEqual(displayed(await screen()), harbor);
    assert.equal(requests.length, 2);
  });
}

test("successful availability stays cached for 24 hours and then refreshes on demand", async () => {
  await screen();
  payload = { id: 42, results: {} };
  await db.query(
    "UPDATE title_availability SET fetched_at=fetched_at-interval '23 hours', refresh_after=refresh_after-interval '23 hours'",
  );
  assert.deepEqual(displayed(await screen()), harbor);
  assert.equal(requests.length, 1);
  await db.query(
    "UPDATE title_availability SET fetched_at=fetched_at-interval '2 hours', refresh_after=refresh_after-interval '2 hours'",
  );
  const refreshed = await screen();
  assert.equal(refreshed.status, "ok");
  assert.deepEqual(refreshed.sections, []);
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
  assert.deepEqual(refreshed.sections, []);
  assert.ok(Date.now() - Date.parse(refreshed.checked_at!) < 10_000);
});

// Only the failed refresh logs. An unconfigured catalog sends no request, so
// it logs nothing.
for (const [failure, logged] of [
  ["http", [outage]],
  ["timeout", [timedOut]],
  ["malformed", [invalidProviders]],
  ["configuration", []],
] as const) {
  test(`a ${failure} failure preserves the last success and backs off before recovering`, async (t) => {
    const printed = captureFailures(t);
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
      assert.deepEqual(stale.sections, initial.sections);
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
    assert.deepEqual(recovered.sections, []);
    assert.notEqual(recovered.checked_at, age);
    assert.deepEqual(failureLines(printed), logged);
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
  test(`malformed availability does not become a successful empty result and logs once: ${JSON.stringify(invalid)}`, async (t) => {
    const printed = captureFailures(t);
    payload = invalid;
    const unavailable = await screen();
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.checked_at, null);
    assert.equal(unavailable.link, null);
    assert.deepEqual(unavailable.sections, []);
    payload = options();
    assert.deepEqual(await screen(), unavailable);
    assert.equal(requests.length, 1);
    // The line names the lookup, never the answer's values.
    assert.equal(printed.length, 1, printed.join("\n"));
    const { stack, ...fields } = JSON.parse(printed[0]);
    assert.deepEqual(fields, invalidProviders);
    assert.ok(Array.isArray(stack) && stack.length > 0, printed[0]);
    for (const frame of stack) assert.match(frame, /^at /);
    assertNotLogged(printed, ["Harbor Stream", "harbor.jpg", "javascript"]);
  });
}

test("an initial HTTP failure can recover after the retry delay", async (t) => {
  const printed = captureFailures(t);
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
  assert.deepEqual(failureLines(printed), [outage]);
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
  assert.equal((await screen()).status, "ok");
  const cached = await cachedProviders();
  assert.equal(cached.rent?.[0].logo_path, null);
  assert.equal(cached.buy?.[0].logo_path, null);
});

// These assertions exercise the public title-screen response, with only TMDB
// replaced by an HTTP fixture. Raw offers remain available in the cache.
const offer = (
  id: number,
  name = `Reported ${id}`,
  logo: string | null = null,
) => ({
  provider_id: id,
  provider_name: name,
  logo_path: logo,
});
function reported(providers: Record<string, ReturnType<typeof offer>[]>) {
  payload = {
    id: 42,
    results: { US: { ...providers, link: options().results.US.link } },
  };
}
function displayed(result: Awaited<ReturnType<typeof screen>>) {
  return result.sections.map((section) => ({
    label: section.label,
    services: section.services.map(({ name }) => name),
  }));
}

for (const kind of ["movie", "tv"]) {
  test(`${kind} groups eligible offers into alphabetical Subs and Free services`, async () => {
    const providers = {
      flatrate: [
        offer(1796),
        offer(2243),
        offer(8),
        offer(350),
        offer(175),
        offer(43),
      ],
      free: [offer(235), offer(43), offer(235)],
      ads: [offer(192), offer(188), offer(43)],
      rent: [offer(15)],
      buy: [offer(9)],
    };
    reported(providers);
    // Keep the title-specific link valid for either title kind.
    if (kind === "tv")
      (payload as ReturnType<typeof options>).results.US.link =
        options(kind).results.US.link;
    const result = await screen(kind);
    assert.deepEqual(displayed(result), [
      {
        label: "Subs",
        services: ["Apple TV", "Netflix", "Starz"],
      },
      {
        label: "Free",
        services: ["Starz", "YouTube"],
      },
    ]);
    assert.deepEqual(await cachedProviders(`${kind}:42`), providers);
  });
}

test("reseller listings group under their service without a route note", async () => {
  reported({
    flatrate: [
      offer(2243),
      offer(635),
      offer(528),
      offer(1854),
      offer(528),
      offer(197),
      offer(199),
      offer(2406),
      offer(2056),
    ],
    free: [offer(350), offer(526), offer(1852)],
    ads: [offer(1852), offer(151)],
    rent: [offer(25), offer(417)],
    buy: [offer(350)],
  });
  const result = await screen();
  assert.deepEqual(displayed(result), [
    {
      label: "Subs",
      services: [
        "AMC+",
        "Apple TV",
        "BritBox",
        "Fandor",
        "Here TV",
        "IFC Films Unlimited",
      ],
    },
    {
      label: "Free",
      services: ["AMC+", "Apple TV", "BritBox"],
    },
  ]);
  // The canonical icon is metadata, not a reported standalone offer.
  assert.ok(
    result.sections[0].services.find((s) => s.name === "Apple TV")?.logo_path,
  );
  for (const section of result.sections)
    for (const service of section.services)
      assert.deepEqual(Object.keys(service), ["id", "name", "logo_path"]);
});

test("distinct products and unknown IDs retain independent identities and safe logos", async () => {
  reported({
    flatrate: [
      offer(2528),
      offer(192),
      offer(80),
      offer(526),
      offer(990001, "zebra", "/z.jpg"),
      offer(990002, "alpha", "https://bad.example/logo"),
      offer(990003, "ALPHA"),
      offer(990004, "Netflix", "/unknown.jpg"),
      offer(990005, "beta", "/beta.jpg"),
      offer(990005, "beta", "/beta.jpg"),
    ],
  });
  const result = await screen();
  assert.deepEqual(
    result.sections.map((s) => s.label),
    ["Subs"],
  );
  assert.deepEqual(
    result.sections[0].services.map((s) => s.name),
    [
      "alpha",
      "ALPHA",
      "AMC",
      "AMC+",
      "beta",
      "Netflix",
      "YouTube",
      "YouTube TV",
      "zebra",
    ],
  );
  assert.equal(result.sections[0].services[0].logo_path, null);
  assert.equal(result.sections[0].services[1].logo_path, null);
  assert.equal(result.sections[0].services.at(-1)?.logo_path, "/z.jpg");
  assert.equal(result.sections[0].services[5].logo_path, "/unknown.jpg");
});

test("reported logo fallback and unknown duplicate identity are deterministic across free and ads", async () => {
  // Cinemax has only reseller members in the US catalogs and no canonical logo.
  const providers = {
    free: [
      offer(289, "Cinemax Amazon Channel", "/amazon.jpg"),
      offer(990001, "Unknown", "/z.jpg"),
    ],
    ads: [
      offer(2061, "Cinemax Apple TV channel", "/apple.jpg"),
      offer(990001, "Unknown", "/a.jpg"),
    ],
  };
  reported(providers);
  const first = await screen();
  assert.deepEqual(displayed(first), [
    {
      label: "Free",
      services: ["Cinemax", "Unknown"],
    },
  ]);
  assert.deepEqual(
    first.sections[0].services.map((s) => s.logo_path),
    ["/amazon.jpg", "/a.jpg"],
  );
  await db.query("DELETE FROM title_availability");
  reported({
    free: providers.ads.toReversed(),
    ads: providers.free.toReversed(),
  });
  assert.deepEqual((await screen()).sections, first.sections);
});

for (const stale of [false, true]) {
  test(`existing ${stale ? "stale" : "fresh"} five-category cache uses the same display rules without rewriting raw data`, async (t) => {
    const printed = captureFailures(t);
    const cached = {
      link: options().results.US.link,
      providers: {
        flatrate: [offer(2243)],
        free: [offer(350)],
        ads: [offer(2243)],
        rent: [offer(350)],
        buy: [offer(8)],
      },
    };
    const age = stale ? "2020-01-01T00:00:00.000Z" : new Date().toISOString();
    await db.query(
      `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
      VALUES('movie:42','US',$1,$2,now()+interval '5 minutes')`,
      [cached, age],
    );
    const result = await screen();
    assert.equal(result.status, stale ? "stale" : "ok");
    assert.equal(result.checked_at, age);
    assert.equal(requests.length, 0);
    assert.deepEqual(displayed(result), [
      { label: "Subs", services: ["Apple TV"] },
      { label: "Free", services: ["Apple TV"] },
    ]);
    status = 503;
    await db.query(
      "UPDATE title_availability SET refresh_after=now()-interval '1 second'",
    );
    assert.deepEqual((await screen()).sections, result.sections);
    const stored = (
      await db.query("SELECT availability,fetched_at FROM title_availability")
    ).rows[0];
    assert.deepEqual(stored.availability, cached);
    assert.equal(stored.fetched_at.toISOString(), age);
    assert.equal(requests.length, 1);
    assert.deepEqual(failureLines(printed), [outage]);
  });
}

test("rental and purchase only offers yield no display sections", async () => {
  reported({ rent: [offer(8)], buy: [offer(350)] });
  assert.deepEqual((await screen()).sections, []);
});

test("a repeated unknown provider keeps a usable logo regardless of input order", async () => {
  const offers = [
    offer(990001, "Unknown", "/good.jpg"),
    offer(990001, "Unknown", null),
  ];
  reported({ free: offers });
  const first = await screen();
  assert.equal(first.sections[0].services[0].logo_path, "/good.jpg");
  await db.query("DELETE FROM title_availability");
  reported({ free: offers.toReversed() });
  assert.deepEqual((await screen()).sections, first.sections);
});

test("the registry groups plans and smaller services beyond the initial examples", async () => {
  reported({
    flatrate: [
      offer(299),
      offer(1809),
      offer(457),
      offer(1866),
      offer(11),
      offer(201),
      offer(291),
      offer(427),
      offer(264),
      offer(2423),
      offer(554),
      offer(2326),
      offer(1957),
      offer(2704),
      offer(2042),
      offer(2071),
      offer(2545),
      offer(2554),
      offer(79),
      offer(2039),
    ],
  });
  assert.deepEqual(displayed(await screen()), [
    {
      label: "Subs",
      services: [
        "BBC Select",
        "BroadwayHD",
        "Carnegie Hall+",
        "Cineverse",
        "FOX One",
        "MHz Choice",
        "MUBI",
        "MyOutdoorTV",
        "NBC",
        "Sling TV",
        "ViX",
      ],
    },
  ]);
});

test("subscription plans including ad-supported brands keep the reported category", async () => {
  reported({
    flatrate: [
      ...[
        9, 613, 2100, 1899, 1825, 1853, 2616, 2303, 582, 633, 386, 387, 2553,
        34, 583, 636, 87, 196, 2034, 283, 1968, 99, 204, 2049,
      ].map((id) => offer(id)),
    ],
  });
  assert.deepEqual(displayed(await screen()), [
    {
      label: "Subs",
      services: [
        "Acorn TV",
        "Amazon Prime Video",
        "Crunchyroll",
        "HBO Max",
        "MGM+",
        "Paramount+",
        "Peacock",
        "Shudder",
      ],
    },
  ]);
});

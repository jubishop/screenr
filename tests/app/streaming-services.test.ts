import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, person, friend } from "./social-fixture";

const { createAuth } = await import("../../src/server/auth");
const { loadScreen } = await import("../../src/server/screens");
const { updateTitleActivity, changeRelationship } =
  await import("../../src/server/social");
const { POST, GET } = await import("../../src/app/api/screenr/[action]/route");
useDatabase();

async function cookieFor(userId: string) {
  const { email } = (
    await db.query('SELECT email FROM "user" WHERE id=$1', [userId])
  ).rows[0];
  let code = "";
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ otp }) => {
      code = otp;
    },
  });
  const post = (path: string, data: unknown) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(data),
      }),
    );
  assert.equal(
    (await post("email-otp/send-verification-otp", { email, type: "sign-in" }))
      .status,
    200,
  );
  const response = await post("sign-in/email-otp", { email, otp: code });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function save(
  cookie: string,
  serviceIds: unknown,
  extra = {},
  origin = "http://localhost:3000",
) {
  return POST(
    new Request("http://localhost:3000/api/screenr/streaming-services", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify({ serviceIds, ...extra }),
    }),
    { params: Promise.resolve({ action: "streaming-services" }) },
  );
}

async function account(user: string) {
  const screen = await loadScreen(user, "/account");
  assert.equal(screen.kind, "account");
  if (screen.kind !== "account") throw new Error("Expected account");
  return screen;
}

async function title(
  id: number,
  offers: Record<string, unknown>,
  kind = "movie",
) {
  const key = `${kind}:${id}`;
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [key, kind, id, `Streaming ${id}`],
  );
  await db.query(
    `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
    VALUES($1,'US',$2,now(),now()+interval '1 day')
    ON CONFLICT(title_id,country) DO UPDATE SET availability=excluded.availability,
      fetched_at=excluded.fetched_at,refresh_after=excluded.refresh_after`,
    [key, { link: null, providers: offers }],
  );
  return key;
}
const offer = (id: number, name: string) => ({
  provider_id: id,
  provider_name: name,
  logo_path: null,
});

test("members save grouped services through the authenticated API and reload or clear their choices", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  const cookie = await cookieFor(alice);
  assert.equal(
    (await save(cookie, ["service:netflix", "service:amc-plus"])).status,
    200,
  );
  assert.deepEqual((await account(alice)).serviceIds, [
    "service:amc-plus",
    "service:netflix",
  ]);
  assert.deepEqual((await account(ben)).serviceIds, []);
  const catalog = (await account(alice)).services;
  assert.equal(catalog.filter((s) => s.name === "Netflix").length, 1);
  assert.equal(catalog.filter((s) => s.name === "AMC+").length, 1);
  assert.equal(
    catalog.some((s) => /via Amazon|Netflix with ads/.test(s.name)),
    false,
  );
  assert.equal((await save(cookie, [])).status, 200);
  assert.deepEqual((await account(alice)).serviceIds, []);
});

test("Watch together identifies free shared titles without saved subscriptions", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  await friend(alice, ben);
  const free = await title(9301, { ads: [offer(73, "Tubi TV")] });
  const paid = await title(9302, { flatrate: [offer(8, "Netflix")] }, "tv");
  for (const user of [alice, ben])
    for (const id of [free, paid])
      await updateTitleActivity(user, id, "want_to_watch", true);
  const screen = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(screen.kind, "watch-together");
  if (screen.kind !== "watch-together")
    throw new Error("Expected Watch together");
  assert.equal(screen.titles.find((t) => t.id === free)?.access, "available");
  assert.equal(screen.titles.find((t) => t.id === paid)?.access, "unmatched");
  assert.equal(screen.titles.length, 2);
});

test("invalid, cross-origin, and signed-out preference writes preserve both members' services", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  const cookie = await cookieFor(alice);
  assert.equal(
    (await save(cookie, ["service:netflix"], { userId: ben })).status,
    200,
  );
  assert.deepEqual((await account(alice)).serviceIds, ["service:netflix"]);
  assert.deepEqual((await account(ben)).serviceIds, []);
  for (const invalid of [
    null,
    "netflix",
    [8],
    ["service:unknown"],
    ["service:hulu", false],
    Array(300).fill("service:netflix"),
  ])
    assert.equal((await save(cookie, invalid)).status, 400);
  assert.equal(
    (await save(cookie, [], {}, "https://untrusted.example")).status,
    403,
  );
  assert.equal((await save("", [])).status, 401);
  const read = await GET(
    new Request("http://localhost:3000/api/screenr/screen?path=/account"),
    { params: Promise.resolve({ action: "screen" }) },
  );
  assert.equal(read.status, 401);
  assert.deepEqual((await account(alice)).serviceIds, ["service:netflix"]);
  assert.deepEqual((await account(ben)).serviceIds, []);
});

test("Watch together combines either member's services, preserves other picks, and conceals unrelated preferences", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  await friend(alice, ben);
  const aliceCookie = await cookieFor(alice),
    benCookie = await cookieFor(ben);
  assert.equal((await save(aliceCookie, ["service:netflix"])).status, 200);
  assert.equal(
    (await save(benCookie, ["service:amc-plus", "service:hulu"])).status,
    200,
  );
  const netflix = await title(9311, {
    flatrate: [offer(1796, "Netflix with ads")],
  });
  const channel = await title(
    9312,
    { flatrate: [offer(528, "AMC+ Amazon Channel")] },
    "tv",
  );
  const distinct = await title(9313, { flatrate: [offer(80, "AMC")] });
  const rental = await title(9314, {
    rent: [offer(8, "Netflix")],
    buy: [offer(528, "AMC+")],
  });
  const unknown = await title(9315, {});
  await db.query(
    "UPDATE title_availability SET availability=NULL,fetched_at=NULL WHERE title_id=$1",
    [unknown],
  );
  const stale = await title(9316, { free: [offer(73, "Tubi TV")] });
  await db.query(
    "UPDATE title_availability SET fetched_at=now()-interval '2 days' WHERE title_id=$1",
    [stale],
  );
  for (const user of [alice, ben])
    for (const id of [netflix, channel, distinct, rental, unknown, stale])
      await updateTitleActivity(user, id, "want_to_watch", true);
  const read = async () => {
    const screen = await loadScreen(alice, "/watch-together?with=ben");
    if (screen.kind !== "watch-together")
      throw new Error("Expected Watch together");
    return screen;
  };
  const screen = await read();
  assert.deepEqual(
    Object.fromEntries(screen.titles.map((t) => [t.id, t.access])),
    {
      [netflix]: "available",
      [channel]: "available",
      [distinct]: "unmatched",
      [rental]: "unmatched",
      [unknown]: "unknown",
      [stale]: "available",
    },
  );
  assert.deepEqual(
    screen.titles.find((t) => t.id === channel)?.matchingServiceIds,
    ["service:amc-plus"],
  );
  assert.equal(
    screen.titles.find((t) => t.id === channel)?.viewing.sections[0].services[0]
      .name,
    "AMC+",
  );
  assert.equal(
    screen.titles.find((t) => t.id === stale)?.viewing.status,
    "stale",
  );
  assert.equal(JSON.stringify(screen).includes("service:hulu"), false);
  assert.equal((await save(benCookie, [])).status, 200);
  assert.equal(
    (await read()).titles.find((t) => t.id === channel)?.access,
    "unmatched",
  );
  await changeRelationship(alice, ben, "block");
  await assert.rejects(read, /not found/i);
});

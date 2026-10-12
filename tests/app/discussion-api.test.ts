import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, cookieFor, denied, assertRouteError } from "./social-fixture";

const { migrate } = await import("../../scripts/migrate");
const { POST, GET } = await import("../../src/app/api/screenr/[action]/route");
const { createInvitation, invitationHash, completeSignup } =
  await import("../../src/server/invitations");
const { changeRelationship } = await import("../../src/server/relationships");
const { thread } = await import("../../src/server/feed");
const { updateTitleActivity } = await import("../../src/server/title-actions");

before(migrate);
beforeEach(async () => {
  await db.query(
    'TRUNCATE "user", verification, title RESTART IDENTITY CASCADE',
  );
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Discussion API fixture')",
  );
});
after(() => db.end());

async function member(username = "member") {
  const id = randomUUID();
  const email = `${id}@example.test`;
  const { token } = await createInvitation(null, 1);
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt","invitationHash")
     VALUES($1,'Member',$2,true,now(),now(),$3)`,
    [id, email, invitationHash(token)],
  );
  await completeSignup(id, "Member", username);
  return { id, cookie: await cookieFor(id) };
}
function post(
  action: string,
  cookie: string,
  data: unknown,
  origin = "http://localhost:3000",
) {
  return POST(
    new Request(`http://localhost:3000/api/screenr/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify(data),
    }),
    { params: Promise.resolve({ action }) },
  );
}

test("notification API enforces authentication, origin, ownership, read actions, and email preferences", async () => {
  const owner = await member("noticeowner");
  const actor = await member("noticeactor");
  const stranger = await member("noticestranger");
  await changeRelationship(actor.id, owner.id, "request");
  const get = (cookie: string, query = "") =>
    GET(
      new Request(`http://localhost:3000/api/screenr/notifications${query}`, {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ action: "notifications" }) },
    );
  await assertRouteError(await get(""), denied.signedOut);
  const listed = await get(owner.cookie);
  assert.equal(listed.status, 200);
  assert.match(listed.headers.get("Cache-Control")!, /no-store/);
  const page = await listed.json();
  assert.equal(page.items.length, 1);
  assert.equal((await get(owner.cookie, "?before=bad")).status, 400);
  assert.equal((await get(owner.cookie, "?through=bad")).status, 400);
  await assertRouteError(
    await post("read-notification", stranger.cookie, { id: page.items[0].id }),
    denied.notification,
  );
  await assertRouteError(
    await post(
      "read-notification",
      owner.cookie,
      { id: page.items[0].id },
      "https://outside.example",
    ),
    denied.origin,
  );
  const selected = await post("read-notification", owner.cookie, {
    id: page.items[0].id,
  });
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { href: "/people/noticeactor" });
  assert.equal(
    (await (await get(owner.cookie, "?unread=true")).json()).items.length,
    0,
  );
  assert.equal(
    (await post("read-notifications", owner.cookie, { through: page.through }))
      .status,
    200,
  );
  assert.equal(
    (await post("activity-email", owner.cookie, { enabled: "yes" })).status,
    400,
  );
  assert.equal(
    (await post("activity-email", owner.cookie, { enabled: true })).status,
    200,
  );
  assert.equal(
    (await post("activity-email", owner.cookie, { enabled: false })).status,
    200,
  );
});

test("reaction API rejects anonymous, cross-origin, and invalid requests without changing a saved reaction", async () => {
  const owner = await member("owner");
  const { id, cookie } = await member("reader");
  await changeRelationship(owner.id, id, "request");
  await changeRelationship(id, owner.id, "accept");
  const item = await updateTitleActivity(
    owner.id,
    "movie:1",
    "recommended",
    true,
  );
  const data = { item, kind: "like" };
  assert.equal((await post("reaction", cookie, data)).status, 200);
  await assertRouteError(await post("reaction", "", data), denied.signedOut);
  await assertRouteError(
    await post("reaction", cookie, data, "https://untrusted.example"),
    denied.origin,
  );
  assert.equal(
    (await post("reaction", cookie, { ...data, kind: "invalid" })).status,
    400,
  );
  assert.deepEqual((await thread(id, item)).conversation.reactions, [
    { kind: "like", count: 1, reacted: true },
  ]);
});

test("title-comment API rejects anonymous and cross-origin writes without creating entries", async () => {
  const { cookie } = await member();
  const data = { title: "movie:1", body: "A thought", spoiler: false };
  await assertRouteError(
    await post("title-comment", "", data),
    denied.signedOut,
  );
  await assertRouteError(
    await post("title-comment", cookie, data, "http://untrusted.example.test"),
    denied.origin,
  );
  assert.equal((await db.query("SELECT * FROM feed_item")).rowCount, 0);
  assert.equal((await post("title-comment", cookie, data)).status, 200);
});

test("title-comment API rejects empty text, nonboolean spoiler flags, and missing titles without creating entries", async () => {
  const { cookie } = await member();
  for (const [data, status] of [
    [{ title: "movie:1", body: " ", spoiler: false }, 400],
    [{ title: "movie:1", body: "Valid", spoiler: "false" }, 400],
    [{ body: "Titleless", spoiler: false }, 404],
  ] as const)
    assert.equal((await post("title-comment", cookie, data)).status, status);
  assert.equal((await db.query("SELECT * FROM feed_item")).rowCount, 0);
});

import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  assertRouteError,
  cookieFor,
  denied,
  friend,
  setup,
} from "./social-fixture";

const { GET } = await import("../../src/app/api/screenr/[action]/route");
const { initialScreen, loadScreen, readVersion, screenResponse } =
  await import("../../src/server/screens");
const { member, updateDisplayName } = await import("../../src/server/profiles");
const { addComment, removeComment } = await import("../../src/server/comments");
const { updateTopTen } = await import("../../src/server/title-actions");
const { notifications, readNotification } =
  await import("../../src/server/notifications");
const { setReaction } = await import("../../src/server/reactions");
const { changeRelationship } = await import("../../src/server/relationships");
const { saveServices, streamingServices } =
  await import("../../src/server/streaming-services");
const { createInvitation } = await import("../../src/server/invitations");

useDatabase();

function read(cookie: string, path: string, held?: string) {
  const headers = new Headers({ Cookie: cookie });
  if (held) headers.set("If-None-Match", held);
  return GET(
    new Request(
      `http://localhost:3000/api/screenr/screen?path=${encodeURIComponent(path)}`,
      { headers },
    ),
    { params: Promise.resolve({ action: "screen" }) },
  );
}

function assertPrivate(response: Response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Vary"), "Cookie, Authorization");
}

// A full screen, whose version is a weak ETag of its exact body.
async function changed(cookie: string, path: string, held?: string) {
  const response = await read(cookie, path, held);
  assert.equal(response.status, 200);
  assertPrivate(response);
  const body = await response.text();
  const version = response.headers.get("ETag");
  assert.match(version ?? "", /^W\/"[\w-]{43}"$/);
  assert.equal(version, readVersion(body));
  if (held) assert.notEqual(version, held);
  return { version: version!, data: JSON.parse(body) };
}

async function unchanged(
  cookie: string,
  path: string,
  version: string,
  held = version,
) {
  const response = await read(cookie, path, held);
  assert.equal(response.status, 304);
  assertPrivate(response);
  assert.equal(response.headers.get("ETag"), version);
  assert.equal(await response.text(), "");
}

test("unchanged screens of every kind answer 304 without a body, matching the version the page sends", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await createInvitation(alice, 2);
  const cookie = await cookieFor(alice);
  const user = await member(alice);
  for (const path of [
    "/",
    "/search",
    "/people",
    "/people/ben",
    "/people/alice",
    "/people/ben/want-to-watch",
    "/titles/movie/1",
    "/watch-together?with=ben",
    "/invites",
    "/account",
  ]) {
    const { version } = await changed(cookie, path);
    await unchanged(cookie, path, version);
    // Any listed version that matches counts, weak or strong.
    await unchanged(cookie, path, version, `W/"other", ${version.slice(2)}`);
    const screen = await initialScreen(alice, path);
    assert.ok(screen.data, path);
    assert.equal(
      readVersion(JSON.stringify(screenResponse(screen.data, user))),
      version,
      path,
    );
  }
});

test("each change the viewer can see answers with the full screen", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  const cookie = await cookieFor(ben);
  let { version } = await changed(cookie, "/");
  const next = async (path = "/") => {
    const result = await changed(cookie, path, version);
    version = result.version;
    await unchanged(cookie, path, version);
    return result.data;
  };
  await unchanged(cookie, "/", version);

  const reply = await addComment(alice, conversation, "A new reply", false);
  const replied = await next();
  assert.ok(
    replied.conversations[0].comments.some(
      (c: { id: string }) => c.id === reply,
    ),
  );
  await setReaction(alice, conversation, reply, "love");
  assert.equal((await next()).conversations[0].comments[0].reactions.length, 1);
  await changeRelationship(cam, ben, "request");
  assert.equal((await next()).unreadNotifications, 1);
  await updateDisplayName(ben, "Benjamin");
  assert.equal((await next()).user.display_name, "Benjamin");
  await changeRelationship(alice, ben, "remove");
  assert.deepEqual((await next()).conversations, []);

  // Saved services and the title's cached availability each reach the
  // screens that show them.
  ({ version } = await changed(cookie, "/search"));
  await saveServices(ben, [streamingServices[0].id]);
  assert.deepEqual((await next("/search")).serviceIds, [
    streamingServices[0].id,
  ]);
  ({ version } = await changed(cookie, "/titles/movie/1"));
  await db.query(
    `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
    VALUES('movie:1','US','{"link":"https://example.test/watch","providers":{}}',now(),now()+interval '1 day')
    ON CONFLICT(title_id,country) DO UPDATE SET availability=excluded.availability,
    fetched_at=excluded.fetched_at,refresh_after=excluded.refresh_after`,
  );
  assert.equal(
    (await next("/titles/movie/1")).availability.link,
    "https://example.test/watch",
  );
});

test("a version never answers for another member or an unreadable screen", async () => {
  const { alice, ben, outsider } = await setup();
  await friend(alice, ben);
  const aliceCookie = await cookieFor(alice);
  const benCookie = await cookieFor(ben);
  const path = "/titles/movie/1";
  // Friends see the same title page, but each body names its own reader.
  const { version } = await changed(aliceCookie, path);
  const { data } = await changed(benCookie, path, version);
  assert.equal(data.user.user_id, ben);
  await assertRouteError(await read("", path, version), denied.signedOut);
  const outsiderCookie = await cookieFor(outsider);
  await changeRelationship(alice, outsider, "block");
  const blocked = await read(outsiderCookie, "/people/alice", version);
  assert.equal(blocked.status, 404);
  assert.equal(blocked.headers.get("ETag"), null);
  const missing = await read(aliceCookie, "/nothing/here", version);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("ETag"), null);
});

test("an unchanged feed or profile poll answers without building the screen", async (t) => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "A reply", false);
  const cookie = await cookieFor(alice);
  const query = db.query.bind(db);
  for (const path of [
    "/",
    "/?before=now",
    "/people/ben",
    "/people/ben?before=now",
  ]) {
    const { version } = await changed(cookie, path);
    const queries: string[] = [];
    const spy = t.mock.method(db, "query", (...args: unknown[]) => {
      const [text] = args;
      queries.push(
        typeof text === "string"
          ? text
          : String((text as { text?: unknown } | null)?.text),
      );
      return (query as (...values: unknown[]) => unknown)(...args);
    });
    await unchanged(cookie, path, version);
    spy.mock.restore();
    assert.ok(queries.length, path);
    for (const text of queries)
      assert.doesNotMatch(
        text,
        /\b(feed_item|comment|visible_notification|top_ten)\b/,
        path,
      );
  }
});

// The relations a plan reads, views expanded to their tables.
function relations(plan: Record<string, unknown>, found = new Set<string>()) {
  if (typeof plan["Relation Name"] === "string")
    found.add(plan["Relation Name"]);
  for (const child of (plan.Plans as Record<string, unknown>[]) ?? [])
    relations(child, found);
  return found;
}

test("every table a feed or profile screen reads advances the change mark", async (t) => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "A reply", false);
  const read = new Set<string>();
  const query = db.query.bind(db) as (...values: unknown[]) => Promise<{
    rows: { "QUERY PLAN": [{ Plan: Record<string, unknown> }] }[];
  }>;
  t.mock.method(db, "query", async (...args: unknown[]) => {
    const [text, values] = args;
    if (typeof text === "string" && /^\s*(WITH|SELECT)\b/.test(text)) {
      const { rows } = await query(`EXPLAIN (FORMAT JSON) ${text}`, values);
      relations(rows[0]["QUERY PLAN"][0].Plan, read);
    }
    return query(...args);
  });
  // The route reads the reader's own profile beside each screen.
  await member(alice);
  for (const path of [
    "/",
    "/?before=now",
    "/people/ben",
    "/people/ben?before=now",
  ])
    await loadScreen(alice, path);
  t.mock.restoreAll();
  // SQL functions that PostgreSQL does not inline read these: screenr_blocked
  // and screenr_photo.
  for (const table of ["block", "member_suspension", "profile_photo"])
    read.add(table);
  const { rows } = await db.query<{ table: string }>(
    `SELECT DISTINCT c.relname AS table FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE p.proname='screenr_screen_changed'`,
  );
  const changing = new Set(rows.map((row) => row.table));
  read.delete("screen_change");
  assert.ok(read.has("comment") && read.has("friendship"));
  for (const table of read) assert.ok(changing.has(table), table);
});

test("each change that a paged feed or profile shows reaches a reader holding its version", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(ben, cam);
  await friend(alice, cam);
  const reply = await addComment(cam, conversation, "Cam's reply", false);
  const cookie = await cookieFor(ben);
  for (const path of ["/?before=now", "/people/alice?before=now"]) {
    let { version } = await changed(cookie, path);
    const next = async () => {
      const result = await changed(cookie, path, version);
      version = result.version;
      await unchanged(cookie, path, version);
      return result.data.conversations.find(
        (c: { id: string }) => c.id === conversation,
      );
    };
    // A catalog refresh that changes nothing the screen shows keeps it.
    await db.query(
      "UPDATE title SET fetched_at=now(),vote_count=7 WHERE id='movie:1'",
    );
    await unchanged(cookie, path, version);
    // Titles outlast each test's members, so the name is new each time.
    const name = `${path} ${randomUUID()}`;
    await db.query("UPDATE title SET name=$1 WHERE id='movie:1'", [name]);
    assert.equal((await next()).title_name, name);
    await db.query(
      `INSERT INTO profile_photo(user_id,image,content_type,version,source)
      VALUES($1,'\\x01','image/jpeg',$2,'upload') ON CONFLICT (user_id) DO UPDATE
      SET version=excluded.version`,
      [
        alice,
        path === "/?before=now" ? "0123456789abcdef" : "fedcba9876543210",
      ],
    );
    assert.ok((await next()).photo);
    await updateTopTen(ben, "movie:1", "add");
    assert.equal((await next()).viewer_top_ten_rank, 1);
    await updateTopTen(ben, "movie:1", "remove");
    assert.equal((await next()).viewer_top_ten_rank, null);
    await changeRelationship(ben, cam, "block");
    assert.deepEqual((await next()).comments, []);
    await changeRelationship(ben, cam, "unblock");
    assert.equal((await next()).comments[0].id, reply);
    await removeComment(cam, reply);
    assert.deepEqual((await next()).comments, []);
    await db.query("UPDATE comment SET removed_at=NULL WHERE id::text=$1", [
      reply,
    ]);
    assert.equal((await next()).comments.length, 1);
  }
  // Notifications change every screen's unread count; the email worker's
  // own bookkeeping on them does not.
  let { version } = await changed(cookie, "/?before=now");
  await db.query(
    "UPDATE notification SET email_pending=false WHERE recipient_id=$1",
    [alice],
  );
  await unchanged(cookie, "/?before=now", version);
  await changeRelationship(cam, ben, "remove");
  await changeRelationship(cam, ben, "request");
  ({ version } = await changed(cookie, "/?before=now", version));
  const [{ id }] = (await notifications(ben)).items;
  await readNotification(ben, id);
  assert.equal(
    (await changed(cookie, "/?before=now", version)).data.unreadNotifications,
    0,
  );
});

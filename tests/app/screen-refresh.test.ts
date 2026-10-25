import { test } from "node:test";
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
const { initialScreen, readVersion, screenResponse } =
  await import("../../src/server/screens");
const { member, updateDisplayName } = await import("../../src/server/profiles");
const { addComment } = await import("../../src/server/comments");
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

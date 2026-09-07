import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const { db } = await import("../../src/server/db");
const { migrate } = await import("../../scripts/migrate");
const { createAuth } = await import("../../src/server/auth");
const { loadScreen } = await import("../../src/server/screens");
const {
  createInvitation,
  completeSignup,
  invitationHash,
  revokeInvitation,
  listInvitations,
  activeInvitation,
} = await import("../../src/server/invitations");
const {
  changeRelationship,
  updateTitleActivity,
  thread,
  addComment,
  createTitleComment,
  removeComment,
  conversations,
  profileFor,
} = await import("../../src/server/social");

before(migrate);
beforeEach(async () => {
  await db.query('TRUNCATE "user", verification RESTART IDENTITY CASCADE');
});
after(async () => {
  await db.end();
});

async function pending(name: string, token: string, verified = true) {
  const id = randomBytes(24).toString("base64url");
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt","invitationHash")
    VALUES($1,$2,$3,$4,now(),now(),$5)`,
    [id, name, `${name}@example.test`, verified, invitationHash(token)],
  );
  return id;
}
async function person(name: string) {
  const { token } = await createInvitation(null);
  const id = await pending(name, token);
  await completeSignup(id, name, name);
  return id;
}
async function accountScreen(userId: string) {
  const screen = await loadScreen(userId, "/account");
  assert.ok(screen.kind === "account");
  return screen;
}
async function friend(a: string, b: string) {
  await changeRelationship(a, b, "request");
  await changeRelationship(b, a, "accept");
}
async function setup() {
  const alice = await person("alice"),
    ben = await person("ben"),
    cam = await person("cam"),
    outsider = await person("outsider");
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Test Movie') ON CONFLICT DO NOTHING",
  );
  const conversation = await updateTitleActivity(
    alice,
    "movie:1",
    "recommended",
    true,
  );
  return { alice, ben, cam, outsider, conversation };
}

test("profiles list accepted friends for owners, friends, and nonfriends without exposing private activity or requests", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, cam);
  await friend(alice, ben);
  const incoming = await person("incoming");
  const outgoing = await person("outgoing");
  await changeRelationship(incoming, alice, "request");
  await changeRelationship(alice, outgoing, "request");

  for (const viewer of [alice, ben, outsider]) {
    const screen = await loadScreen(viewer, "/people/ALICE");
    assert.ok(screen.kind === "profile");
    assert.deepEqual(screen.profile.friends, [
      { user_id: ben, username: "ben", display_name: "ben" },
      { user_id: cam, username: "cam", display_name: "cam" },
    ]);
    assert.equal(screen.conversations.length, viewer === outsider ? 0 : 1);
  }
  const empty = await loadScreen(alice, "/people/outsider");
  assert.ok(empty.kind === "profile");
  assert.deepEqual(empty.profile.friends, []);
});

test("profile friends hide blocked people in both directions and reject blocked profiles", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await changeRelationship(outsider, ben, "block");
  await changeRelationship(cam, outsider, "block");
  const filtered = await loadScreen(outsider, "/people/alice");
  assert.ok(filtered.kind === "profile");
  assert.deepEqual(filtered.profile.friends, []);
  const owner = await loadScreen(alice, "/people/alice");
  assert.ok(owner.kind === "profile");
  assert.equal(owner.profile.friends.length, 2);
  await changeRelationship(outsider, alice, "block");
  await assert.rejects(loadScreen(outsider, "/people/alice"), /not found/i);
  await assert.rejects(loadScreen(alice, "/people/outsider"), /not found/i);
});

test("profile friends follow acceptance, removal, and blocking on each read", async () => {
  const { alice, ben, outsider } = await setup();
  const friends = async () => {
    const screen = await loadScreen(outsider, "/people/alice");
    assert.ok(screen.kind === "profile");
    return screen.profile.friends.map((p) => p.username);
  };
  await changeRelationship(alice, ben, "request");
  assert.deepEqual(await friends(), []);
  await changeRelationship(ben, alice, "accept");
  assert.deepEqual(await friends(), ["ben"]);
  await changeRelationship(ben, alice, "remove");
  assert.deepEqual(await friends(), []);
  await friend(alice, ben);
  assert.deepEqual(await friends(), ["ben"]);
  await changeRelationship(alice, ben, "block");
  assert.deepEqual(await friends(), []);
});

test("watch together lists every current shared choice, newest shared first", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('tv:1','tv',1,'Shared Show'),
    ('movie:2','movie',2,'Only Alice'),
    ('movie:3','movie',3,'Only Ben'),
    ('movie:4','movie',4,'Recommended Only'),
    ('movie:5','movie',5,'Removed Choice') ON CONFLICT DO NOTHING`);
  for (const user of [alice, ben]) {
    for (const title of ["movie:1", "tv:1", "movie:5"])
      await updateTitleActivity(user, title, "want_to_watch", true);
    await updateTitleActivity(user, "movie:4", "recommended", true);
  }
  await updateTitleActivity(alice, "movie:2", "want_to_watch", true);
  await updateTitleActivity(cam, "movie:2", "want_to_watch", true);
  await updateTitleActivity(ben, "movie:3", "want_to_watch", true);
  const removed = await updateTitleActivity(
    ben,
    "movie:5",
    "want_to_watch",
    true,
  );
  await addComment(alice, removed, "Keep this conversation visible.", false);
  await updateTitleActivity(ben, "movie:5", "want_to_watch", false);
  await db.query(
    `UPDATE feed_item SET activity_at=CASE
    WHEN title_id='movie:1' AND owner_id=$1 THEN '2026-01-04'::timestamptz
    WHEN title_id='tv:1' THEN '2026-01-03'::timestamptz
    ELSE '2026-01-01'::timestamptz END`,
    [ben],
  );
  // Replies and recommendations must not reorder the shared choices.
  const show = await updateTitleActivity(ben, "tv:1", "want_to_watch", true);
  await addComment(alice, show, "New conversation on an older match.", false);
  await updateTitleActivity(ben, "tv:1", "recommended", true);

  const screen = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(screen.kind, "watch-together");
  if (screen.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    screen.participants.map((p) => p.username),
    ["alice", "ben"],
  );
  assert.deepEqual(
    screen.titles.map((t) => t.id),
    ["movie:1", "tv:1"],
  );
  const reverse = await loadScreen(ben, "/watch-together?with=alice");
  assert.equal(reverse.kind, "watch-together");
  if (reverse.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(reverse.titles, screen.titles);

  await updateTitleActivity(alice, "tv:1", "want_to_watch", false);
  const afterRemoval = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(afterRemoval.kind, "watch-together");
  if (afterRemoval.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    afterRemoval.titles.map((t) => t.id),
    ["movie:1"],
  );
  await updateTitleActivity(alice, "tv:1", "want_to_watch", true);
  const afterReturn = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(afterReturn.kind, "watch-together");
  if (afterReturn.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    afterReturn.titles.map((t) => t.id),
    ["tv:1", "movie:1"],
  );
});

test("watch together requires one current accepted friend and revokes access after unfriend or block", async () => {
  const { alice, ben, cam } = await setup();
  const path = "/watch-together?with=ben";
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await changeRelationship(alice, ben, "request");
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await changeRelationship(ben, alice, "accept");
  const empty = await loadScreen(alice, path);
  assert.equal(empty.kind, "watch-together");
  if (empty.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(empty.titles, []);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  for (const invalid of [
    "/watch-together",
    "/watch-together?with=",
    "/watch-together?with=alice",
    "/watch-together?with=missing",
    "/watch-together?with=ben&with=cam",
    "/watch-together?with=ben&with=ben",
  ])
    await assert.rejects(loadScreen(alice, invalid));
  await friend(alice, cam);
  await assert.rejects(loadScreen(cam, path), /not found/i);
  await changeRelationship(ben, alice, "remove");
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await friend(alice, ben);
  const restored = await loadScreen(alice, path);
  assert.equal(restored.kind, "watch-together");
  if (restored.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    restored.titles.map((t) => t.id),
    ["movie:1"],
  );
  await changeRelationship(ben, alice, "block");
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await assert.rejects(
    loadScreen(ben, "/watch-together?with=alice"),
    /not found/i,
  );
});

test("watch together returns all shared titles without a feed-sized cutoff", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name)
    SELECT 'movie:' || n, 'movie', n, 'Shared ' || n FROM generate_series(100,159) n
    ON CONFLICT DO NOTHING`);
  for (let n = 100; n < 160; n++)
    for (const user of [alice, ben])
      await updateTitleActivity(user, `movie:${n}`, "want_to_watch", true);
  const screen = await loadScreen(alice, "/watch-together?with=BEN");
  assert.equal(screen.kind, "watch-together");
  if (screen.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.equal(screen.titles.length, 60);
  assert.equal(new Set(screen.titles.map((t) => t.id)).size, 60);
});

test("concurrent completed signups cannot exceed invitation capacity", async () => {
  const { token, id } = await createInvitation(null, 1);
  const a = await pending("alice", token),
    b = await pending("ben", token);
  const results = await Promise.allSettled([
    completeSignup(a, "Alice", "alice"),
    completeSignup(b, "Ben", "ben"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM profile")).rows[0].n,
    1,
  );
});
test("profile failure rolls back invitation use; repeated completion consumes no extra use", async () => {
  await person("alice");
  const { token, id } = await createInvitation(null, 2);
  const b = await pending("ben", token);
  await assert.rejects(completeSignup(b, "Ben", "alice"), /taken/);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    0,
  );
  await completeSignup(b, "Ben", "ben");
  await completeSignup(b, "Ben", "ben");
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    1,
  );
});
test("invitation lifetime, revocation, ownership, limits, and email verification are enforced", async () => {
  const owner = await person("owner"),
    other = await person("other");
  for (const limit of [0, 13, 1.5, "2"])
    await assert.rejects(createInvitation(owner, limit));
  const { token, id } = await createInvitation(owner);
  const a = await pending("alice", token, false);
  await assert.rejects(completeSignup(a, "Alice", "alice"), /Verify/);
  await db.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [a]);
  await assert.rejects(revokeInvitation(other, id), /not found/);
  const span = (
    await db.query(
      "SELECT extract(epoch FROM expires_at-created_at)::int AS seconds FROM invitation WHERE id=$1",
      [id],
    )
  ).rows[0].seconds;
  assert.equal(span, 30 * 86400);
  await db.query(
    "UPDATE invitation SET expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await assert.rejects(completeSignup(a, "Alice", "alice"), /no longer/);
  await db.query(
    "UPDATE invitation SET expires_at=now()+interval '1 day' WHERE id=$1",
    [id],
  );
  await revokeInvitation(owner, id);
  await assert.rejects(completeSignup(a, "Alice", "alice"), /no longer/);
});
test("joining does not create friendship; invitation creator sees signups subject to blocking", async () => {
  const owner = await person("owner");
  const { token } = await createInvitation(owner, 2);
  const a = await pending("alice", token);
  await completeSignup(a, "Alice", "alice");
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM friendship")).rows[0].n,
    0,
  );
  assert.equal((await listInvitations(owner))[0].joined[0].username, "alice");
  await changeRelationship(a, owner, "block");
  assert.deepEqual((await listInvitations(owner))[0].joined, []);
  assert.equal((await listInvitations(owner))[0].uses, 1);
});
test("active invitations expose stable working links only to their creator", async () => {
  const owner = await person("owner"),
    other = await person("other");
  const invitation = await createInvitation(owner, 2);
  const first = (await listInvitations(owner))[0];
  assert.equal(first.url, `http://localhost:3000/join/${invitation.token}`);
  assert.equal((await listInvitations(owner))[0].url, first.url);
  assert.deepEqual(await listInvitations(other), []);
  assert.deepEqual(await activeInvitation(invitationHash(invitation.token)), {
    id: invitation.id,
  });
  const member = await pending("newmember", invitation.token);
  await completeSignup(member, "New member", "newmember", invitation.token);
  const remaining = (await listInvitations(owner))[0];
  assert.equal(remaining.url, first.url);
  assert.equal(remaining.uses, 1);
  assert.equal(remaining.max_uses, 2);
  assert.equal(remaining.joined[0].username, "newmember");
});
test("old invitations gain a working share link without breaking the original or resetting capacity", async () => {
  const owner = await person("owner");
  const original = randomBytes(32).toString("base64url"),
    id = randomUUID();
  // Model a pre-upgrade row: only the original one-way hash exists.
  await db.query(
    "INSERT INTO invitation(id,token_hash,creator_id,max_uses) VALUES($1,$2,$3,2)",
    [id, invitationHash(original), owner],
  );
  const listed = (await listInvitations(owner))[0];
  assert.equal(typeof listed.url, "string");
  const shared = new URL(listed.url).pathname.split("/").at(-1)!;
  assert.match(shared, /^[a-zA-Z0-9_-]{43}$/);
  assert.notEqual(shared, original);
  assert.equal((await listInvitations(owner))[0].url, listed.url);
  for (const token of [original, shared])
    assert.deepEqual(await activeInvitation(invitationHash(token)), { id });
  const first = await pending("originalguest", original);
  await completeSignup(first, "Original guest", "originalguest");
  assert.equal((await listInvitations(owner))[0].uses, 1);
  const second = await pending("sharedguest", shared);
  await completeSignup(second, "Shared guest", "sharedguest", shared);
  assert.deepEqual(await listInvitations(owner), []);
  for (const token of [original, shared])
    assert.equal(await activeInvitation(invitationHash(token)), undefined);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    2,
  );
});
test("revoked, expired, and exhausted invitations disappear while their records remain", async () => {
  const owner = await person("owner");
  const active = await createInvitation(owner);
  const revoked = await createInvitation(owner);
  const expired = await createInvitation(owner);
  const exhausted = await createInvitation(owner);
  await revokeInvitation(owner, revoked.id);
  await db.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
    expired.id,
  ]);
  const guest = await pending("guest", exhausted.token);
  await completeSignup(guest, "Guest", "guest");
  assert.deepEqual(
    (await listInvitations(owner)).map((item) => item.id),
    [active.id],
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM invitation WHERE creator_id=$1",
        [owner],
      )
    ).rows[0].n,
    4,
  );
});
for (const condition of ["revoked", "expired"]) {
  test(`both URLs of an old ${condition} invitation reject new signups`, async () => {
    const owner = await person("owner");
    const original = randomBytes(32).toString("base64url"),
      id = randomUUID();
    await db.query(
      "INSERT INTO invitation(id,token_hash,creator_id,max_uses) VALUES($1,$2,$3,2)",
      [id, invitationHash(original), owner],
    );
    const listed = (await listInvitations(owner))[0];
    assert.equal(typeof listed.url, "string");
    const shared = new URL(listed.url).pathname.split("/").at(-1)!;
    const guest = await pending("guest", shared);
    if (condition === "revoked") await revokeInvitation(owner, id);
    else
      await db.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
        id,
      ]);
    assert.deepEqual(await listInvitations(owner), []);
    for (const token of [original, shared]) {
      assert.equal(await activeInvitation(invitationHash(token)), undefined);
      await assert.rejects(
        completeSignup(guest, "Guest", "guest", token),
        /no longer/,
      );
    }
  });
}
test("standalone comments persist for movies and TV without changing structured activity", async () => {
  const { alice, ben, conversation: recommendation } = await setup();
  await friend(alice, ben);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('tv:8','tv',8,'Test Show') ON CONFLICT DO NOTHING",
  );
  const saved = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  const before = await conversations(alice);
  const state = (
    await db.query(
      "SELECT * FROM conversation WHERE owner_id=$1 ORDER BY title_id",
      [alice],
    )
  ).rows;
  const first = await createTitleComment(
    alice,
    "movie:1",
    "  First thought  ",
    false,
  );
  const second = await createTitleComment(
    alice,
    "movie:1",
    "Another thought",
    true,
  );
  const tv = await createTitleComment(
    alice,
    "tv:8",
    "A thought without any title action",
    false,
  );
  assert.notEqual(first, second);
  assert.deepEqual(
    (
      await db.query(
        "SELECT * FROM conversation WHERE owner_id=$1 AND title_id='movie:1'",
        [alice],
      )
    ).rows,
    state,
  );
  for (const item of before)
    assert.deepEqual(
      (await thread(alice, item.id)).conversation,
      (({ comments, ...c }) => c)(item),
    );
  assert.equal((await thread(alice, first)).conversation.body, "First thought");
  assert.equal((await thread(alice, second)).conversation.spoiler, true);
  assert.equal((await thread(alice, tv)).conversation.item_type, "comment");
  assert.equal((await thread(alice, tv)).conversation.recommended, false);
  assert.equal((await thread(alice, tv)).conversation.want_to_watch, false);
  const reply = await addComment(ben, first, "Only on the first", false);
  for (const id of [second, tv, recommendation, saved])
    assert.deepEqual((await thread(alice, id)).comments, []);
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const screen = await loadScreen(ben, path);
    assert.ok("conversations" in screen && screen.conversations);
    const item = screen.conversations.find((c) => c.id === first)!;
    assert.equal(item.body, "First thought");
    assert.deepEqual(
      item.comments.map((c) => c.id),
      [reply],
    );
    assert.equal(screen.conversations.filter((c) => c.id === first).length, 1);
  }
  const profile = await loadScreen(ben, "/people/ben");
  assert.ok(profile.kind === "profile");
  assert.deepEqual(profile.conversations, []);
  for (const body of ["", " ", null, 8, "x".repeat(2001)])
    await assert.rejects(
      createTitleComment(alice, "movie:1", body, false),
      /Comment must/,
    );
  await assert.rejects(
    createTitleComment(alice, "movie:1", "Valid", "false"),
    /spoiler/,
  );
  await assert.rejects(
    createTitleComment(alice, "movie:999999", "Valid", false),
    /Title not found/,
  );
  assert.equal(
    (await conversations(alice)).filter((c) => c.item_type === "comment")
      .length,
    3,
  );
});

test("standalone discussions enforce current access, independent replies, removal, and visible ordering", async () => {
  const { alice, ben, cam, outsider } = await setup();
  const first = await createTitleComment(
    alice,
    "movie:1",
    "Independent discussion",
    true,
  );
  await changeRelationship(ben, alice, "request");
  for (const viewer of [ben, outsider]) {
    await assert.rejects(thread(viewer, first), /not found/);
    await assert.rejects(
      addComment(viewer, first, "No access", false),
      /not found/,
    );
    assert.deepEqual(await conversations(viewer), []);
  }
  await changeRelationship(alice, ben, "accept");
  await friend(alice, cam);
  await friend(ben, outsider);
  const second = await createTitleComment(
    alice,
    "movie:1",
    "Separate discussion",
    false,
  );
  const parent = await addComment(ben, first, "First reply", false);
  const child = await addComment(cam, first, "Reply to Ben", false, parent);
  const grandchild = await addComment(
    alice,
    first,
    "Reply to Cam",
    false,
    child,
  );
  const discussion = await thread(ben, first);
  assert.deepEqual(
    discussion.comments.map((c) => [c.id, c.root_id, c.addressed_username]),
    [
      [parent, null, null],
      [child, parent, "ben"],
      [grandchild, parent, "cam"],
    ],
  );
  assert.equal((await conversations(ben))[0].id, first);
  assert.deepEqual(await conversations(outsider), []);
  await assert.rejects(
    addComment(outsider, first, "No access through Ben", false),
    /not found/,
  );
  await assert.rejects(
    addComment(ben, second, "Wrong group", false, child),
    /not found/,
  );
  await assert.rejects(removeComment(ben, child), /not found/);
  await removeComment(alice, parent);
  assert.equal((await thread(ben, first)).comments[0].removed, true);
  assert.equal((await thread(ben, first)).comments.length, 3);
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, first), /not found/);
  await assert.rejects(addComment(ben, first, "Revoked", false), /not found/);
  assert.deepEqual(
    (await thread(cam, first)).comments.map((c) => c.id),
    [parent, child, grandchild],
  );
  await friend(alice, ben);
  assert.equal((await thread(ben, first)).comments.length, 3);
  await changeRelationship(ben, cam, "block");
  const beforeHiddenActivity = (await thread(ben, first)).conversation
    .visible_activity;
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 day' WHERE id::text=$1",
    [child],
  );
  assert.equal(
    new Date(
      (await thread(ben, first)).conversation.visible_activity,
    ).getTime(),
    new Date(beforeHiddenActivity).getTime(),
  );
  assert.deepEqual(
    (await thread(ben, first)).comments.map((c) => c.id),
    [parent, grandchild],
  );
  await assert.rejects(
    addComment(ben, first, "Hidden target", false, child),
    /not found/,
  );
  assert.equal((await thread(alice, first)).comments.length, 3);
  await changeRelationship(ben, alice, "block");
  await assert.rejects(thread(ben, first), /not found/);
  await assert.rejects(addComment(ben, first, "Blocked", false), /not found/);
});

test("pending and nonfriends cannot read or write a thread; accepted friends use the same thread", async () => {
  const { alice, ben, outsider, conversation } = await setup();
  await changeRelationship(ben, alice, "request");
  for (const viewer of [ben, outsider]) {
    await assert.rejects(thread(viewer, conversation), /not found/);
    await assert.rejects(
      addComment(viewer, conversation, "No access", false),
      /not found/,
    );
    assert.deepEqual(await conversations(viewer), []);
  }
  await assert.rejects(changeRelationship(ben, alice, "accept"), /not found/);
  await changeRelationship(alice, ben, "accept");
  const comment = await addComment(ben, conversation, "Looks great", true);
  assert.equal((await thread(alice, conversation)).comments[0].id, comment);
  assert.equal(
    (await conversations(ben, { title: "movie:1" }))[0].id,
    conversation,
  );
  assert.equal((await conversations(ben))[0].id, conversation);
  const same = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  assert.notEqual(same, conversation, "Each action needs its own discussion");
});
test("feed action states belong to the viewer across circle, title, and profile reads", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  await addComment(ben, conversation, "Keep this discussion", false);
  for (const recommended of [false, true, false]) {
    await updateTitleActivity(ben, "movie:1", "recommended", recommended);
    for (const wantToWatch of [false, true, false]) {
      await updateTitleActivity(ben, "movie:1", "want_to_watch", wantToWatch);
      for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
        const entries = (await conversations(ben, filter)).filter(
          (item) => item.owner_id === alice,
        );
        assert.equal(entries.length, 2);
        for (const item of entries) {
          assert.equal(item.viewer_recommended, recommended);
          assert.equal(item.viewer_want_to_watch, wantToWatch);
        }
      }
      assert.equal(
        (await thread(ben, conversation)).conversation.viewer_recommended,
        recommended,
      );
    }
  }
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  await updateTitleActivity(ben, "movie:1", "recommended", true);
  const withdrawn = (await thread(ben, conversation)).conversation;
  assert.equal(withdrawn.recommended, false);
  assert.equal(withdrawn.viewer_recommended, true);
});

test("action items persist independently, removal does not bump activity, and reactivation reuses replies", async () => {
  const { alice, ben, cam, conversation: recommendation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const saved = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  assert.notEqual(saved, recommendation);
  const reply = await addComment(
    ben,
    recommendation,
    "About the recommendation",
    false,
  );
  assert.equal((await thread(alice, saved)).comments.length, 0);
  const original = (await thread(ben, recommendation)).conversation.activity_at;
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  const removed = await thread(ben, recommendation);
  assert.equal(
    new Date(removed.conversation.activity_at).getTime(),
    new Date(original).getTime(),
  );
  assert.equal(removed.conversation.recommended, false);
  assert.equal(removed.comments[0].id, reply);
  assert.equal((await thread(ben, saved)).conversation.want_to_watch, true);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", false);
  assert.deepEqual(
    (await conversations(ben)).map((c) => c.id),
    [recommendation],
  );
  await changeRelationship(cam, ben, "block");
  assert.deepEqual(await conversations(cam), []);
  await assert.rejects(thread(cam, recommendation), /not found/);
  await assert.rejects(
    addComment(cam, recommendation, "Invisible item", false),
    /not found/,
  );
  assert.equal(
    await updateTitleActivity(alice, "movie:1", "recommended", true),
    recommendation,
  );
  const restored = await thread(ben, recommendation);
  assert.ok(new Date(restored.conversation.activity_at) > new Date(original));
  assert.equal(restored.comments[0].id, reply);
  const activation = restored.conversation.activity_at;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      updateTitleActivity(alice, "movie:1", "recommended", true),
    ),
  );
  assert.equal(
    new Date(
      (await thread(ben, recommendation)).conversation.activity_at,
    ).getTime(),
    new Date(activation).getTime(),
  );
  assert.equal((await conversations(ben)).length, 1);
});

test("all feeds share entries and order by only visible replies without promoting reply authors", async () => {
  const { alice, ben, cam, outsider, conversation: first } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, outsider);
  const second = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  const reply = await addComment(cam, first, "Mutual friend's reply", true);
  const ownCam = await updateTitleActivity(cam, "movie:1", "recommended", true);
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    const entries = await conversations(ben, filter);
    assert.deepEqual(
      entries.map((c) => c.id),
      [first, second],
    );
    assert.equal((await thread(ben, entries[0].id)).comments[0].id, reply);
    assert.ok(!entries.some((c) => c.id === ownCam));
  }
  await addComment(ben, first, "My reply does not expand access", false);
  assert.deepEqual(await conversations(outsider), []);
  await assert.rejects(
    addComment(outsider, first, "No access", false),
    /not found/,
  );
  await assert.rejects(
    addComment(ben, second, "Wrong item", false, reply),
    /not found/,
  );
  await changeRelationship(ben, cam, "block");
  await assert.rejects(
    addComment(ben, first, "Blocked target", false, reply),
    /not found/,
  );
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 day' WHERE id::text=$1",
    [reply],
  );
  const ordered = (await conversations(ben)).map((c) => [
    c.id,
    c.visible_activity,
  ]);
  await db.query(
    "UPDATE comment SET created_at=now()+interval '2 days' WHERE id::text=$1",
    [reply],
  );
  assert.deepEqual(
    (await conversations(ben)).map((c) => [c.id, c.visible_activity]),
    ordered,
  );
});

test("clearing activity hides empty items while preserving eligible discussions", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }])
    assert.deepEqual(await conversations(ben, filter), []);
  await assert.rejects(thread(alice, conversation), /not found/);
  const saved = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  assert.equal((await conversations(ben))[0].id, saved);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", false);
  await updateTitleActivity(alice, "movie:1", "recommended", true);
  const comment = await addComment(
    cam,
    conversation,
    "Keep this discussion",
    false,
  );
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  assert.equal((await conversations(ben))[0].id, conversation);
  await changeRelationship(ben, cam, "block");
  assert.deepEqual(await conversations(ben), []);
  assert.equal((await conversations(alice))[0].id, conversation);
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await conversations(ben))[0].id, conversation);
  await changeRelationship(alice, cam, "remove");
  assert.deepEqual(await conversations(ben), []);
  await friend(alice, cam);
  assert.equal((await conversations(ben))[0].id, conversation);
  await removeComment(alice, comment);
  assert.deepEqual(await conversations(ben), []);
  assert.equal(
    await updateTitleActivity(alice, "movie:1", "recommended", true),
    conversation,
  );
  assert.equal((await conversations(ben))[0].id, conversation);
});
test("unfriending revokes historical access, hides comments for remaining readers, and refriending restores them", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await addComment(ben, conversation, "Historical reply", false);
  assert.equal((await thread(cam, conversation)).comments.length, 1);
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, conversation));
  await assert.rejects(addComment(ben, conversation, "Forbidden", false));
  assert.equal((await thread(alice, conversation)).comments.length, 0);
  assert.equal((await thread(cam, conversation)).comments.length, 0);
  await friend(alice, ben);
  assert.equal(
    (await thread(cam, conversation)).comments[0].body,
    "Historical reply",
  );
});
test("blocking hides the pair on mutual threads, prevents requests, and excludes hidden activity from ordering", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await addComment(ben, conversation, "Ben comment", false);
  await addComment(cam, conversation, "Cam comment", false);
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 hour' WHERE author_id=$1",
    [cam],
  );
  const visible = (await conversations(ben, { title: "movie:1" }))[0]
    .visible_activity;
  await changeRelationship(ben, cam, "block");
  assert.deepEqual(
    (await thread(ben, conversation)).comments.map((c) => c.body),
    ["Ben comment"],
  );
  assert.deepEqual(
    (await thread(cam, conversation)).comments.map((c) => c.body),
    ["Cam comment"],
  );
  assert.equal((await thread(alice, conversation)).comments.length, 2);
  assert.ok(
    new Date(
      (await conversations(ben, { title: "movie:1" }))[0].visible_activity,
    ) < new Date(visible),
  );
  await assert.rejects(changeRelationship(cam, ben, "request"));
  await assert.rejects(profileFor(ben, "cam"));
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await thread(ben, conversation)).comments.length, 2);
});
test("standalone deletion erases only the author's starting text and preserves eligible replies in every feed", async () => {
  const { alice, ben, cam, outsider, conversation: action } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const id = await createTitleComment(
    alice,
    "movie:1",
    "Delete this spoiler",
    true,
  );
  const other = await createTitleComment(
    alice,
    "movie:1",
    "Keep this entry",
    false,
  );
  const parent = await addComment(ben, id, "Keep this reply", false);
  const child = await addComment(
    cam,
    id,
    "Keep this nested reply",
    true,
    parent,
  );
  const before = (await thread(alice, id)).conversation;
  for (const viewer of [ben, cam, outsider])
    await assert.rejects(removeComment(viewer, id), /not found/);
  await assert.rejects(removeComment(alice, action), /not found/);
  assert.equal(
    (await thread(alice, id)).conversation.body,
    "Delete this spoiler",
  );

  await removeComment(alice, id);
  await removeComment(alice, id);
  for (const viewer of [alice, ben, cam]) {
    for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
      const entries = await conversations(viewer, filter);
      const removed = entries.find((entry) => entry.id === id)!;
      assert.equal(removed.active, false);
      assert.equal(removed.body, "");
      assert.equal(removed.spoiler, true);
      assert.deepEqual(
        removed.comments.map((reply) => reply.id),
        [parent, child],
      );
      assert.equal(removed.comments[1].root_id, parent);
      assert.equal(removed.comments[1].addressed_username, "ben");
      assert.equal(removed.comments[0].body, "Keep this reply");
      assert.equal(removed.comments[1].body, "Keep this nested reply");
      assert.equal(
        new Date(removed.visible_activity).getTime(),
        new Date(before.visible_activity).getTime(),
      );
      assert.equal(
        entries.find((entry) => entry.id === other)?.body,
        "Keep this entry",
      );
      assert.equal(entries.find((entry) => entry.id === action)?.active, true);
    }
  }
  assert.equal(
    (await db.query("SELECT body FROM title_comment WHERE id::text=$1", [id]))
      .rows[0].body,
    "[removed]",
  );
  const linked = await loadScreen(
    ben,
    `/titles/movie/1?item=${id}&reply=${child}`,
  );
  assert.equal(linked.kind, "title");
  if (linked.kind !== "title") throw new Error("Expected title");
  assert.equal(linked.targetUnavailable, false);
  const continued = await addComment(
    ben,
    id,
    "Continue this discussion",
    false,
  );
  const nested = await addComment(
    cam,
    id,
    "Continue the reply group",
    false,
    parent,
  );
  const ongoing = await thread(alice, id);
  assert.ok(ongoing.comments.some((reply) => reply.id === continued));
  assert.equal(
    ongoing.comments.find((reply) => reply.id === nested)?.root_id,
    parent,
  );
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, id), /not found/);
  await assert.rejects(removeComment(ben, parent), /not found/);
  await friend(alice, ben);
  assert.equal((await thread(ben, id)).conversation.body, "");
  await changeRelationship(alice, ben, "block");
  await assert.rejects(thread(ben, id), /not found/);
});

test("deleted standalone entries disappear when no live reply is visible to the reader", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const empty = await createTitleComment(alice, "movie:1", "No replies", false);
  await removeComment(alice, empty);
  await removeComment(alice, empty);
  await assert.rejects(thread(alice, empty), /not found/);
  await assert.rejects(
    addComment(alice, empty, "Cannot revive an empty deleted entry", false),
    /not found/,
  );
  const linked = await loadScreen(alice, `/titles/movie/1?item=${empty}`);
  assert.equal(linked.kind, "title");
  if (linked.kind !== "title") throw new Error("Expected title");
  assert.equal(linked.targetUnavailable, true);

  const id = await createTitleComment(alice, "movie:1", "Starting text", false);
  const reply = await addComment(cam, id, "Only live reply", false);
  await removeComment(alice, id);
  await changeRelationship(ben, cam, "block");
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    assert.ok(
      !(await conversations(ben, filter)).some(
        (entry) => entry.id === empty || entry.id === id,
      ),
    );
    assert.ok(
      (await conversations(alice, filter)).some((entry) => entry.id === id),
    );
  }
  await assert.rejects(thread(ben, id), /not found/);
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await thread(ben, id)).conversation.body, "");
  await changeRelationship(alice, cam, "remove");
  await assert.rejects(thread(alice, id), /not found/);
  await friend(alice, cam);
  assert.equal((await thread(ben, id)).comments[0].id, reply);
  await removeComment(cam, reply);
  for (const viewer of [alice, ben, cam])
    await assert.rejects(thread(viewer, id), /not found/);
});

for (const kind of ["action", "standalone"] as const) {
  test(`comment authors can delete their own comments in a friend's ${kind} conversation and preserve replies`, async () => {
    const { alice, ben, cam, outsider, conversation: action } = await setup();
    const conversation =
      kind === "standalone"
        ? await createTitleComment(
            alice,
            "movie:1",
            "Standalone discussion",
            false,
          )
        : action;
    await friend(alice, ben);
    await friend(alice, cam);
    const parent = await addComment(ben, conversation, "My comment", true);
    const reply = await addComment(
      cam,
      conversation,
      "Keep this reply",
      false,
      parent,
    );
    for (const viewer of [cam, outsider])
      await assert.rejects(removeComment(viewer, parent), /not found/);
    assert.equal(
      (await thread(ben, conversation)).comments[0].body,
      "My comment",
    );

    await removeComment(ben, parent);
    await removeComment(ben, parent);
    for (const viewer of [alice, ben, cam]) {
      const comments = (await thread(viewer, conversation)).comments;
      assert.equal(comments[0].removed, true);
      assert.equal(comments[0].body, "");
      assert.equal(comments[1].id, reply);
      assert.equal(comments[1].root_id, parent);
      assert.equal(comments[1].addressed_username, "ben");
      assert.equal(comments[1].body, "Keep this reply");
    }
    assert.equal(
      (await db.query("SELECT body FROM comment WHERE id::text=$1", [parent]))
        .rows[0].body,
      "[removed]",
    );
    await removeComment(cam, reply);
    assert.deepEqual((await thread(alice, conversation)).comments, []);
    await assert.rejects(
      addComment(ben, conversation, "Reply to removed", false, parent),
      /not found/,
    );
  });

  test(`comment deletion rechecks current ${kind} conversation access`, async () => {
    const { alice, ben, conversation: action } = await setup();
    const conversation =
      kind === "standalone"
        ? await createTitleComment(
            alice,
            "movie:1",
            "Standalone discussion",
            false,
          )
        : action;
    await friend(alice, ben);
    const comment = await addComment(
      ben,
      conversation,
      "Existing comment",
      false,
    );
    await changeRelationship(alice, ben, "remove");
    await assert.rejects(removeComment(ben, comment), /not found/);
    await assert.rejects(removeComment(alice, comment), /not found/);
    await friend(alice, ben);
    await changeRelationship(alice, ben, "block");
    await assert.rejects(removeComment(ben, comment), /not found/);
    await changeRelationship(alice, ben, "unblock");
    await friend(alice, ben);
    assert.equal(
      (await thread(ben, conversation)).comments[0].body,
      "Existing comment",
    );
    await removeComment(ben, comment);
    const own = await addComment(
      alice,
      conversation,
      "Host's own comment",
      false,
    );
    await removeComment(alice, own);
    assert.deepEqual((await thread(alice, conversation)).comments, []);
  });
}

test("nested replies stay in one group; the host can remove others' comments and preserve replies", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(ben, conversation, "Original", true);
  const reply = await addComment(cam, conversation, "Reply", false, parent);
  await addComment(alice, conversation, "Reply to reply", false, reply);
  const before = await thread(alice, conversation);
  assert.deepEqual(
    before.comments.map((c) => c.root_id),
    [null, parent, parent],
  );
  assert.equal(before.comments[2].addressed_username, "cam");
  await assert.rejects(removeComment(cam, parent));
  await removeComment(alice, parent);
  const after = await thread(cam, conversation);
  assert.equal(after.comments[0].body, "");
  assert.equal(after.comments[0].removed, true);
  assert.equal(after.comments.length, 3);
});
test("nested groups retain only safe parent context through blocking, removal, and friendship changes", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(cam, conversation, "Private parent", true);
  const empty = await addComment(
    cam,
    conversation,
    "Empty hidden group",
    false,
  );
  const child = await addComment(
    ben,
    conversation,
    "Visible child",
    false,
    parent,
  );
  const removedChild = await addComment(
    alice,
    conversation,
    "Removed child",
    false,
    parent,
  );
  await removeComment(alice, removedChild);
  await changeRelationship(ben, cam, "block");
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    const comments = (await conversations(ben, filter))[0].comments;
    assert.deepEqual(
      comments.map((c) => c.id),
      [parent, child],
    );
    assert.deepEqual(comments[0], {
      id: parent,
      root_id: null,
      author_id: null,
      username: null,
      display_name: null,
      body: "",
      spoiler: false,
      addressed_username: null,
      removed: false,
      unavailable: true,
      created_at: comments[0].created_at,
    });
    assert.equal(comments[1].addressed_username, null);
  }
  await assert.rejects(
    addComment(ben, conversation, "No hidden targets", false, parent),
    /not found/,
  );
  await assert.rejects(
    addComment(ben, conversation, "No removed targets", false, removedChild),
    /not found/,
  );
  await assert.rejects(thread(outsider, conversation), /not found/);
  const sibling = await addComment(
    ben,
    conversation,
    "Reply to visible child",
    false,
    child,
  );
  assert.equal(
    (await thread(ben, conversation)).comments.at(-1)!.root_id,
    parent,
  );
  await changeRelationship(ben, cam, "unblock");
  assert.equal(
    (await thread(ben, conversation)).comments[0].body,
    "Private parent",
  );
  await changeRelationship(alice, cam, "remove");
  assert.equal((await thread(ben, conversation)).comments[0].unavailable, true);
  await friend(alice, cam);
  assert.equal(
    (await thread(ben, conversation)).comments[0].unavailable,
    false,
  );
  await removeComment(alice, parent);
  await removeComment(alice, empty);
  const after = (await thread(ben, conversation)).comments;
  assert.deepEqual(
    after.map((c) => c.id),
    [parent, child, sibling],
  );
  assert.equal(after[0].removed, true);
  assert.equal(after[0].body, "");
  await removeComment(alice, child);
  await removeComment(alice, sibling);
  assert.deepEqual((await thread(ben, conversation)).comments, []);
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, conversation), /not found/);
});

test("nested reply links reject unavailable parents and preserve stored groups on every feed", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await db.query(
    "INSERT INTO title_trailer(title_id,trailer,expires_at) VALUES('movie:1',NULL,now()+interval '1 day') ON CONFLICT(title_id) DO UPDATE SET expires_at=excluded.expires_at",
  );
  const parent = await addComment(cam, conversation, "Parent", false);
  const child = await addComment(
    alice,
    conversation,
    "Spoiler child",
    true,
    parent,
  );
  for (let i = 0; i < 5; i++)
    await addComment(alice, conversation, `Later ${i}`, false);
  await changeRelationship(ben, cam, "block");
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const screen = await loadScreen(ben, path);
    assert.ok("conversations" in screen && screen.conversations);
    assert.equal(screen.conversations[0].comments[0].id, parent);
    assert.equal(screen.conversations[0].comments[1].root_id, parent);
  }
  const hidden = await loadScreen(
    ben,
    `/titles/movie/1?item=${conversation}&reply=${parent}`,
  );
  assert.ok(hidden.kind === "title");
  assert.equal(hidden.targetUnavailable, true);
  assert.equal(hidden.target?.reply, undefined);
  const visible = await loadScreen(
    ben,
    `/titles/movie/1?item=${conversation}&reply=${child}`,
  );
  assert.ok(visible.kind === "title");
  assert.equal(visible.target?.reply, child);
  assert.equal(visible.conversations[0].comments[1].spoiler, true);
});
test("screen reads and legacy links preserve item identity and filter reply targets before navigation", async () => {
  const { alice, ben, cam, outsider, conversation: id } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await db.query(
    "INSERT INTO title_trailer(title_id,trailer,expires_at) VALUES('movie:1',NULL,now()+interval '1 day') ON CONFLICT(title_id) DO UPDATE SET expires_at=excluded.expires_at",
  );
  const replies: string[] = [];
  for (let index = 0; index < 5; index++)
    replies.push(await addComment(alice, id, `Eligible ${index}`, index === 0));
  const hidden = await addComment(cam, id, "Blocked reply", false, replies[0]);
  await changeRelationship(ben, cam, "block");
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const data = await loadScreen(ben, path);
    assert.ok("conversations" in data && data.conversations);
    assert.deepEqual(
      data.conversations.map((c) => c.id),
      [id],
    );
    assert.deepEqual(
      data.conversations[0].comments.map((c) => c.id),
      replies,
    );
    assert.deepEqual(
      data.conversations[0].comments.slice(-3).map((c) => c.body),
      ["Eligible 2", "Eligible 3", "Eligible 4"],
    );
  }
  const targeted = await loadScreen(
    ben,
    `/titles/movie/1?item=${id}&reply=${replies[0]}`,
  );
  assert.ok(targeted.kind === "title");
  assert.deepEqual(targeted.target, { item: id, reply: replies[0] });
  assert.equal(targeted.conversations[0].comments[0].spoiler, true);
  const blocked = await loadScreen(
    ben,
    `/titles/movie/1?item=${id}&reply=${hidden}`,
  );
  assert.ok(blocked.kind === "title");
  assert.equal(blocked.targetUnavailable, true);
  assert.equal(blocked.target?.reply, undefined);
  const outside = await loadScreen(
    outsider,
    `/titles/movie/1?item=${id}&reply=${replies[0]}`,
  );
  assert.ok(outside.kind === "title");
  assert.equal(outside.target, null);
  assert.equal(outside.targetUnavailable, true);
  assert.deepEqual(outside.conversations, []);
  const legacy = (
    await db.query("SELECT conversation_id FROM feed_item WHERE id=$1", [id])
  ).rows[0].conversation_id;
  assert.deepEqual(await loadScreen(ben, `/conversations/${legacy}`), {
    kind: "redirect",
    url: `/titles/movie/1?item=${id}`,
  });
  const oldReply = (
    await db.query(
      "INSERT INTO comment(conversation_id,author_id,body,spoiler) VALUES($1,$2,'An earlier discussion',true) RETURNING id::text",
      [legacy, alice],
    )
  ).rows[0].id;
  assert.deepEqual(
    await loadScreen(ben, `/conversations/${legacy}?reply=${oldReply}`),
    {
      kind: "redirect",
      url: `/titles/movie/1?item=${legacy}&reply=${oldReply}`,
    },
  );
  await assert.rejects(
    loadScreen(outsider, `/conversations/${legacy}`),
    /not found/,
  );
  await changeRelationship(alice, ben, "remove");
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const data = await loadScreen(ben, path);
    assert.ok("conversations" in data);
    assert.deepEqual(data.conversations, []);
  }
  await friend(alice, ben);
  assert.equal((await conversations(ben)).length, 2);
});

test("Better Auth requires an invite for a new email identity and preserves the account on later sign-ins", async () => {
  const codes = new Map<string, string>();
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ email, otp }) => {
      codes.set(email, otp);
    },
  });
  async function post(path: string, body: unknown, token?: string) {
    return auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          ...(token ? { Cookie: `screenr-invite=${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }
  async function code(token?: string) {
    assert.equal(
      (
        await post(
          "email-otp/send-verification-otp",
          {
            email: "auth@example.test",
            type: "sign-in",
          },
          token,
        )
      ).status,
      200,
    );
    return codes.get("auth@example.test");
  }
  await code();
  assert.equal(
    codes.size,
    0,
    "Uninvited addresses must not consume email delivery",
  );
  const { token, id } = await createInvitation(null);
  const first = await post("sign-in/email-otp", {
    email: "auth@example.test",
    otp: await code(token),
  });
  assert.equal(first.status, 403);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,
    0,
  );
  const signup = await post(
    "sign-in/email-otp",
    { email: "auth@example.test", otp: await code(token) },
    token,
  );
  assert.equal(signup.status, 200, await signup.clone().text());
  const data = await signup.json();
  assert.ok(signup.headers.get("set-cookie")?.includes("HttpOnly"));
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    0,
  );
  await completeSignup(data.user.id, "Auth user", "authuser");
  await revokeInvitation(await person("owner"), id).catch(() => {});
  await db.query("UPDATE invitation SET revoked_at=now() WHERE id=$1", [id]);
  const signin = await post(
    "sign-in/email-otp",
    { email: "auth@example.test", otp: await code(token) },
    token,
  );
  assert.equal(signin.status, 200, await signin.clone().text());
  assert.equal((await signin.json()).user.id, data.user.id);
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
      .uses,
    1,
  );
});

test("email rate limits return a usable retry delay from PostgreSQL timestamps", async () => {
  await db.query('TRUNCATE "rateLimit"');
  const auth = createAuth({
    sendCode: async () => assert.fail("Uninvited email must not be sent"),
  });
  const request = () =>
    auth.handler(
      new Request(
        "http://localhost:3000/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
            "X-Forwarded-For": "192.0.2.10",
          },
          body: JSON.stringify({
            email: "rate-limit@example.test",
            type: "sign-in",
          }),
        },
      ),
    );
  for (let index = 0; index < 10; index++)
    assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  const retry = Number(limited.headers.get("X-Retry-After"));
  assert.ok(
    retry > 0 && retry <= 60,
    `Expected at most 60 seconds, got ${retry}`,
  );
  await db.query('UPDATE "rateLimit" SET "lastRequest"=$1', [
    Date.now() - 61_000,
  ]);
  assert.equal((await request()).status, 200);
});

test("Google and email retain one account; linking requires the existing account session and a verified matching email", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  const codes = new Map<string, string>();
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ email, otp }) => {
      codes.set(email, otp);
    },
  });
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const context = await auth.$context;
  const provider = context.socialProviders[0];
  assert.ok(provider);
  // Replace only Google's external identity response in this isolated test.
  // Screenr's auth hooks, linking policy, sessions and database remain real.
  let identity = {
    id: "google-first",
    email: "google@example.test",
    name: "Google user",
    emailVerified: true,
  };
  provider.idToken = {
    verify: async (token) => token === "test-verified-token",
  };
  provider.getUserInfo = async () => ({
    user: {
      email: identity.email,
      name: identity.name,
      emailVerified: identity.emailVerified,
    },
    data: { sub: identity.id },
  });
  async function post(path: string, body: unknown, cookie = "") {
    return auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      }),
    );
  }
  const social = {
    provider: "google",
    idToken: { token: "test-verified-token" },
  };
  assert.equal((await post("sign-in/social", social)).status, 403);
  const { token } = await createInvitation(null, 2);
  const inviteCookie = `screenr-invite=${token}`;
  const googleSignup = await post("sign-in/social", social, inviteCookie);
  assert.equal(googleSignup.status, 200, await googleSignup.clone().text());
  const googleId = (await googleSignup.json()).user.id;
  await completeSignup(googleId, "Google", "google");
  assert.equal(
    (await accountScreen(googleId)).googleConnected,
    true,
    "Google-created accounts must show their existing connection",
  );
  await post("email-otp/send-verification-otp", {
    email: identity.email,
    type: "sign-in",
  });
  const emailLogin = await post("sign-in/email-otp", {
    email: identity.email,
    otp: codes.get(identity.email),
  });
  assert.equal((await emailLogin.json()).user.id, googleId);

  const email = "emailfirst@example.test";
  await post(
    "email-otp/send-verification-otp",
    { email, type: "sign-in" },
    inviteCookie,
  );
  const emailSignup = await post(
    "sign-in/email-otp",
    { email, otp: codes.get(email) },
    inviteCookie,
  );
  const emailId = (await emailSignup.json()).user.id;
  await completeSignup(emailId, "Email", "emailfirst");
  assert.equal((await accountScreen(emailId)).googleConnected, false);
  const sessionCookie = emailSignup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  identity = {
    id: "email-first-google",
    email,
    name: "Email user",
    emailVerified: true,
  };
  assert.equal(
    (await post("sign-in/social", social)).status,
    401,
    "Matching email alone must not link accounts",
  );
  assert.equal((await post("link-social", social)).status, 401);
  identity.emailVerified = false;
  assert.equal((await post("link-social", social, sessionCookie)).status, 401);
  identity.emailVerified = true;
  identity.email = "different@example.test";
  assert.equal((await post("link-social", social, sessionCookie)).status, 401);
  identity.email = email;
  const linked = await post("link-social", social, sessionCookie);
  assert.equal(linked.status, 200, await linked.clone().text());
  assert.equal((await accountScreen(emailId)).googleConnected, true);
  const googleLogin = await post("sign-in/social", social);
  assert.equal((await googleLogin.json()).user.id, emailId);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,
    2,
  );
});

test("replacement invitations authorize pending accounts and retain completion idempotency", async () => {
  const original = await createInvitation(null);
  const replacement = await createInvitation(null);
  const user = await pending("replacement", original.token);
  await db.query("UPDATE invitation SET revoked_at=now() WHERE id=$1", [
    original.id,
  ]);
  await completeSignup(user, "Replacement", "replacement", replacement.token);
  await completeSignup(user, "Replacement", "replacement", original.token);
  const uses = (
    await db.query("SELECT id,uses FROM invitation WHERE id=ANY($1::uuid[])", [
      [original.id, replacement.id],
    ])
  ).rows;
  assert.equal(uses.find((row) => row.id === original.id).uses, 0);
  assert.equal(uses.find((row) => row.id === replacement.id).uses, 1);
  assert.equal(
    (
      await db.query(
        "SELECT invitation_id FROM invitation_signup WHERE user_id=$1",
        [user],
      )
    ).rows[0].invitation_id,
    replacement.id,
  );
});

test("replacement invitations preserve verification, availability, and rollback checks", async () => {
  for (const condition of [
    "unverified",
    "revoked",
    "expired",
    "exhausted",
  ] as const) {
    const original = await createInvitation(null);
    const replacement = await createInvitation(null);
    const user = await pending(
      condition,
      original.token,
      condition !== "unverified",
    );
    if (condition === "revoked")
      await db.query("UPDATE invitation SET revoked_at=now() WHERE id=$1", [
        replacement.id,
      ]);
    if (condition === "expired")
      await db.query(
        "UPDATE invitation SET expires_at=now()-interval '1 second' WHERE id=$1",
        [replacement.id],
      );
    if (condition === "exhausted")
      await db.query("UPDATE invitation SET uses=max_uses WHERE id=$1", [
        replacement.id,
      ]);
    await assert.rejects(
      completeSignup(user, condition, condition, replacement.token),
      /Verify|no longer/,
    );
    assert.equal(
      (await db.query("SELECT uses FROM invitation WHERE id=$1", [original.id]))
        .rows[0].uses,
      0,
    );
    assert.equal(
      (await db.query("SELECT 1 FROM profile WHERE user_id=$1", [user]))
        .rowCount,
      0,
    );
  }
  await person("takenhandle");
  const original = await createInvitation(null);
  const replacement = await createInvitation(null);
  const user = await pending("conflict", original.token);
  await assert.rejects(
    completeSignup(user, "Conflict", "takenhandle", replacement.token),
    /taken/,
  );
  assert.equal(
    (
      await db.query("SELECT uses FROM invitation WHERE id=$1", [
        replacement.id,
      ])
    ).rows[0].uses,
    0,
  );
});

test("concurrent replacement signups cannot exceed the replacement invitation's capacity", async () => {
  const original = await createInvitation(null, 2);
  const replacement = await createInvitation(null, 1);
  const a = await pending("replacementa", original.token),
    b = await pending("replacementb", original.token);
  const results = await Promise.allSettled([
    completeSignup(a, "A", "replacementa", replacement.token),
    completeSignup(b, "B", "replacementb", replacement.token),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT uses FROM invitation WHERE id=$1", [
        replacement.id,
      ])
    ).rows[0].uses,
    1,
  );
  assert.equal(
    (await db.query("SELECT uses FROM invitation WHERE id=$1", [original.id]))
      .rows[0].uses,
    0,
  );
});

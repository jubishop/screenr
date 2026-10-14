import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  useDatabase,
  db,
  person,
  pending,
  friend,
  bearerFor,
  cookieFor,
  assertRouteError,
  captureFailures,
  denied,
} from "./social-fixture";
import { fakeApple, serve } from "./identity-providers";
import type { FeedItem } from "../../src/shared";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { createAuth } = await import("../../src/server/auth");
const { loadScreen } = await import("../../src/server/screens");
const { addComment, createDiscussionPost, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity, updateWatchStatus, updateTopTen } =
  await import("../../src/server/title-actions");
const { saveReview } = await import("../../src/server/reviews");
const { setReaction } = await import("../../src/server/reactions");
const { uploadPhoto } = await import("../../src/server/photos");
const { changePushDevice } = await import("../../src/server/push");
const { saveServices } = await import("../../src/server/streaming-services");
const { notifications, saveActivityEmail } =
  await import("../../src/server/notifications");
const { recordActiveDay } = await import("../../src/server/usage");
const { codeRecipientHash, queueCode } = await import("../../src/server/email");
useDatabase();

// Account deletion (docs/data-and-access.md#account-deletion): a fresh
// sign-in, Apple revocation, and one transaction that erases the person.

const origin = "http://localhost:3000";
// Every piece of text the departing member writes carries this marker, so a
// scan of every text column shows that none of it survives.
const marker = "farewell-marker";

function deleteAccount(headers: Record<string, string>) {
  return POST(
    new Request(`${origin}/api/screenr/delete-account`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    }),
    { params: Promise.resolve({ action: "delete-account" }) },
  );
}
const bearer = async (userId: string) => ({
  Authorization: `Bearer ${await bearerFor(userId)}`,
});
const sessionOf = (token: string) =>
  decodeURIComponent(token.replace(/^Bearer /, "")).split(".")[0];

// Sets Apple's provider settings for one test.
function configureApple(t: TestContext, apple: ReturnType<typeof fakeApple>) {
  const settings = apple.env();
  Object.assign(process.env, settings);
  serve(apple);
  t.after(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
    mock.restoreAll();
  });
}

// Links Sign in with Apple to the member's account, as the iPhone app does.
async function linkApple(apple: ReturnType<typeof fakeApple>, userId: string) {
  const { email } = (
    await db.query('SELECT email FROM "user" WHERE id=$1', [userId])
  ).rows[0];
  const { token, code } = apple.authorize({ sub: `apple-${userId}`, email });
  const response = await createAuth({ rateLimit: false }).handler(
    new Request(`${origin}/api/auth/link-social`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await bearer(userId)),
      },
      body: JSON.stringify({
        provider: "apple",
        idToken: { token },
        additionalData: { authorizationCode: code },
      }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
}

// Every column whose foreign keys lead, directly or through other keys, to a
// person: the auth user or the profile. Read from the schema, so tables
// added later are covered without changing this test.
async function personColumns() {
  const { rows } = await db.query<{
    table: string;
    column: string;
    references: string;
  }>(
    `SELECT fk.table_name AS table,fk.column_name AS column,
      pk.table_name||'.'||pk.column_name AS references
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage fk
      ON fk.constraint_schema=rc.constraint_schema AND fk.constraint_name=rc.constraint_name
    JOIN information_schema.key_column_usage pk
      ON pk.constraint_schema=rc.unique_constraint_schema
      AND pk.constraint_name=rc.unique_constraint_name
      AND pk.ordinal_position=fk.position_in_unique_constraint
    WHERE rc.constraint_schema='public'`,
  );
  const people = new Set(["user.id", "profile.user_id"]);
  for (let grown = true; grown;) {
    grown = false;
    for (const row of rows) {
      const name = `${row.table}.${row.column}`;
      if (people.has(row.references) && !people.has(name)) {
        people.add(name);
        grown = true;
      }
    }
  }
  return [...people].sort();
}

// Rows in any column that refers to the person.
async function references(userId: string) {
  const found: string[] = [];
  for (const name of await personColumns()) {
    const [table, column] = name.split(".");
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}"=$1`,
      [userId],
    );
    if (rows[0].n) found.push(`${name}: ${rows[0].n}`);
  }
  return found;
}

// Rows in any text or JSON column, in every table, that contain one of the
// values.
async function mentions(values: string[]) {
  const { rows: columns } = await db.query<{ table: string; column: string }>(
    `SELECT c.table_name AS table,c.column_name AS column
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
      AND c.data_type IN ('text','character varying','json','jsonb')`,
  );
  assert.ok(columns.length > 40, "The scan reads every text column");
  const found: string[] = [];
  for (const { table, column } of columns)
    for (const value of values) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM "${table}"
        WHERE strpos(lower("${column}"::text),lower($1))>0`,
        [value],
      );
      if (rows[0].n) found.push(`${table}.${column} contains ${value}`);
    }
  return found;
}

const comment = async (id: string) =>
  (
    await db.query(
      `SELECT author_id,addressed_id,root_id::text,body,removed_at IS NOT NULL AS removed
      FROM comment WHERE id=$1::bigint`,
      [id],
    )
  ).rows[0];

// A member with something in every table that holds a person's data, and a
// circle of friends whose conversations they joined.
async function departingMember(t: TestContext) {
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name) VALUES
      ('movie:1','movie',1,'Test Movie'),('movie:2','movie',2,'Second Movie'),
      ('tv:3','tv',3,'Test Show') ON CONFLICT DO NOTHING`,
  );
  const alice = await person("alice");
  const ben = await person("ben");
  const cam = await person("cam");
  const blocker = await person("blocker");
  const blocked = await person("blocked");
  const departing = await person("departing");
  const email = "departing@example.test";
  await friend(alice, ben);
  await friend(alice, departing);
  await friend(ben, departing);
  await changeRelationship(departing, cam, "request");
  await changeRelationship(departing, blocked, "block");
  await changeRelationship(blocker, departing, "block");

  // Someone who joined through the departing member's invitation, and one
  // still open.
  const { token } = await createInvitation(departing, 2);
  const eve = await pending("eve", token);
  await completeSignup(eve, "eve", "eve");
  await createInvitation(departing, 1);

  // Their own entries, with friends' replies and reactions on them.
  const recommend = await updateTitleActivity(
    departing,
    "movie:1",
    "recommended",
    true,
  );
  await updateTopTen(departing, "movie:1", "add");
  await updateTitleActivity(
    departing,
    "movie:2",
    "want_to_watch",
    true,
    "title",
  );
  await updateWatchStatus(departing, "tv:3", "watching");
  const review = await saveReview(
    departing,
    "movie:1",
    5,
    `A ${marker} review.`,
    false,
  );
  const titleComment = await createTitleComment(
    departing,
    "tv:3",
    `A ${marker} title comment.`,
    false,
  );
  const post = await createDiscussionPost(
    departing,
    `A ${marker} post.`,
    false,
  );
  const onReview = await addComment(alice, review, "Great review!", false);
  await addComment(departing, review, `Thanks, ${marker}.`, false, onReview);
  await addComment(ben, post, "Count me in.", false);
  await addComment(alice, titleComment, "Agreed.", false);
  await setReaction(alice, recommend, null, "love");

  // Their comments in a friend's conversation.
  const entry = await updateTitleActivity(
    alice,
    "movie:2",
    "recommended",
    true,
  );
  const kept = await addComment(departing, entry, `A ${marker} root.`, false);
  const answer = await addComment(alice, entry, "Alice answers.", false, kept);
  const followUp = await addComment(ben, entry, "Ben too.", false, answer);
  const ownReply = await addComment(
    departing,
    entry,
    `My ${marker} follow-up.`,
    false,
    answer,
  );
  const lonely = await addComment(departing, entry, `${marker} alone.`, false);
  const benRoot = await addComment(ben, entry, "Ben's thought.", false);
  const reply = await addComment(
    departing,
    entry,
    `A ${marker} reply.`,
    false,
    benRoot,
  );
  const addressed = await addComment(
    alice,
    entry,
    "Replying to you.",
    false,
    reply,
  );
  const emptied = await addComment(
    departing,
    entry,
    `${marker} emptied.`,
    false,
  );
  const removedReply = await addComment(ben, entry, "Gone.", false, emptied);
  await removeComment(ben, removedReply);
  await setReaction(departing, entry, null, "like");
  await setReaction(departing, entry, benRoot, "haha");
  await setReaction(alice, entry, kept, "wow");

  // Settings, devices, photo, usage, and pending email.
  const session = await bearerFor(departing);
  // Bytes that start like a JPEG; the server checks only the leading bytes.
  const photo = Buffer.alloc(4000, 7);
  photo.set([0xff, 0xd8, 0xff, 0xe0]);
  await uploadPhoto(departing, photo);
  await saveServices(departing, ["service:netflix"]);
  await saveActivityEmail(departing, true);
  await changePushDevice(
    departing,
    (
      await db.query("SELECT id FROM session WHERE token=$1", [
        sessionOf(session),
      ])
    ).rows[0].id,
    {
      action: "register",
      token: "d1".repeat(32),
      environment: "sandbox",
      topic: "com.artisanalsoftware.Screenr.dev",
      build: 1,
    },
  );
  await recordActiveDay(departing);
  await db.query(
    `INSERT INTO email_job(id,payload,expires_at,notification_recipient)
    VALUES($1,'',now()+interval '1 day',$2)`,
    [randomUUID(), departing],
  );
  process.env.EMAIL_TRANSPORT = "resend";
  t.after(() => delete process.env.EMAIL_TRANSPORT);
  await queueCode({ email, otp: "123456" });
  await queueCode({ email, otp: "654321", type: "email-verification" });
  // An unused sign-in code waiting in Better Auth's verification table.
  const sent = await createAuth({
    rateLimit: false,
    sendCode: async () => {},
  }).handler(
    new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, type: "sign-in" }),
    }),
  );
  assert.equal(sent.status, 200);

  return {
    alice,
    ben,
    cam,
    eve,
    departing,
    email,
    session,
    ids: {
      entry,
      kept,
      answer,
      followUp,
      ownReply,
      lonely,
      benRoot,
      reply,
      addressed,
      emptied,
      removedReply,
    },
  };
}

test("deleting an account erases every row that refers to the member, keeping replies under placeholders", async (t) => {
  const apple = fakeApple();
  configureApple(t, apple);
  const world = await departingMember(t);
  const { departing, email, alice, ids } = world;
  await linkApple(apple, departing);

  // The schema scan finds the columns this test relies on.
  const columns = await personColumns();
  for (const column of [
    "comment.author_id",
    "comment.addressed_id",
    "feed_item.owner_id",
    "top_ten.owner_id",
    "push_device.user_id",
    "session.userId",
    "account.userId",
    "profile_photo.user_id",
  ])
    assert.ok(columns.includes(column), column);
  assert.notDeepEqual(await references(departing), []);
  assert.notDeepEqual(
    await mentions([departing, email, "departing", marker]),
    [],
  );

  const response = await deleteAccount({
    Authorization: `Bearer ${world.session}`,
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { ok: true });

  // Apple's authorization ended, as Apple requires.
  assert.deepEqual(
    apple.revoked.map(({ token }) => token),
    [apple.exchanged[0]!.refreshToken],
  );
  // No row anywhere refers to the member or holds their address, username,
  // or anything they wrote.
  assert.deepEqual(await references(departing), []);
  assert.deepEqual(await mentions([departing, email, "departing", marker]), []);
  // Queued code emails name the address only as a hash.
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM email_job WHERE recipient_hash=ANY($1)",
        [
          [
            codeRecipientHash("sign-in", email),
            codeRecipientHash("email-verification", email),
          ],
        ],
      )
    ).rows[0].n,
    0,
  );

  // A comment with replies keeps an authorless placeholder; the replies
  // remain, and replies addressed to the member no longer name them.
  assert.deepEqual(await comment(ids.kept), {
    author_id: null,
    addressed_id: null,
    root_id: null,
    body: "[removed]",
    removed: true,
  });
  assert.equal((await comment(ids.answer)).author_id, alice);
  assert.equal((await comment(ids.answer)).addressed_id, null);
  assert.equal((await comment(ids.followUp)).addressed_id, alice);
  assert.equal((await comment(ids.addressed)).addressed_id, null);
  assert.equal((await comment(ids.addressed)).root_id, ids.benRoot);
  for (const gone of [ids.ownReply, ids.lonely, ids.reply, ids.emptied])
    assert.equal(await comment(gone), undefined);
  // A comment whose only reply was already removed goes with that reply.
  assert.equal(await comment(ids.removedReply), undefined);

  // The token no longer signs anyone in.
  await assertRouteError(
    await deleteAccount({ Authorization: `Bearer ${world.session}` }),
    denied.signedOut,
  );
  // Without a new invitation, the address gets no sign-in code.
  let codes = 0;
  const sent = await createAuth({
    rateLimit: false,
    sendCode: async () => {
      codes++;
    },
  }).handler(
    new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, type: "sign-in" }),
    }),
  );
  assert.equal(sent.status, 200);
  assert.equal(codes, 0);
});

test("friends' feeds, title pages, profiles, and notifications still render after a member deletes their account", async (t) => {
  const world = await departingMember(t);
  const { departing, alice, ben, cam, eve, ids } = world;
  const response = await deleteAccount({
    Authorization: `Bearer ${world.session}`,
  });
  assert.equal(response.status, 200, await response.clone().text());

  type Screen = Awaited<ReturnType<typeof loadScreen>>;
  const conversationsOf = (screen: Screen): FeedItem[] =>
    ("conversations" in screen && screen.conversations) || [];
  const feed = await loadScreen(alice, "/");
  assert.equal(feed.kind, "feed");
  // The member's own entries are gone with their conversations.
  for (const screen of [
    feed,
    await loadScreen(alice, "/titles/movie/1"),
    await loadScreen(alice, "/titles/tv/3"),
    await loadScreen(ben, "/people/alice"),
  ])
    assert.ok(
      conversationsOf(screen).every((item) => item.owner_id !== departing),
    );
  const entry = conversationsOf(feed).find((item) => item.id === ids.entry);
  assert.ok(entry, "Alice's entry remains");
  const placeholder = entry.comments.find((c) => c.id === ids.kept);
  assert.deepEqual(
    placeholder && {
      author_id: placeholder.author_id,
      username: placeholder.username,
      display_name: placeholder.display_name,
      photo: placeholder.photo,
      body: placeholder.body,
      removed: placeholder.removed,
      unavailable: placeholder.unavailable,
    },
    {
      author_id: null,
      username: null,
      display_name: null,
      photo: null,
      body: "",
      removed: true,
      unavailable: false,
    },
  );
  assert.deepEqual(
    entry.comments.map((c) => c.id),
    [ids.kept, ids.answer, ids.followUp, ids.benRoot, ids.addressed],
  );
  assert.equal(
    entry.comments.find((c) => c.id === ids.answer)?.addressed_username,
    null,
  );
  // The same entry on Ben's view of Alice's profile and on the title page.
  const onProfile = conversationsOf(await loadScreen(ben, "/people/alice"));
  assert.ok(onProfile.find((item) => item.id === ids.entry));
  const title = await loadScreen(alice, "/titles/movie/2");
  assert.equal(title.kind, "title");
  assert.ok(conversationsOf(title).find((item) => item.id === ids.entry));
  if (title.kind === "title")
    assert.ok(title.friends.recommended.every((f) => f.user_id !== departing));

  // Friends' lists, People, and notifications leave the member out.
  const profile = await loadScreen(alice, "/people/ben");
  assert.equal(profile.kind, "profile");
  if (profile.kind === "profile")
    assert.deepEqual(
      profile.profile.friends.map((f) => f.username),
      ["alice"],
    );
  const people = await loadScreen(cam, "/people");
  assert.equal(people.kind, "people");
  if (people.kind === "people") assert.deepEqual(people.connections, []);
  const bell = await notifications(alice);
  assert.ok(bell.items.length, "Alice still has notifications");
  assert.ok(bell.items.every((n) => n.actorId !== departing));
  await assert.rejects(loadScreen(alice, "/people/departing"), denied.person);
  // Someone who joined through the member's invitation keeps their account.
  assert.equal((await loadScreen(eve, "/")).kind, "feed");
});

test("deletion needs a sign-in from the last ten minutes", async () => {
  const departing = await person("departing");
  const cookie = await cookieFor(departing);
  await db.query(
    `UPDATE session SET "createdAt"=now()-interval '11 minutes' WHERE "userId"=$1`,
    [departing],
  );
  const web = { Cookie: cookie, Origin: origin };
  await assertRouteError(await deleteAccount(web), {
    status: 403,
    message:
      "To delete your account, confirm it’s you again with a new sign-in.",
  });
  // Cross-site requests are refused before anything else.
  await assertRouteError(
    await deleteAccount({ Cookie: cookie }),
    denied.origin,
  );
  assert.equal(
    (await db.query("SELECT 1 FROM profile WHERE user_id=$1", [departing]))
      .rowCount,
    1,
  );

  // A fresh sign-in, from the web's email code, deletes the account.
  const response = await deleteAccount({
    Cookie: await cookieFor(departing),
    Origin: origin,
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await references(departing), []);
});

test("when Apple does not confirm revocation, nothing is erased and a retry deletes the account", async (t) => {
  const apple = fakeApple();
  configureApple(t, apple);
  const departing = await person("departing");
  await linkApple(apple, departing);
  const headers = await bearer(departing);

  // Apple rejects Screenr's key until it is fixed.
  apple.rotateKey();
  const failures = captureFailures();
  await assertRouteError(await deleteAccount(headers), {
    status: 503,
    message:
      "Sign in with Apple could not be disconnected, so your account was not deleted. Please try again later.",
  });
  assert.deepEqual(
    failures
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line).event),
    ["apple revoke failed"],
  );
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM account
        WHERE "userId"=$1 AND "providerId"='apple' AND "refreshToken" IS NOT NULL`,
        [departing],
      )
    ).rows[0].n,
    1,
    "The token stays for the retry",
  );
  assert.notDeepEqual(await references(departing), []);

  process.env.APPLE_PRIVATE_KEY = apple.env().APPLE_PRIVATE_KEY;
  const response = await deleteAccount(headers);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(apple.revoked.length, 1);
  assert.deepEqual(await references(departing), []);
});

test("a token no secret can open no longer blocks deletion", async (t) => {
  const apple = fakeApple();
  configureApple(t, apple);
  const departing = await person("departing");
  await linkApple(apple, departing);
  // After a BETTER_AUTH_SECRET change, earlier tokens cannot be read.
  await db.query(
    `UPDATE account SET "refreshToken"='bm90IGEgc2VhbGVkIHRva2VuIGF0IGFsbA=='
    WHERE "userId"=$1 AND "providerId"='apple'`,
    [departing],
  );
  const failures = captureFailures();
  const response = await deleteAccount(await bearer(departing));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    failures
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line).event),
    ["apple token unreadable"],
  );
  assert.equal(apple.revoked.length, 0);
  assert.deepEqual(await references(departing), []);
});

test("a person who never finished setup can delete their account", async () => {
  const { token } = await createInvitation(null);
  const pat = await pending("pat", token);
  const response = await deleteAccount(await bearer(pat));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await references(pat), []);
});

import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  useDatabase,
  db,
  testDatabaseURL,
  person,
  pending,
  friend,
  bearerFor,
  cookieFor,
  signIn,
  assertRouteError,
  captureFailures,
  denied,
} from "./social-fixture";
import { fakeApple, serve } from "./identity-providers";
import type { FeedItem } from "../../src/shared";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { createAuth } = await import("../../src/server/auth");
const { eraseAccounts } = await import("../../src/server/account-deletion");
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

type FakeApple = ReturnType<typeof fakeApple>;
type Server = Parameters<typeof serve>[0];

// Sets Apple's provider settings for one test. `server` answers Apple's
// requests, by default the fake Apple itself.
function configureApple(
  t: TestContext,
  apple: FakeApple,
  server: Server = apple,
) {
  const settings = apple.env();
  Object.assign(process.env, settings);
  serve(server);
  t.after(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
    mock.restoreAll();
  });
}

// Posts a Sign in with Apple authorization for the member's Apple ID, as the
// iPhone app does.
async function postApple(
  apple: FakeApple,
  userId: string,
  path: "link-social" | "sign-in/social",
  headers: Record<string, string> = {},
) {
  const { email } = (
    await db.query('SELECT email FROM "user" WHERE id=$1', [userId])
  ).rows[0];
  const { token, code } = apple.authorize({ sub: `apple-${userId}`, email });
  const response = await createAuth({ rateLimit: false }).handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        provider: "apple",
        idToken: { token },
        additionalData: { authorizationCode: code },
      }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
}

// Links Sign in with Apple to the member's account.
const linkApple = async (apple: FakeApple, userId: string) =>
  postApple(apple, userId, "link-social", await bearer(userId));

// A later Sign in with Apple, which stores a newer refresh token.
const signInWithApple = (apple: FakeApple, userId: string) =>
  postApple(apple, userId, "sign-in/social");

// How many Apple refresh tokens the member's account rows still hold.
const appleTokenCount = async (userId: string) =>
  (
    await db.query(
      `SELECT "refreshToken" FROM account
      WHERE "userId"=$1 AND "providerId"='apple' AND "refreshToken" IS NOT NULL`,
      [userId],
    )
  ).rows.length;

// The events of the JSON failure lines that captureFailures collected.
const failureEvents = (failures: string[]) =>
  failures
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line).event);

const appleNotDisconnected = {
  status: 503,
  message:
    "Sign in with Apple could not be disconnected, so your account was not deleted. Please try again later.",
};

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
  await recordActiveDay(departing, "ios");
  await db.query(
    `INSERT INTO email_job(id,payload,expires_at,notification_recipient)
    VALUES($1,'',now()+interval '1 day',$2)`,
    [randomUUID(), departing],
  );
  process.env.EMAIL_TRANSPORT = "resend";
  t.after(() => delete process.env.EMAIL_TRANSPORT);
  await queueCode({ email, otp: "123456" });
  await queueCode({ email, otp: "654321", type: "email-verification" });
  // Unused codes waiting in Better Auth's verification table, one of each
  // type a request can store, though Screenr sends no password reset code.
  const auth = createAuth({ rateLimit: false, sendCode: async () => {} });
  for (const type of ["sign-in", "email-verification", "forget-password"]) {
    const sent = await auth.handler(
      new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ email, type }),
      }),
    );
    assert.equal(sent.status, 200);
  }

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

test("deletion leaves another member's pending code and sign-in state, even when their address contains the member's", async (t) => {
  // A Google link started on the web keeps a sign-in state that names the
  // member's ID and address until Google returns.
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
  });
  t.after(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  const departing = await person("bob");
  const other = await person("abob");
  const otherEmail = "abob@example.test";
  const codes = new Map<string, string>();
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ email, otp }) => {
      codes.set(email, otp);
    },
  });
  const post = (path: string, body: unknown, headers = {}) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  const cookies: Record<string, string> = {};
  for (const [id, email] of [
    [departing, "bob@example.test"],
    [other, otherEmail],
  ]) {
    cookies[id] = await cookieFor(id);
    const linking = await post(
      "link-social",
      { provider: "google", callbackURL: "/account" },
      { Cookie: cookies[id] },
    );
    assert.equal(linking.status, 200, await linking.clone().text());
    const sent = await post("email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    assert.equal(sent.status, 200);
  }
  const verifications = async () =>
    (
      await db.query<{ identifier: string; value: string }>(
        "SELECT identifier,value FROM verification",
      )
    ).rows
      .map(({ identifier, value }) =>
        identifier === `sign-in-otp-${otherEmail}`
          ? "other's code"
          : value.includes(other)
            ? "other's state"
            : identifier === "sign-in-otp-bob@example.test"
              ? "member's code"
              : value.includes(departing)
                ? "member's state"
                : identifier,
      )
      .sort();
  assert.deepEqual(await verifications(), [
    "member's code",
    "member's state",
    "other's code",
    "other's state",
  ]);

  const response = await deleteAccount({
    Cookie: cookies[departing],
    Origin: origin,
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await verifications(), ["other's code", "other's state"]);
  // The other member's code still signs them in.
  const signedIn = await post("sign-in/email-otp", {
    email: otherEmail,
    otp: codes.get(otherEmail),
  });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
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

// The comment table and every table whose foreign keys lead to it, directly
// or through other keys, such as notifications. Read from the schema, so
// tables added later are covered without changing this test.
async function commentTables() {
  const { rows } = await db.query<{ table: string; references: string }>(
    `SELECT t.relname AS table,r.relname AS references FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid JOIN pg_class r ON r.oid=c.confrelid
    WHERE c.contype='f' AND c.connamespace='public'::regnamespace`,
  );
  const tables = new Set(["comment"]);
  for (let grown = true; grown;) {
    grown = false;
    for (const row of rows)
      if (tables.has(row.references) && !tables.has(row.table)) {
        tables.add(row.table);
        grown = true;
      }
  }
  return [...tables].sort();
}

// Erasure holds the domain lock while it runs, and PostgreSQL checks each
// foreign key once per deleted row. A step that reads every comment, or every
// row of a table that refers to them, therefore costs comments deleted ×
// rows stored, which would soon keep other members' writes waiting past
// their 2-second lock timeout. Tables this small make a sequential scan the
// cheapest plan even where an index applies, so sequential scans are
// disabled: any that remain are steps no index can serve. A new connection
// prepares the foreign-key checks' plans under that setting.
test("erasing an account reads comments and the tables that refer to them only through indexes", async (t) => {
  const { departing } = await departingMember(t);
  const tables = await commentTables();
  assert.ok(tables.includes("notification"), "The schema scan finds tables");
  const pool = new Pool({ connectionString: testDatabaseURL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SET enable_seqscan = off");
    await client.query("BEGIN");
    await eraseAccounts(client, [departing]);
    const { rows } = await client.query(
      `SELECT relname AS table,seq_scan::int AS scans FROM pg_stat_xact_user_tables
      WHERE relname=ANY($1) AND seq_scan>0 ORDER BY relname`,
      [tables],
    );
    assert.deepEqual(rows, []);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
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

test("the iPhone app signs in again while signed in, then deletes with the new token", async () => {
  const departing = await person("departing");
  const stale = await bearer(departing);
  await db.query(
    `UPDATE session SET "createdAt"=now()-interval '11 minutes' WHERE "userId"=$1`,
    [departing],
  );
  await assertRouteError(await deleteAccount(stale), {
    status: 403,
    message:
      "To delete your account, confirm it’s you again with a new sign-in.",
  });

  // The app sends its bearer token, and no Origin, with the new sign-in. The
  // response names the member, which the app checks before keeping the new
  // token, so a sign-in to another account can never delete that one.
  const confirmed = await signIn(departing, stale);
  assert.equal((await confirmed.json()).user.id, departing);
  const token = confirmed.headers.get("set-auth-token");
  assert.ok(token);
  // Freshness belongs to the requesting session: the new sign-in leaves the
  // stale token unable to delete.
  await assertRouteError(await deleteAccount(stale), {
    status: 403,
    message:
      "To delete your account, confirm it’s you again with a new sign-in.",
  });

  const response = await deleteAccount({ Authorization: `Bearer ${token}` });
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
  await assertRouteError(await deleteAccount(headers), appleNotDisconnected);
  assert.deepEqual(failureEvents(failures), ["apple revoke failed"]);
  assert.equal(
    await appleTokenCount(departing),
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
  assert.deepEqual(failureEvents(failures), ["apple token unreadable"]);
  assert.equal(apple.revoked.length, 0);
  assert.deepEqual(await references(departing), []);
});

// Answers Apple's requests, signing the member in with Apple again as Apple
// receives each of the first `times` revocations, as the iPhone app might
// while deletion runs.
function signInDuringRevocation(
  apple: FakeApple,
  userId: string,
  times: number,
) {
  let signIns = 0;
  return {
    async handle(url: URL, init?: RequestInit) {
      if (url.pathname === "/auth/revoke" && signIns < times) {
        signIns++;
        await signInWithApple(apple, userId);
      }
      return apple.handle(url, init);
    },
  };
}

test("a Sign in with Apple token stored between revocation and erasure is revoked before the account is erased", async (t) => {
  const apple = fakeApple();
  const departing = await person("departing");
  configureApple(t, apple, signInDuringRevocation(apple, departing, 1));
  await linkApple(apple, departing);
  const response = await deleteAccount(await bearer(departing));
  assert.equal(response.status, 200, await response.clone().text());
  // Both the linked token and the one the later sign-in stored were revoked.
  assert.equal(apple.exchanged.length, 2);
  assert.deepEqual(
    apple.revoked.map(({ token }) => token),
    apple.exchanged.map(({ refreshToken }) => refreshToken),
  );
  assert.deepEqual(await references(departing), []);
});

test("when Sign in with Apple keeps storing new tokens, deletion stops without erasing anything", async (t) => {
  const apple = fakeApple();
  const departing = await person("departing");
  configureApple(t, apple, signInDuringRevocation(apple, departing, Infinity));
  await linkApple(apple, departing);
  const headers = await bearer(departing);
  const failures = captureFailures();
  await assertRouteError(await deleteAccount(headers), appleNotDisconnected);
  assert.deepEqual(failureEvents(failures), ["apple token replaced"]);
  // Each of the three rounds revoked the token it found; the newest stays
  // for a retry.
  assert.equal(apple.revoked.length, 3);
  assert.equal(apple.exchanged.length, 4);
  assert.equal(await appleTokenCount(departing), 1);
  assert.notDeepEqual(await references(departing), []);
});

test("without Sign in with Apple settings, a member with an Apple token cannot delete their account", async (t) => {
  const apple = fakeApple();
  configureApple(t, apple);
  const departing = await person("departing");
  await linkApple(apple, departing);
  const withoutApple = await person("without_apple");
  // The settings are later removed from app.env.
  for (const name of Object.keys(apple.env())) delete process.env[name];

  const failures = captureFailures();
  await assertRouteError(await deleteAccount(await bearer(departing)), {
    status: 503,
    message:
      "Sign in with Apple is unavailable right now, so your account was not deleted. Please try again later.",
  });
  assert.deepEqual(failureEvents(failures), ["apple settings missing"]);
  assert.equal(apple.revoked.length, 0);
  assert.equal(await appleTokenCount(departing), 1);
  assert.notDeepEqual(await references(departing), []);
  // A member without an Apple token can still delete their account.
  const response = await deleteAccount(await bearer(withoutApple));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await references(withoutApple), []);
});

test("a person who never finished setup can delete their account", async () => {
  const { token } = await createInvitation(null);
  const pat = await pending("pat", token);
  const response = await deleteAccount(await bearer(pat));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await references(pat), []);
});

// Replaces console.log until the test ends and returns the JSON events it
// printed.
function captureEvents(t: TestContext) {
  const printed: Record<string, unknown>[] = [];
  mock.method(console, "log", (line: unknown) => {
    try {
      printed.push(JSON.parse(String(line)));
    } catch {}
  });
  t.after(() => mock.restoreAll());
  return printed;
}

test("each deletion leaves one journal line that names only the user ID", async (t) => {
  const departing = await person("departing");
  const stale = await person("stale");
  const events = captureEvents(t);
  const staleSession = await bearer(stale);
  await db.query(
    `UPDATE session SET "createdAt"=now()-interval '11 minutes' WHERE "userId"=$1`,
    [stale],
  );
  assert.equal((await deleteAccount(staleSession)).status, 403);
  assert.equal((await deleteAccount(await bearer(departing))).status, 200);
  assert.deepEqual(events, [{ event: "account deleted", userId: departing }]);
});

// Runs a command in the checkout, with this suite's database, writing
// `input` to its standard input.
function run(command: string, args: string[], input: string) {
  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ stdout })
        : reject(new Error(`${command} exited ${code}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

test("after a restore, the delete-accounts command erases the accounts that journal lines name again", async () => {
  const restored = await person("restored");
  const kept = await person("kept");
  await friend(restored, kept);
  // What `journalctl -o cat` prints: deletions among other lines.
  const journal = [
    "Server started",
    JSON.stringify({ event: "request failed", status: 500 }),
    JSON.stringify({ event: "account deleted", userId: restored }),
    JSON.stringify({ event: "account deleted", userId: "already-gone" }),
    "",
  ].join("\n");
  const { stdout } = await run(
    "npx",
    ["tsx", "scripts/delete-accounts.ts"],
    journal,
  );
  assert.equal(
    stdout,
    "Deleted 1 account again. 1 named account was not in the database.\n",
  );
  assert.deepEqual(await references(restored), []);
  assert.equal(
    (await db.query("SELECT 1 FROM profile WHERE user_id=$1", [kept])).rowCount,
    1,
  );
});

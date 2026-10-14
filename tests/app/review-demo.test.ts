import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { format, promisify } from "node:util";
import {
  useDatabase,
  db,
  denied,
  friend,
  pending,
  person,
} from "./social-fixture";
const { createAuth } = await import("../../src/server/auth");
const { seedDemoCircle } = await import("../../src/server/demo-circle");
const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");
const { profileFor } = await import("../../src/server/profiles");
const { changeRelationship, people } =
  await import("../../src/server/relationships");
const { loadScreen } = await import("../../src/server/screens");
const { titleSuggestions } = await import("../../src/server/title-suggestions");
const { friendsRecommend } = await import("../../src/server/friends-recommend");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");
const { recordActiveDay, usageReport } = await import("../../src/server/usage");

useDatabase();

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const reviewer = "review@screenr.club";
const fixedCode = "730194";

// A fictional catalog on loopback answers every title the seed resolves.
const catalog = createServer((request, response) => {
  const match = /^\/(movie|tv)\/([1-9][0-9]*)$/.exec(
    new URL(request.url ?? "/", "http://catalog").pathname,
  );
  if (!match) {
    response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  const [, kind, id] = match;
  response.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      id: Number(id),
      [kind === "movie" ? "title" : "name"]: `Catalog ${kind} ${id}`,
    }),
  );
});
before(async () => {
  await new Promise<void>((done) => catalog.listen(0, "127.0.0.1", done));
  process.env.SCREENR_TEST_TMDB_URL = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  process.env.TMDB_READ_TOKEN = "demo-catalog-token";
});
after(() => {
  catalog.close();
  delete process.env.SCREENR_TEST_TMDB_URL;
  delete process.env.TMDB_READ_TOKEN;
});

async function reviewerAccount() {
  const { rows } = await db.query<{ id: string; username: string }>(
    `SELECT u.id,p.username FROM "user" u JOIN profile p ON p.user_id=u.id
    WHERE u.email=$1`,
    [reviewer],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

// The reviewer's friends, as the reviewer sees them.
async function demoFriends(reviewerId: string) {
  return (await people(reviewerId)).connections;
}

async function withCode<T>(code: string | undefined, work: () => Promise<T>) {
  const previous = process.env.REVIEW_SIGN_IN_CODE;
  if (code === undefined) delete process.env.REVIEW_SIGN_IN_CODE;
  else process.env.REVIEW_SIGN_IN_CODE = code;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.REVIEW_SIGN_IN_CODE;
    else process.env.REVIEW_SIGN_IN_CODE = previous;
  }
}

// Email-code requests and sign-ins through Better Auth's routes, with every
// limit enabled. Each request comes from a new client address unless one is
// given, which isolates the per-address limits from the per-IP limit.
let requests = 0;
function emailCodes(code: string | undefined) {
  const sent: { email: string; otp: string }[] = [];
  const auth = withCode(code, async () =>
    createAuth({
      sendCode: async ({ email, otp }) => {
        sent.push({ email, otp });
      },
    }),
  );
  const post = async (path: string, body: unknown, ip?: string) =>
    (await auth).handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          "X-Forwarded-For":
            ip ??
            `10.2.${Math.floor(requests / 250)}.${(requests++ % 250) + 1}`,
        },
        body: JSON.stringify(body),
      }),
    );
  return {
    sent,
    request: (email: string, ip?: string) =>
      post("email-otp/send-verification-otp", { email, type: "sign-in" }, ip),
    signIn: (email: string, otp: string) =>
      post("sign-in/email-otp", { email, otp }),
  };
}

async function assertSignedIn(response: Response, userId: string) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).user.id, userId);
}

async function assertRejected(
  response: Response,
  status: number,
  code: string,
) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, code);
}

// Everything printed while `work` runs.
async function printed(work: () => Promise<void>) {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    mock.method(console, method, (...args: unknown[]) => {
      lines.push(format(...args));
    });
  try {
    await work();
  } finally {
    mock.restoreAll();
  }
  return lines.join("\n");
}

test("the seed command creates a closed demo circle with real activity, and reseeding resets it", async () => {
  // Other suites leave stored titles behind. Without them, the seed must
  // resolve every title through the catalog.
  await db.query("TRUNCATE title CASCADE");
  const alice = await person("alice");
  const ben = await person("ben");
  await friend(alice, ben);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Real Movie') ON CONFLICT DO NOTHING",
  );
  const real = await updateTitleActivity(alice, "movie:1", "recommended", true);
  await addComment(ben, real, "A real reply.", false);

  const seed = async (code: string) =>
    (
      await execute("npm", ["run", "--silent", "seed:review"], {
        cwd: root,
        env: { ...process.env, REVIEW_SIGN_IN_CODE: code },
      })
    ).stdout;
  assert.equal(
    await seed(fixedCode),
    "Seeded the demo circle: review@screenr.club and 3 demo friends.\n",
  );

  const first = await reviewerAccount();
  const friends = await demoFriends(first.id);
  assert.ok(
    friends.length >= 2 && friends.length <= 3,
    "two or three demo friends",
  );
  const circle = [first.id, ...friends.map((member) => member.user_id)];
  // Every demo account is friends with every other one, and with no one else.
  const friendships = (
    await db.query<{ low_id: string; high_id: string; accepted: boolean }>(
      `SELECT low_id,high_id,accepted_at IS NOT NULL AS accepted FROM friendship
      WHERE low_id=ANY($1) OR high_id=ANY($1)`,
      [circle],
    )
  ).rows;
  assert.equal(friendships.length, (circle.length * (circle.length - 1)) / 2);
  for (const pair of friendships) {
    assert.ok(pair.accepted);
    assert.ok(circle.includes(pair.low_id) && circle.includes(pair.high_id));
  }

  // Recommendations, reviews, and a conversation between demo friends, on
  // titles resolved through the catalog.
  const content = async () =>
    (
      await db.query<{
        recommendations: number;
        reviews: number;
        talkers: number;
        unresolved: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM feed_item WHERE owner_id=ANY($1)
            AND item_type='recommended' AND active) AS recommendations,
          (SELECT count(*)::int FROM review WHERE owner_id=ANY($1)
            AND rating IS NOT NULL AND body IS NOT NULL) AS reviews,
          (SELECT max(n)::int FROM (SELECT count(DISTINCT author_id) AS n
            FROM comment WHERE author_id=ANY($1) GROUP BY coalesce(feed_item_id,
              review_id,watch_progress_id,title_comment_id,discussion_post_id)) talk) AS talkers,
          (SELECT count(*)::int FROM title t WHERE t.id IN (
            SELECT title_id FROM feed_item WHERE owner_id=ANY($1)
            UNION SELECT title_id FROM review WHERE owner_id=ANY($1))
            AND t.name NOT LIKE 'Catalog %') AS unresolved`,
        [circle],
      )
    ).rows[0];
  const seeded = await content();
  assert.ok(seeded.recommendations >= 2, "demo friends recommend titles");
  assert.ok(seeded.reviews >= 2, "demo friends review titles");
  assert.ok(seeded.talkers >= 3, "a conversation among demo friends");
  assert.equal(seeded.unresolved, 0);
  const feed = await loadScreen(first.id, "/");
  assert.ok(feed.kind === "feed");
  assert.ok(
    feed.conversations.length > 0,
    "the reviewer's feed shows the circle",
  );
  assert.ok(feed.unreadNotifications > 0, "a friend replied to the reviewer");

  // The reviewer changes things; reseeding restores the original circle and
  // leaves real members' data alone.
  const reviewerRecommendation = await updateTitleActivity(
    first.id,
    "movie:1",
    "recommended",
    true,
  );
  await addComment(friends[0].user_id, reviewerRecommendation, "Nice.", false);
  await db.query("UPDATE profile SET display_name='Changed' WHERE user_id=$1", [
    first.id,
  ]);
  assert.equal(
    await seed(""),
    `Seeded the demo circle: review@screenr.club and 3 demo friends.
REVIEW_SIGN_IN_CODE is not six digits, so the reviewer cannot sign in.
`,
  );
  const second = await reviewerAccount();
  assert.notEqual(second.id, first.id);
  assert.equal(
    (await db.query("SELECT 1 FROM profile WHERE user_id=ANY($1)", [circle]))
      .rowCount,
    0,
    "reseeding replaces every demo account",
  );
  const reseeded = [
    second.id,
    ...(await demoFriends(second.id)).map((member) => member.user_id),
  ];
  assert.equal(reseeded.length, circle.length);
  circle.splice(0, circle.length, ...reseeded);
  assert.deepEqual(await content(), seeded);
  assert.notEqual(
    (
      await db.query("SELECT display_name FROM profile WHERE user_id=$1", [
        second.id,
      ])
    ).rows[0].display_name,
    "Changed",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM comment WHERE feed_item_id=$1",
        [real],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await profileFor(alice, "ben")).can_read, true);
});

test("the fixed code signs in only the reviewer, only when configured, and sends no email", async () => {
  await db.query('TRUNCATE "rateLimit", login_code_request');
  await seedDemoCircle();
  const { id } = await reviewerAccount();
  const [demoFriend] = await demoFriends(id);
  const demoEmail = (
    await db.query('SELECT email FROM "user" WHERE id=$1', [demoFriend.user_id])
  ).rows[0].email;
  const member = await person("member");

  const configured = emailCodes(fixedCode);
  const output = await printed(async () => {
    assert.equal((await configured.request(reviewer)).status, 200);
    await assertSignedIn(await configured.signIn(reviewer, fixedCode), id);
  });
  assert.doesNotMatch(output, new RegExp(fixedCode), "the code is not logged");
  assert.equal((await configured.request(demoEmail)).status, 200);
  assert.equal(configured.sent.length, 0, "demo addresses receive no email");
  // Another address gets its own random code; the fixed code fails there.
  assert.equal((await configured.request("member@example.test")).status, 200);
  await assertRejected(
    await configured.signIn("member@example.test", fixedCode),
    400,
    "INVALID_OTP",
  );
  assert.equal(configured.sent.length, 1);
  await assertSignedIn(
    await configured.signIn("member@example.test", configured.sent[0].otp),
    member,
  );

  // Without a configured six-digit code, the reviewer cannot sign in.
  for (const code of [undefined, "", "12345", "abcdef"]) {
    await db.query('TRUNCATE "rateLimit", login_code_request');
    const unconfigured = emailCodes(code);
    assert.equal((await unconfigured.request(reviewer)).status, 200);
    await assertRejected(
      await unconfigured.signIn(reviewer, fixedCode),
      400,
      "INVALID_OTP",
    );
    assert.deepEqual(unconfigured.sent, []);
  }
});

test("the fixed code keeps the attempt and request limits", async () => {
  await db.query('TRUNCATE "rateLimit", login_code_request');
  await seedDemoCircle();
  const { id } = await reviewerAccount();
  const codes = emailCodes(fixedCode);

  // Five wrong attempts use up the requested code, even for the right one.
  assert.equal((await codes.request(reviewer)).status, 200);
  for (let attempt = 0; attempt < 5; attempt++)
    await assertRejected(
      await codes.signIn(reviewer, "000000"),
      400,
      "INVALID_OTP",
    );
  await assertRejected(
    await codes.signIn(reviewer, fixedCode),
    403,
    "TOO_MANY_ATTEMPTS",
  );
  // A code works only after a request, and requests stay limited per address.
  await assertRejected(
    await codes.signIn(reviewer, fixedCode),
    400,
    "INVALID_OTP",
  );
  for (let request = 0; request < 2; request++)
    assert.equal((await codes.request(reviewer)).status, 200);
  const limited = await codes.request(reviewer);
  assert.equal(limited.status, 429);
  assert.equal(
    (await limited.json()).message,
    "Too many codes requested. Try again later, or continue with Google.",
  );
  await assertSignedIn(await codes.signIn(reviewer, fixedCode), id);

  // And per client address.
  await db.query('TRUNCATE "rateLimit", login_code_request');
  for (let request = 0; request < 3; request++)
    assert.equal(
      (await codes.request(`other${request}@example.test`, "192.0.2.47"))
        .status,
      200,
    );
  assert.equal((await codes.request(reviewer, "192.0.2.47")).status, 429);
  assert.deepEqual(codes.sent, []);
});

test("real members cannot see the demo circle, and the reviewer cannot see them", async () => {
  const alice = await person("alice");
  const ben = await person("ben");
  await friend(alice, ben);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Real Movie') ON CONFLICT DO NOTHING",
  );
  const real = await updateTitleActivity(alice, "movie:1", "recommended", true);
  await addComment(ben, real, "A real reply.", false);
  await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  await recordActiveDay(ben, "web");
  await seedDemoCircle();
  const review = await reviewerAccount();
  const friends = await demoFriends(review.id);
  await recordActiveDay(review.id, "ios");
  for (const member of friends) await recordActiveDay(member.user_id, "web");

  // Profiles and friend requests stay out of reach both ways.
  for (const username of [review.username, ...friends.map((f) => f.username)])
    await assert.rejects(profileFor(alice, username), denied.person);
  await assert.rejects(
    changeRelationship(alice, review.id, "request"),
    denied.person,
  );
  await assert.rejects(profileFor(review.id, "alice"), denied.person);
  await assert.rejects(
    changeRelationship(review.id, alice, "request"),
    denied.person,
  );

  // Even a friendship across the boundary shows nothing on either side.
  const [crossing] = friends;
  await db.query(
    `INSERT INTO friendship(low_id,high_id,requested_by,accepted_at)
    VALUES(least($1,$2),greatest($1,$2),$1,now())`,
    [alice, crossing.user_id],
  );
  const circle = new Set([review.id, ...friends.map((f) => f.user_id)]);
  const { connections, suggestions } = await people(alice);
  assert.deepEqual(
    connections.map((member) => member.username),
    ["ben"],
  );
  assert.deepEqual(suggestions, []);
  assert.ok(!(await people(review.id)).suggestions.length);
  const feed = await loadScreen(alice, "/");
  assert.ok(feed.kind === "feed");
  assert.ok(feed.conversations.every((thread) => !circle.has(thread.owner_id)));
  assert.deepEqual(
    (await titleSuggestions(alice)).map((title) => title.id),
    [],
  );
  assert.deepEqual(await friendsRecommend(alice), []);

  // The owner's usage report counts only real members.
  const [week] = await usageReport({ weeks: 1 });
  assert.equal(week.activeMembers, 1);
  assert.equal(week.saves, 1);
  assert.equal(week.conversations, 1);
});

test("joining through a demo invitation joins the demo circle", async () => {
  const alice = await person("alice");
  await seedDemoCircle();
  const review = await reviewerAccount();
  const { token } = await createInvitation(review.id);
  const newcomer = await pending("newcomer", token);
  await completeSignup(newcomer, "Newcomer", "newcomer");
  assert.ok((await profileFor(newcomer, review.username)).accepted_at);
  assert.deepEqual(
    (await people(newcomer)).suggestions
      .map((member) => member.username)
      .sort(),
    (await demoFriends(review.id))
      .map((member) => member.username)
      .filter((username) => username !== "newcomer")
      .sort(),
  );
  await assert.rejects(profileFor(alice, "newcomer"), denied.person);
  await assert.rejects(profileFor(newcomer, "alice"), denied.person);
  // Reseeding resets the whole circle, including people who joined it.
  await seedDemoCircle();
  assert.equal(
    (await db.query('SELECT 1 FROM "user" WHERE id=$1', [newcomer])).rowCount,
    0,
  );
});

test("seeding never replaces an account outside the demo circle", async () => {
  const member = await person("member");
  await db.query('UPDATE "user" SET email=$2 WHERE id=$1', [member, reviewer]);
  await assert.rejects(seedDemoCircle(), /review@screenr\.club/);
  assert.equal(
    (await db.query("SELECT 1 FROM profile WHERE user_id=$1", [member]))
      .rowCount,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM profile")).rows[0].n,
    1,
  );
});

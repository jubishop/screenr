import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

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
const {
  createInvitation,
  completeSignup,
  invitationHash,
  revokeInvitation,
  listInvitations,
} = await import("../../src/server/invitations");
const {
  changeRelationship,
  updateTitleActivity,
  thread,
  addComment,
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
  const { token } = await createInvitation(owner);
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
  assert.equal(same, conversation);
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
test("nested replies stay in one group; only the host removes comments and preserves replies", async () => {
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
  const googleLogin = await post("sign-in/social", social);
  assert.equal((await googleLogin.json()).user.id, emailId);
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,
    2,
  );
});

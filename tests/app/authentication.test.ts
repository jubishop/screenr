import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, person } from "./social-fixture";
const { createAuth } = await import("../../src/server/auth");
const { loadScreen } = await import("../../src/server/screens");
const { createInvitation, completeSignup, revokeInvitation } =
  await import("../../src/server/invitations");
const { profileFor } = await import("../../src/server/social");

useDatabase();

async function accountScreen(userId: string) {
  const screen = await loadScreen(userId, "/account");
  assert.ok(screen.kind === "account");
  return screen;
}

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
  const inviter = await person("inviter");
  const { token } = await createInvitation(inviter, 2);
  const inviteCookie = `screenr-invite=${token}`;
  const googleSignup = await post("sign-in/social", social, inviteCookie);
  assert.equal(googleSignup.status, 200, await googleSignup.clone().text());
  const googleId = (await googleSignup.json()).user.id;
  await completeSignup(googleId, "Google", "google");
  assert.ok((await profileFor(googleId, "inviter")).accepted_at);
  assert.equal((await profileFor(inviter, "google")).can_read, true);
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
  assert.ok((await profileFor(emailId, "inviter")).accepted_at);
  assert.equal((await profileFor(inviter, "emailfirst")).can_read, true);
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
    3,
  );
});

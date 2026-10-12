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

const codeLimitMessage =
  "Too many codes requested. Try again later, or continue with Google.";

function codeRequests(auth: ReturnType<typeof createAuth>) {
  let requests = 0;
  return (
    email: string,
    { token, ip }: { token?: string; ip?: string } = {},
  ) => {
    requests++;
    return auth.handler(
      new Request(
        "http://localhost:3000/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:3000",
            // A new client address per request isolates the per-recipient
            // and Screenr-wide caps from the per-IP limit.
            "X-Forwarded-For":
              ip ??
              `10.0.${Math.floor(requests / 250)}.${(requests % 250) + 1}`,
            ...(token ? { Cookie: `screenr-invite=${token}` } : {}),
          },
          body: JSON.stringify({ email, type: "sign-in" }),
        },
      ),
    );
  };
}

async function moveCodeRequestsBack(interval: string) {
  await db.query(
    "UPDATE login_code_request SET created_at=created_at-$1::interval",
    [interval],
  );
}

async function assertCodeLimited(response: Response) {
  assert.equal(response.status, 429);
  assert.equal((await response.json()).message, codeLimitMessage);
}

test("email code requests are limited to three per IP each minute", async () => {
  await db.query('TRUNCATE "rateLimit", login_code_request');
  const request = codeRequests(
    createAuth({
      sendCode: async () => assert.fail("Uninvited email must not be sent"),
    }),
  );
  let address = 0;
  const fromOneIP = () =>
    request(`rate-limit-${address++}@example.test`, { ip: "192.0.2.10" });
  for (let index = 0; index < 3; index++)
    assert.equal((await fromOneIP()).status, 200);
  const limited = await fromOneIP();
  assert.equal(limited.status, 429);
  const retry = Number(limited.headers.get("X-Retry-After"));
  assert.ok(
    retry > 0 && retry <= 60,
    `Expected at most 60 seconds, got ${retry}`,
  );
  await db.query('UPDATE "rateLimit" SET "lastRequest"=$1', [
    Date.now() - 61_000,
  ]);
  assert.equal((await fromOneIP()).status, 200);
});

test("login codes are limited to three per address each 15 minutes and ten each day", async () => {
  await db.query('TRUNCATE "rateLimit", login_code_request');
  await person("capped");
  const sent: string[] = [];
  const request = codeRequests(
    createAuth({
      sendCode: async ({ email }) => {
        sent.push(email);
      },
    }),
  );
  const member = "capped@example.test";
  for (const email of [member, "Capped@Example.test", member])
    assert.equal((await request(email)).status, 200);
  assert.equal(sent.length, 3);
  await assertCodeLimited(await request(member));
  assert.equal(sent.length, 3, "A capped request must not send a code");
  // Unknown addresses reach the same cap, so it cannot reveal membership.
  for (let index = 0; index < 3; index++)
    assert.equal((await request("stranger@example.test")).status, 200);
  await assertCodeLimited(await request("stranger@example.test"));
  for (const expected of [6, 9, 10]) {
    await moveCodeRequestsBack("15 minutes");
    while (sent.length < expected)
      assert.equal((await request(member)).status, 200);
  }
  await moveCodeRequestsBack("15 minutes");
  await assertCodeLimited(await request(member));
  assert.equal(sent.length, 10);
  await moveCodeRequestsBack("1 day");
  assert.equal((await request(member)).status, 200);
  assert.equal(sent.length, 11);
});

test("the Screenr-wide cap allows 40 login-code emails a day across addresses and IPs", async () => {
  await db.query('TRUNCATE "rateLimit", login_code_request');
  const sent: string[] = [];
  const request = codeRequests(
    createAuth({
      sendCode: async ({ email }) => {
        sent.push(email);
      },
    }),
  );
  const { token } = await createInvitation(null);
  // Requests that send nothing leave the shared allowance unchanged.
  for (let index = 0; index < 5; index++)
    assert.equal((await request(`uninvited${index}@example.test`)).status, 200);
  for (let index = 0; index < 37; index++)
    assert.equal(
      (await request(`guest${index}@example.test`, { token })).status,
      200,
    );
  assert.equal(sent.length, 37);
  const racing = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      request(`racing${index}@example.test`, { token }),
    ),
  );
  for (const response of racing)
    if (response.status !== 200) await assertCodeLimited(response);
  assert.equal(sent.length, 40, "Concurrent requests must not exceed the cap");
  await assertCodeLimited(await request("late@example.test", { token }));
  await person("member");
  await assertCodeLimited(await request("member@example.test"));
  assert.equal(sent.length, 40);
  await moveCodeRequestsBack("1 day");
  assert.equal((await request("member@example.test")).status, 200);
  assert.equal(sent.length, 41);
});

test("Better Auth password routes are disabled", async () => {
  const sent: string[] = [];
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ type }) => {
      sent.push(type ?? "");
    },
  });
  await person("member");
  const body = {
    email: "member@example.test",
    otp: "123456",
    password: "unused-password",
    newPassword: "unused-password",
    currentPassword: "unused-password",
    name: "Member",
    token: "unused-token",
  };
  const post = (path: string, data: unknown = body) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify(data),
      }),
    );
  for (const path of [
    "/email-otp/request-password-reset",
    "/forget-password/email-otp",
    "/email-otp/reset-password",
    "/email-otp/reset-password/",
    "/request-password-reset",
    "/reset-password",
    "/sign-up/email",
    "/sign-in/email",
    "/change-password",
    "/verify-password",
  ])
    assert.equal((await post(path)).status, 404, path);
  assert.equal(
    (
      await post("/email-otp/send-verification-otp", {
        email: body.email,
        type: "forget-password",
      })
    ).status,
    200,
  );
  assert.deepEqual(sent, [], "Screenr has no passwords to reset");
  assert.equal(
    (
      await post("/email-otp/send-verification-otp", {
        email: body.email,
        type: "sign-in",
      })
    ).status,
    200,
  );
  assert.deepEqual(sent, ["sign-in"]);
});

test("a signed-out session request fails while Better Auth cannot use the database schema", async () => {
  // Activation keeps a release only when this request returns null.
  const session = () =>
    createAuth({ rateLimit: false }).handler(
      new Request("http://127.0.0.1:3060/api/auth/get-session"),
    );
  const intact = await session();
  assert.equal(intact.status, 200);
  assert.equal(await intact.text(), "null");
  // Like the issuer column in issue #181: required, but Better Auth never
  // writes it, so its inserts would fail.
  await db.query(`ALTER TABLE account ADD COLUMN schema_probe text NOT NULL DEFAULT '';
    ALTER TABLE account ALTER COLUMN schema_probe DROP DEFAULT`);
  try {
    // The route handler answers HTTP 500 when Better Auth throws.
    await assert.rejects(session(), { code: "SCHEMA_MISMATCH" });
  } finally {
    await db.query("ALTER TABLE account DROP COLUMN schema_probe");
  }
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

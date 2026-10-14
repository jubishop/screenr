import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  useDatabase,
  db,
  denied,
  assertRouteError,
  pending,
  person,
  bearerFor,
  cookieFor,
} from "./social-fixture";
const { createAuth } = await import("../../src/server/auth");
const { createInvitation, completeSignup, revokeInvitation } =
  await import("../../src/server/invitations");
const { profileFor } = await import("../../src/server/profiles");
const { uploadPhoto } = await import("../../src/server/photos");
const { GET, POST } = await import("../../src/app/api/screenr/[action]/route");

useDatabase();

// The iPhone app joins through the API without the web's `screenr-invite`
// cookie (docs/data-and-access.md#invitation-tokens). It sends no Origin and
// no cookies, and names the invitation in the `Screenr-Invitation` header.

const origin = "http://localhost:3000";
const web = { Origin: origin };
const invited = (token: string) => ({ "Screenr-Invitation": token });
const inviteCookie = (token: string) => ({ Cookie: `screenr-invite=${token}` });
type Fields = Record<string, string>;

const invitationRequired = {
  status: 403,
  message: "A valid invitation is required to join Screenr.",
};
async function assertSignupDenied(response: Response) {
  assert.equal(response.status, invitationRequired.status);
  assert.equal((await response.json()).message, invitationRequired.message);
}

const accounts = async () =>
  (await db.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n;
const uses = async (id: string) =>
  (await db.query("SELECT uses FROM invitation WHERE id=$1", [id])).rows[0]
    .uses;

// Better Auth with its code email and Google's identity response replaced.
// Screenr's hooks, sessions, and database remain real.
async function signInMethods() {
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
  const provider = (await auth.$context).socialProviders.find(
    ({ id }) => id === "google",
  );
  assert.ok(provider);
  let googleEmail = "";
  provider.idToken = {
    verify: async (token) => token === "test-verified-token",
  };
  provider.getUserInfo = async () => ({
    user: { email: googleEmail, name: "Google user", emailVerified: true },
    data: { sub: `google-${googleEmail}` },
  });
  const post = (path: string, body: unknown, headers: Fields) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return {
    // Requests a code and returns the one sent, if any. Every request gets
    // the same response, whether or not a code went out.
    async code(email: string, headers: Fields = {}) {
      codes.delete(email);
      const response = await post(
        "email-otp/send-verification-otp",
        { email, type: "sign-in" },
        headers,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true });
      return codes.get(email);
    },
    email: (email: string, otp: string | undefined, headers: Fields = {}) =>
      post("sign-in/email-otp", { email, otp }, headers),
    google(email: string, headers: Fields = {}) {
      googleEmail = email;
      return post(
        "sign-in/social",
        { provider: "google", idToken: { token: "test-verified-token" } },
        headers,
      );
    },
  };
}

// The session token a native sign-in returns.
async function sessionToken(response: Response) {
  assert.equal(response.status, 200, await response.clone().text());
  const token = response.headers.get("set-auth-token");
  assert.ok(token, "A native sign-in returns its session token");
  return { token, userId: (await response.json()).user.id as string };
}

function setup(username: string, headers: Fields) {
  return POST(
    new Request(`${origin}/api/screenr/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name: username, username }),
    }),
    { params: Promise.resolve({ action: "setup" }) },
  );
}

function setupDetails(headers: Fields) {
  return GET(new Request(`${origin}/api/screenr/setup-details`, { headers }), {
    params: Promise.resolve({ action: "setup-details" }),
  });
}

async function assertJoined(userId: string, id: string) {
  assert.equal(await uses(id), 1);
  assert.ok((await profileFor(userId, "inviter")).accepted_at);
}

test("the app joins by email code with its invitation in the Screenr-Invitation header", async () => {
  const methods = await signInMethods();
  const inviter = await person("inviter");
  const { token, id } = await createInvitation(inviter);
  const email = "app@example.test";
  assert.equal(await methods.code(email), undefined);
  // The header must also reach the sign-in that creates the account.
  await assertSignupDenied(
    await methods.email(email, await methods.code(email, invited(token))),
  );
  assert.equal(await accounts(), 1, "Only the inviter has an account");
  const { token: session, userId } = await sessionToken(
    await methods.email(
      email,
      await methods.code(email, invited(token)),
      invited(token),
    ),
  );
  assert.equal(await uses(id), 0);
  const joined = await setup("appuser", {
    Authorization: `Bearer ${session}`,
    ...invited(token),
  });
  assert.equal(joined.status, 200);
  assert.deepEqual(await joined.json(), { ok: true });
  await assertJoined(userId, id);
});

test("the app joins through Google with its invitation in the Screenr-Invitation header", async () => {
  const methods = await signInMethods();
  const inviter = await person("inviter");
  const { token, id } = await createInvitation(inviter);
  await assertSignupDenied(await methods.google("google@example.test"));
  assert.equal(await accounts(), 1, "Only the inviter has an account");
  const { token: session, userId } = await sessionToken(
    await methods.google("google@example.test", invited(token)),
  );
  // Setup without the header uses the invitation the account joined with.
  const joined = await setup("googleuser", {
    Authorization: `Bearer ${session}`,
  });
  assert.equal(joined.status, 200);
  await assertJoined(userId, id);
});

test("setup uses the invitation in the Screenr-Invitation header, and refuses one that is no longer available", async () => {
  const inviter = await person("inviter");
  const original = await createInvitation(inviter);
  const replacement = await createInvitation(inviter);
  const userId = await pending("pat", original.token);
  await revokeInvitation(inviter, original.id);
  const session = { Authorization: `Bearer ${await bearerFor(userId)}` };
  await assertRouteError(
    await setup("pat", session),
    denied.unavailableInvitation,
  );
  await assertRouteError(
    await setup("pat", { ...session, ...invited(original.token) }),
    denied.unavailableInvitation,
  );
  const joined = await setup("pat", {
    ...session,
    ...invited(replacement.token),
  });
  assert.equal(joined.status, 200);
  await assertJoined(userId, replacement.id);
});

test("unknown, expired, revoked, and used-up invitations are refused without revealing which addresses have accounts", async () => {
  const methods = await signInMethods();
  const inviter = await person("inviter");
  await person("member");
  const expired = await createInvitation(inviter);
  await db.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
    expired.id,
  ]);
  const revoked = await createInvitation(inviter);
  await revokeInvitation(inviter, revoked.id);
  const usedUp = await createInvitation(inviter);
  await completeSignup(await pending("guest", usedUp.token), "Guest", "guest");
  const valid = await createInvitation(inviter);
  const userId = await pending("pat", valid.token);
  const session = { Authorization: `Bearer ${await bearerFor(userId)}` };
  const before = await accounts();
  for (const [condition, token] of [
    ["unknown", randomBytes(32).toString("base64url")],
    ["malformed", "not-an-invitation"],
    ["expired", expired.token],
    ["revoked", revoked.token],
    ["used up", usedUp.token],
  ]) {
    // A new address and a member's get the same response; only the member,
    // who reads that inbox, receives a code.
    assert.equal(
      await methods.code("stranger@example.test", invited(token)),
      undefined,
      condition,
    );
    assert.ok(await methods.code("member@example.test", invited(token)));
    await assertSignupDenied(
      await methods.google("stranger@example.test", invited(token)),
    );
    assert.equal(await accounts(), before, condition);
    await assertRouteError(
      await setup("pat", { ...session, ...invited(token) }),
      denied.unavailableInvitation,
    );
  }
  assert.equal(await uses(valid.id), 0);
});

test("setup starts from the account's name, its photo, and whether Google can supply one", async () => {
  const { token } = await createInvitation(await person("inviter"));
  const userId = await pending("pat", token);
  await db.query('UPDATE "user" SET name=$2 WHERE id=$1', [
    userId,
    "Pat Morgan",
  ]);
  const session = { Authorization: `Bearer ${await bearerFor(userId)}` };
  const before = await setupDetails(session);
  assert.equal(before.status, 200);
  assert.equal(before.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await before.json(), {
    userId,
    name: "Pat Morgan",
    photo: null,
    google: false,
  });
  // A Google signup copies its picture before setup.
  const jpeg = Buffer.alloc(3000, 5);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  const { photo } = await uploadPhoto(userId, jpeg);
  await db.query(
    `INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
    VALUES('pat-google','pat-subject','google',$1,now(),now())`,
    [userId],
  );
  assert.deepEqual(await (await setupDetails(session)).json(), {
    userId,
    name: "Pat Morgan",
    photo,
    google: true,
  });
  await assertRouteError(await setupDetails({}), denied.signedOut);
});

// A code request never says whether its invitation counts, so the app asks
// before sign-in, as the web's /join link does.
function checkInvitation(
  auth: ReturnType<typeof createAuth>,
  token: string,
  ip = "192.0.2.20",
) {
  return auth.handler(
    new Request(
      `${origin}/api/auth/invitation?token=${encodeURIComponent(token)}`,
      { headers: { "X-Forwarded-For": ip } },
    ),
  );
}

test("the app asks whether an invitation link can still be used to join", async () => {
  const auth = createAuth({ rateLimit: false });
  const inviter = await person("inviter");
  const valid = await createInvitation(inviter);
  const expired = await createInvitation(inviter);
  await db.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
    expired.id,
  ]);
  const revoked = await createInvitation(inviter);
  await revokeInvitation(inviter, revoked.id);
  const usedUp = await createInvitation(inviter);
  await completeSignup(await pending("guest", usedUp.token), "Guest", "guest");
  for (const [condition, token, available] of [
    ["active", valid.token, true],
    ["unknown", randomBytes(32).toString("base64url"), false],
    ["malformed", "not-an-invitation", false],
    ["empty", "", false],
    ["expired", expired.token, false],
    ["revoked", revoked.token, false],
    ["used up", usedUp.token, false],
  ] as const) {
    const response = await checkInvitation(auth, token);
    assert.equal(response.status, 200, condition);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(await response.json(), { available }, condition);
  }
  // Checking signs no one up and uses nothing.
  assert.equal(await uses(valid.id), 0);
  assert.equal(await accounts(), 2);
});

test("invitation checks are limited to ten per client each minute", async () => {
  await db.query('TRUNCATE "rateLimit"');
  const auth = createAuth();
  const { token } = await createInvitation(await person("inviter"));
  for (let index = 0; index < 10; index++)
    assert.equal((await checkInvitation(auth, token)).status, 200);
  const limited = await checkInvitation(auth, token);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("X-Retry-After")) > 0);
  assert.equal(
    (await checkInvitation(auth, token, "192.0.2.21")).status,
    200,
    "Another client has its own limit",
  );
});

test("web requests keep the invitation cookie and ignore the Screenr-Invitation header", async () => {
  const methods = await signInMethods();
  const inviter = await person("inviter");
  const valid = await createInvitation(inviter);
  const revoked = await createInvitation(inviter);
  await revokeInvitation(inviter, revoked.id);
  const email = "web@example.test";
  // Browsers send an Origin, so only the cookie counts.
  assert.equal(
    await methods.code(email, { ...web, ...invited(valid.token) }),
    undefined,
  );
  await assertSignupDenied(
    await methods.google("webgoogle@example.test", {
      ...web,
      ...invited(valid.token),
    }),
  );
  assert.ok(
    await methods.code(email, {
      ...web,
      ...inviteCookie(valid.token),
      ...invited(revoked.token),
    }),
  );
  // Web setup reads the cookie, not the header.
  const userId = await pending("webuser", revoked.token);
  const cookie = await cookieFor(userId);
  await assertRouteError(
    await setup("webuser", { ...web, Cookie: cookie, ...invited(valid.token) }),
    denied.unavailableInvitation,
  );
  const joined = await setup("webuser", {
    ...web,
    Cookie: `${cookie}; ${inviteCookie(valid.token).Cookie}`,
  });
  assert.equal(joined.status, 200);
  await assertJoined(userId, valid.id);
});

test("a native request's header takes precedence over an invitation cookie, which still counts without one", async () => {
  const inviter = await person("inviter");
  const valid = await createInvitation(inviter);
  const revoked = await createInvitation(inviter);
  await revokeInvitation(inviter, revoked.id);
  const userId = await pending("pat", revoked.token);
  const session = { Authorization: `Bearer ${await bearerFor(userId)}` };
  await assertRouteError(
    await setup("pat", {
      ...session,
      ...inviteCookie(valid.token),
      ...invited(revoked.token),
    }),
    denied.unavailableInvitation,
  );
  // Google's web sign-in callback also arrives without an Origin, carrying
  // only the cookie.
  const joined = await setup("pat", {
    ...session,
    ...inviteCookie(valid.token),
  });
  assert.equal(joined.status, 200);
  await assertJoined(userId, valid.id);
});

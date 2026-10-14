import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  person,
  bearerFor,
  captureFailures,
  assertAuthError,
  invitationRequired,
} from "./social-fixture";
import {
  appleBundleIds,
  fakeApple,
  fakeGoogle,
  serve,
} from "./identity-providers";
const { createAuth } = await import("../../src/server/auth");
const { revokeAppleTokens } = await import("../../src/server/apple");
const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");
const { profileFor } = await import("../../src/server/profiles");

useDatabase();

// Native sign-in from the iPhone app: docs/data-and-access.md#native-sign-in.
// Fake Apple and Google servers replace only the network; Better Auth's token
// verification, Screenr's hooks, sessions, and the database are real.

const origin = "http://localhost:3000";

// Sets provider settings for one test.
function configure(t: TestContext, settings: Record<string, string>) {
  Object.assign(process.env, settings);
  t.after(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
    mock.restoreAll();
  });
}

// The iPhone app sends neither an Origin nor cookies. A signup names its
// invitation in the Screenr-Invitation header
// (docs/data-and-access.md#invitation-tokens).
function client(auth: ReturnType<typeof createAuth>) {
  return (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
}
const invited = (token: string) => ({ "Screenr-Invitation": token });

const userCount = async () =>
  (await db.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n;
const storedAppleToken = async (userId: string): Promise<string | null> =>
  (
    await db.query(
      `SELECT "refreshToken" FROM account WHERE "userId"=$1 AND "providerId"='apple'`,
      [userId],
    )
  ).rows[0]?.refreshToken ?? null;
const now = () => Math.floor(Date.now() / 1000);

// What the app posts after AuthenticationServices returns a credential. Apple
// includes the person's name only on the first authorization.
function appleSignIn(
  authorization: { token: string; code?: string },
  {
    nonce,
    name,
  }: { nonce?: string; name?: { firstName: string; lastName: string } } = {},
) {
  return {
    provider: "apple",
    idToken: {
      token: authorization.token,
      ...(nonce && { nonce }),
      ...(name && { user: { name } }),
    },
    ...(authorization.code && {
      additionalData: { authorizationCode: authorization.code },
    }),
  };
}

test("Sign in with Apple joins only with an invitation, returns a bearer token natively, and keeps a revocable refresh token", async (t) => {
  const apple = fakeApple();
  configure(t, apple.env());
  serve(apple);
  const auth = createAuth({ rateLimit: false });
  const post = client(auth);
  const relay = "x7k2p9qd4m@privaterelay.appleid.com";
  const nonce = "raw-app-nonce";
  const name = { firstName: "Apple", lastName: "Member" };
  const authorize = () =>
    apple.authorize({ sub: "apple-member", email: relay, nonce });

  // Without an invitation, nothing is created and the code is not exchanged,
  // so Screenr keeps no Apple token for someone who is not a member.
  await assertAuthError(
    await post("sign-in/social", appleSignIn(authorize(), { nonce, name })),
    403,
    invitationRequired,
  );
  await assertAuthError(
    await post(
      "sign-in/social",
      appleSignIn(authorize(), { nonce, name }),
      invited("unknown-invitation-token-0000000000000000000"),
    ),
    403,
    invitationRequired,
  );
  assert.equal(await userCount(), 0);
  assert.equal(apple.exchanged.length, 0);

  const inviter = await person("inviter");
  const { token } = await createInvitation(inviter, 2);
  const signup = await post(
    "sign-in/social",
    appleSignIn(authorize(), { nonce, name }),
    invited(token),
  );
  assert.equal(signup.status, 200, await signup.clone().text());
  assert.ok(signup.headers.get("set-auth-token"));
  const { user } = await signup.json();
  // A Hide My Email relay address is stored like any other address.
  assert.equal(user.email, relay);
  assert.equal(user.name, "Apple Member");
  await completeSignup(user.id, "Apple Member", "applemember");
  assert.ok((await profileFor(user.id, "inviter")).accepted_at);
  const sealed = await storedAppleToken(user.id);
  assert.equal(apple.exchanged.length, 1);
  assert.ok(sealed);
  assert.ok(
    !sealed.includes(apple.exchanged[0]!.refreshToken),
    "The refresh token is stored encrypted",
  );

  // Later sign-ins come from the app without an Origin and without the name.
  // Each one returns a bearer token and keeps the newest refresh token.
  const signin = await post(
    "sign-in/social",
    appleSignIn(authorize(), { nonce }),
  );
  assert.equal(signin.status, 200, await signin.clone().text());
  assert.equal((await signin.json()).user.id, user.id);
  const bearer = signin.headers.get("set-auth-token");
  assert.ok(bearer, "Native sign-in returns a set-auth-token header");
  const session = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${bearer}` }),
  });
  assert.equal(session?.user.id, user.id);
  assert.equal(session?.user.name, "Apple Member");
  assert.equal(apple.exchanged.length, 2);
  assert.notEqual(await storedAppleToken(user.id), sealed);

  // Account deletion revokes the newest token for the app it was issued to.
  await revokeAppleTokens(user.id);
  assert.deepEqual(apple.revoked, [
    {
      clientId: appleBundleIds.release,
      token: apple.exchanged[1]!.refreshToken,
    },
  ]);
  assert.equal(await storedAppleToken(user.id), null);
  await revokeAppleTokens(user.id);
  assert.equal(apple.revoked.length, 1);
});

test("Sign in with Apple accepts the Dev app and links an existing account only from its own session", async (t) => {
  const apple = fakeApple();
  configure(t, apple.env());
  serve(apple);
  const post = client(createAuth({ rateLimit: false }));
  const member = await person("member");
  const fromDev = () =>
    apple.authorize({
      sub: "apple-dev",
      email: "member@example.test",
      clientId: appleBundleIds.dev,
    });

  // A matching email address alone does not link the Apple ID.
  await assertAuthError(
    await post("sign-in/social", appleSignIn(fromDev())),
    401,
    { code: "OAUTH_LINK_ERROR" },
  );
  assert.equal(apple.exchanged.length, 0);
  const session = { Authorization: `Bearer ${await bearerFor(member)}` };
  // Like every Apple sign-in, a link needs a code that Apple confirms.
  const { token } = fromDev();
  await assertAuthError(
    await post("link-social", appleSignIn({ token }), session),
    417,
    { code: "LINKING_FAILED" },
  );
  assert.equal(await storedAppleToken(member), null);
  const linked = await post("link-social", appleSignIn(fromDev()), session);
  assert.equal(linked.status, 200, await linked.clone().text());
  const signin = await post("sign-in/social", appleSignIn(fromDev()));
  assert.equal(signin.status, 200, await signin.clone().text());
  assert.equal((await signin.json()).user.id, member);
  assert.ok(signin.headers.get("set-auth-token"));
  assert.equal(await userCount(), 1);
  assert.deepEqual(
    apple.exchanged.map(({ clientId }) => clientId),
    [appleBundleIds.dev, appleBundleIds.dev],
  );

  // When Apple rejects the client secret, revocation fails and keeps the
  // token, so deletion can retry once the key is fixed.
  apple.rotateKey();
  const stored = await storedAppleToken(member);
  await assert.rejects(revokeAppleTokens(member), {
    message: "Apple did not revoke the Sign in with Apple token (HTTP 400).",
  });
  assert.equal(await storedAppleToken(member), stored);
  process.env.APPLE_PRIVATE_KEY = apple.env().APPLE_PRIVATE_KEY;
  await revokeAppleTokens(member);
  assert.deepEqual(apple.revoked, [
    { clientId: appleBundleIds.dev, token: apple.exchanged[1]!.refreshToken },
  ]);
});

test("Sign in with Apple rejects other apps, expired tokens, wrong nonces, and codes Apple does not confirm", async (t) => {
  const apple = fakeApple();
  configure(t, apple.env());
  serve(apple);
  const post = client(createAuth({ rateLimit: false }));
  const { token } = await createInvitation(await person("inviter"), 10);
  const headers = invited(token);
  const email = "new@example.test";
  const attempt = (
    authorization: { token: string; code?: string },
    options?: { nonce?: string },
  ) => post("sign-in/social", appleSignIn(authorization, options), headers);

  for (const authorization of [
    apple.authorize({ sub: "new", email, clientId: "com.example.Other" }),
    apple.authorize({
      sub: "new",
      email,
      claims: { iat: now() - 660, exp: now() - 60 },
    }),
  ])
    await assertAuthError(await attempt(authorization), 401, {
      code: "INVALID_TOKEN",
    });
  await assertAuthError(
    await attempt(apple.authorize({ sub: "new", email, nonce: "app-nonce" }), {
      nonce: "other-nonce",
    }),
    401,
    { code: "INVALID_TOKEN" },
  );
  assert.equal(apple.exchanged.length, 0);

  // A verified token still needs the code from the same authorization.
  const { token: idToken } = apple.authorize({ sub: "new", email });
  await assertAuthError(await attempt({ token: idToken }), 400, {
    message: "Sign in with Apple needs its authorization code.",
  });
  const notConfirmed = {
    message: "Apple did not confirm this sign-in. Try again.",
  };
  await assertAuthError(
    await attempt({ token: idToken, code: "c.unknown" }),
    401,
    notConfirmed,
  );
  const someoneElse = apple.authorize({ sub: "someone-else", email });
  await assertAuthError(
    await attempt({ token: idToken, code: someoneElse.code }),
    401,
    notConfirmed,
  );

  apple.setUnavailable(true);
  const failures = captureFailures();
  await assertAuthError(
    await attempt(apple.authorize({ sub: "new", email })),
    503,
    {
      message: "Sign in with Apple is unavailable right now. Try again later.",
    },
  );
  assert.deepEqual(
    failures.map((line) => JSON.parse(line)),
    [{ event: "apple_token_failed", status: 503 }],
  );
  assert.equal(await userCount(), 1, "Only the inviter has an account");

  // The web has no Sign in with Apple.
  await assertAuthError(
    await post("sign-in/social", { provider: "apple" }, { Origin: origin }),
    404,
    { message: "Sign in with Apple is available only in the iPhone app." },
  );
});

test("Without Apple settings, Apple sign-in is unavailable and revocation has nothing to do", async (t) => {
  const apple = fakeApple();
  configure(t, {});
  serve(apple);
  const post = client(createAuth({ rateLimit: false }));
  await assertAuthError(
    await post(
      "sign-in/social",
      appleSignIn(apple.authorize({ sub: "new", email: "new@example.test" })),
    ),
    404,
    { code: "PROVIDER_NOT_FOUND" },
  );
  await revokeAppleTokens(await person("member"));
  assert.equal(apple.revoked.length, 0);
});

test("Google ID tokens for the iPhone app's client sign in natively; other audiences and expired tokens are rejected", async (t) => {
  const google = fakeGoogle();
  const web = "web-client.apps.googleusercontent.com";
  const ios = "ios-client.apps.googleusercontent.com";
  configure(t, {
    GOOGLE_CLIENT_ID: web,
    GOOGLE_CLIENT_SECRET: "web-secret",
    GOOGLE_IOS_CLIENT_ID: ios,
  });
  serve(google);
  const post = client(createAuth({ rateLimit: false }));
  const email = "phone@example.test";
  const googleSignIn = (
    claims: Record<string, unknown> = {},
    nonce?: string,
  ) => ({
    provider: "google",
    idToken: {
      token: google.idToken({
        sub: "google-phone",
        email,
        aud: ios,
        ...claims,
      }),
      ...(nonce && { nonce }),
    },
  });

  // A valid token reaches the same invitation rule as every other signup.
  await assertAuthError(
    await post("sign-in/social", googleSignIn()),
    403,
    invitationRequired,
  );
  const { token } = await createInvitation(await person("inviter"), 1);
  const signup = await post("sign-in/social", googleSignIn(), invited(token));
  assert.equal(signup.status, 200, await signup.clone().text());
  const { user } = await signup.json();
  await completeSignup(user.id, "Phone", "phone");

  // The app's own nonce must match exactly when it sends one.
  const native = await post(
    "sign-in/social",
    googleSignIn({ nonce: "app-nonce" }, "app-nonce"),
  );
  assert.equal(native.status, 200, await native.clone().text());
  assert.equal((await native.json()).user.id, user.id);
  assert.ok(native.headers.get("set-auth-token"));
  const fromWeb = await post("sign-in/social", googleSignIn({ aud: web }), {
    Origin: origin,
  });
  assert.equal(fromWeb.status, 200, await fromWeb.clone().text());
  assert.equal(fromWeb.headers.get("set-auth-token"), null);

  for (const [claims, nonce] of [
    [{ aud: "other-client.apps.googleusercontent.com" }],
    [{ iat: now() - 660, exp: now() - 60 }],
    [{ iss: "https://issuer.example.test" }],
    [{ nonce: "app-nonce" }, "other-nonce"],
  ] as const)
    await assertAuthError(
      await post("sign-in/social", googleSignIn(claims, nonce)),
      401,
      { code: "INVALID_TOKEN" },
    );

  // Each client ID enables its own audience.
  delete process.env.GOOGLE_IOS_CLIENT_ID;
  await assertAuthError(
    await client(createAuth({ rateLimit: false }))(
      "sign-in/social",
      googleSignIn(),
    ),
    401,
    { code: "INVALID_TOKEN" },
  );
  process.env.GOOGLE_IOS_CLIENT_ID = ios;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const iosOnly = await client(createAuth({ rateLimit: false }))(
    "sign-in/social",
    googleSignIn(),
  );
  assert.equal(iosOnly.status, 200, await iosOnly.clone().text());
  assert.equal((await iosOnly.json()).user.id, user.id);
});

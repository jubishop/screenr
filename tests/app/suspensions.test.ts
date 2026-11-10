import { test, afterEach, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  assertAuthError,
  assertRouteError,
  bearerFor,
  captureFailures,
  clientAddress,
  cookieFor,
  denied,
  friend,
  invitationRequired,
  pending,
  person,
  setup,
  signIn,
} from "./social-fixture";
import {
  appleBundleIds,
  fakeApple,
  fakeGoogle,
  serve,
} from "./identity-providers";
import { suspendedCode, suspendedMessage } from "../../src/shared";

const { POST: action } =
  await import("../../src/app/api/screenr/[action]/route");
const { POST: review } = await import("../../src/app/api/reports/route");
const { createAuth } = await import("../../src/server/auth");
const { loadScreen } = await import("../../src/server/screens");
const { profileFor } = await import("../../src/server/profiles");
const { notifications } = await import("../../src/server/notifications");
const { createDiscussionPost, createTitleComment, addComment } =
  await import("../../src/server/comments");
const { saveReview } = await import("../../src/server/reviews");
const { setReaction } = await import("../../src/server/reactions");
const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");
const { uploadPhoto, viewablePhoto } = await import("../../src/server/photos");
const { changeRelationship } = await import("../../src/server/relationships");
const { changePushDevice } = await import("../../src/server/push");
const { activeInvitation, completeSignup, createInvitation, invitationHash } =
  await import("../../src/server/invitations");
const { liftSuspension, pendingReports, reportContent, reviewReport } =
  await import("../../src/server/reports");
const { suspend, suspendedMembers } =
  await import("../../src/server/suspensions");
const { redeleteAccounts } = await import("../../src/server/account-deletion");

useDatabase();
afterEach(() => mock.restoreAll());

// The owner's suspension of a member (docs/data-and-access.md#member-suspension).

const origin = "http://localhost:3000";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const refused = { message: suspendedMessage, code: suspendedCode };

// A member whose account email SCREENR_OWNER_EMAIL names, for one test.
async function owner(t: TestContext) {
  process.env.SCREENR_OWNER_EMAIL = "owner@example.test";
  t.after(() => delete process.env.SCREENR_OWNER_EMAIL);
  return person("owner");
}

// Has `reporter` report `author`'s profile and the owner suspend them from
// that report, which stays open.
async function suspendFromReport(
  ownerId: string,
  reporter: string,
  author: string,
) {
  await reportContent(reporter, { person: author, reason: "harassment" });
  const report = (await pendingReports()).find(
    (item) => item.author.user_id === author && !item.author.suspended,
  )!;
  await reviewReport(ownerId, report.id, "suspend");
  return report.id;
}

function post(path: string, data: unknown, headers: Record<string, string>) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
}
const act = (cookie: string, data: unknown, from = origin) =>
  review(post("/api/reports", data, { Cookie: cookie, Origin: from }), {});
// An action from the web, with a cookie, or from the iPhone app, with a
// bearer token and no Origin.
const send = (headers: Record<string, string>, name: string, data: unknown) =>
  action(post(`/api/screenr/${name}`, data, headers), {
    params: Promise.resolve({ action: name }),
  });
const web = (cookie: string) => ({ Cookie: cookie, Origin: origin });
const native = (token: string) => ({ Authorization: `Bearer ${token}` });

const count = async (sql: string, values: unknown[] = []) =>
  (await db.query<{ n: number }>(sql, values)).rows[0].n;
const sessions = (userId: string) =>
  count('SELECT count(*)::int AS n FROM session WHERE "userId"=$1', [userId]);
const devices = (userId: string) =>
  count("SELECT count(*)::int AS n FROM push_device WHERE user_id=$1", [
    userId,
  ]);
const users = () => count('SELECT count(*)::int AS n FROM "user"');

// Registers a phone on the member's newest session.
async function registerDevice(userId: string, tag: string) {
  const session = (
    await db.query<{ id: string }>(
      'SELECT id FROM session WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1',
      [userId],
    )
  ).rows[0].id;
  await changePushDevice(userId, session, {
    action: "register",
    token: tag.repeat(32),
    environment: "sandbox",
    topic: "com.artisanalsoftware.Screenr.dev",
    build: 1,
  });
}

// An auth instance that emails codes to `codes`, as the app and the web
// reach it.
function authClient(codes: Map<string, string>) {
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ email, otp }) => {
      codes.set(email, otp);
    },
  });
  const request = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => auth.handler(post(`/api/auth/${path}`, body, headers));
  return { auth, request };
}

// Requests a code for `email` and signs in with it.
async function signInWithCode(
  request: ReturnType<typeof authClient>["request"],
  codes: Map<string, string>,
  email: string,
  headers: Record<string, string> = {},
) {
  codes.delete(email);
  const sent = await request(
    "email-otp/send-verification-otp",
    { email, type: "sign-in" },
    headers,
  );
  assert.equal(sent.status, 200);
  assert.ok(codes.get(email), `A code was sent to ${email}`);
  return request(
    "sign-in/email-otp",
    { email, otp: codes.get(email) },
    headers,
  );
}

test("suspending a member ends every session, on the web and in the app, with its push devices", async (t) => {
  const { alice, ben, cam } = await setup();
  const ownerId = await owner(t);
  const cookie = await cookieFor(ben);
  const token = await bearerFor(ben);
  await registerDevice(ben, "cd");
  const aliceCookie = await cookieFor(alice);
  assert.equal(await sessions(ben), 2);
  assert.equal(await devices(ben), 1);
  for (const headers of [web(cookie), native(token)])
    assert.equal(
      (await send(headers, "report", { person: alice, reason: "spam" })).status,
      200,
    );

  const reportId = await suspendFromReport(ownerId, alice, ben);

  assert.equal(await sessions(ben), 0);
  assert.equal(await devices(ben), 0);
  for (const headers of [web(cookie), native(token)])
    await assertRouteError(
      await send(headers, "report", { person: alice, reason: "other" }),
      denied.signedOut,
    );
  // Other members stay signed in, and the report stays open for Remove or
  // Dismiss.
  assert.equal(await sessions(alice), 1);
  assert.equal(
    (await send(web(aliceCookie), "report", { person: cam, reason: "spam" }))
      .status,
    200,
  );
  const [open] = (await pendingReports()).filter(
    (report) => report.author.user_id === ben,
  );
  assert.equal(open.id, reportId);
  assert.equal(open.author.suspended, true);
  assert.deepEqual(
    (await suspendedMembers()).map(({ user_id, username }) => ({
      user_id,
      username,
    })),
    [{ user_id: ben, username: "ben" }],
  );
});

test("a suspended member's email code sign-in is refused on the web and in the app, until the suspension is lifted", async (t) => {
  const { alice, ben } = await setup();
  const ownerId = await owner(t);
  await suspendFromReport(ownerId, alice, ben);
  const codes = new Map<string, string>();
  const { request } = authClient(codes);

  const clients: Record<string, string>[] = [{ Origin: origin }, {}];
  for (const headers of clients) {
    const response = await signInWithCode(
      request,
      codes,
      "ben@example.test",
      headers,
    );
    await assertAuthError(response, 403, refused);
    assert.equal(response.headers.get("set-auth-token"), null);
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
  assert.equal(await sessions(ben), 0);

  await liftSuspension(ownerId, ben);
  assert.equal((await signIn(ben, { Origin: origin })).status, 200);
  assert.equal(await sessions(ben), 1);
});

test("a suspended member's Google and Apple sign-ins are refused in the app and on the web", async (t) => {
  const google = fakeGoogle();
  const apple = fakeApple();
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: google.webClient.id,
    GOOGLE_CLIENT_SECRET: google.webClient.secret,
    ...apple.env(),
  });
  t.after(() => {
    for (const name of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      ...Object.keys(apple.env()),
    ])
      delete process.env[name];
  });
  serve(google, apple);
  const { alice, ben } = await setup();
  const ownerId = await owner(t);
  const { auth, request } = authClient(new Map());
  const googleToken = () => ({
    provider: "google",
    idToken: {
      token: google.idToken({
        sub: "ben-google",
        email: "ben@example.test",
        aud: google.webClient.id,
      }),
    },
  });
  const appleToken = () => {
    const { token, code } = apple.authorize({
      sub: "ben-apple",
      email: "ben@example.test",
      clientId: appleBundleIds.dev,
    });
    return {
      provider: "apple",
      idToken: { token },
      additionalData: { authorizationCode: code },
    };
  };
  // Ben connects both while signed in.
  const session = native(await bearerFor(ben));
  for (const body of [googleToken(), appleToken()]) {
    const linked = await request("link-social", body, session);
    assert.equal(linked.status, 200, await linked.clone().text());
  }
  for (const body of [googleToken(), appleToken()])
    assert.equal((await request("sign-in/social", body)).status, 200);

  await suspendFromReport(ownerId, alice, ben);

  for (const body of [googleToken(), appleToken()]) {
    const response = await request("sign-in/social", body);
    await assertAuthError(response, 403, refused);
    assert.equal(response.headers.get("set-auth-token"), null);
  }

  // The web's Google sign-in returns to the sign-in page with the code,
  // which shows the message. Google's side is replaced; Better Auth's state,
  // callback, and session creation are real.
  const provider = (await auth.$context).socialProviders.find(
    (item) => item.id === "google",
  )!;
  provider.validateAuthorizationCode = async () => ({
    accessToken: "google-access",
  });
  provider.getUserInfo = async () => ({
    user: {
      email: "ben@example.test",
      name: "Ben",
      emailVerified: true,
    },
    data: { sub: "ben-google" },
  });
  const started = await request(
    "sign-in/social",
    {
      provider: "google",
      callbackURL: "/setup",
      errorCallbackURL: "/login",
      disableRedirect: true,
    },
    { Origin: origin },
  );
  assert.equal(started.status, 200, await started.clone().text());
  const state = new URL((await started.json()).url).searchParams.get("state");
  const cookie = started.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const callback = await auth.handler(
    new Request(
      `${origin}/api/auth/callback/google?state=${state}&code=google-code`,
      { headers: { Cookie: cookie } },
    ),
  );
  assert.equal(callback.status, 302);
  const location = new URL(callback.headers.get("location")!, origin);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("error"), suspendedCode);
  assert.ok(
    !callback.headers
      .getSetCookie()
      .some((value) => value.startsWith("better-auth.session_token=")),
  );
  assert.equal(await sessions(ben), 0);
});

test("a new session for a suspended member is refused even when sign-in checked before the suspension committed", async (t) => {
  const { alice, ben } = await setup();
  await owner(t);
  const insert = (id: string) =>
    db.query(
      `INSERT INTO session(id,"expiresAt",token,"createdAt","updatedAt","userId")
      VALUES($1,now()+interval '1 day',$1,now(),now(),$2)`,
      [id, ben],
    );
  // The suspension holds Ben's account while it commits, so a session
  // started meanwhile waits for it and then sees it.
  const holder = await db.connect();
  try {
    await holder.query("BEGIN");
    await suspend(holder, ben);
    const late = insert("late-session");
    const outcome = late.then(
      () => "inserted",
      (error: { code?: string }) => error.code,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await holder.query("COMMIT");
    assert.equal(await outcome, "42501");
  } finally {
    holder.release();
  }
  await assert.rejects(insert("later-session"), { code: "42501" });
  assert.equal(await sessions(ben), 0);
  // Others still sign in.
  assert.equal((await signIn(alice, {})).status, 200);
});

test("a suspended member's email can't sign up again through an invitation, and their own invitations can't be used", async (t) => {
  const { alice, ben } = await setup();
  const ownerId = await owner(t);
  const { token: bens } = await createInvitation(ben, 3);
  const { token: alices } = await createInvitation(alice, 3);
  await suspendFromReport(ownerId, alice, ben);
  const codes = new Map<string, string>();
  const { request } = authClient(codes);
  const before = await users();

  // With a valid invitation, from the web and from the app, the address
  // still reaches only Ben's account, which is refused.
  const invited: Record<string, string>[] = [
    { Origin: origin, Cookie: `screenr-invite=${alices}` },
    { "Screenr-Invitation": alices },
  ];
  for (const headers of invited)
    await assertAuthError(
      await signInWithCode(request, codes, "ben@example.test", headers),
      403,
      refused,
    );
  assert.equal(await users(), before);

  // Ben's own invitation stops working for anyone new.
  assert.equal(await activeInvitation(invitationHash(bens)), undefined);
  const available = await createAuth({ rateLimit: false }).handler(
    new Request(`${origin}/api/auth/invitation?token=${bens}`, {
      headers: clientAddress,
    }),
  );
  assert.deepEqual(await available.json(), { available: false });
  codes.clear();
  assert.equal(
    (
      await request(
        "email-otp/send-verification-otp",
        { email: "newcomer@example.test", type: "sign-in" },
        { "Screenr-Invitation": bens },
      )
    ).status,
    200,
  );
  assert.equal(codes.size, 0, "No code is sent for an unusable invitation");
  const joining = await pending("joining", bens);
  await assert.rejects(
    completeSignup(joining, "Joining", "joining"),
    denied.unavailableInvitation,
  );

  await liftSuspension(ownerId, ben);
  assert.ok(await activeInvitation(invitationHash(bens)));
  await completeSignup(joining, "Joining", "joining");
  assert.ok((await profileFor(ben, "joining")).accepted_at);
  const response = await signInWithCode(
    request,
    codes,
    "newcomer@example.test",
    { "Screenr-Invitation": bens },
  );
  assert.equal(response.status, 200, await response.clone().text());
});

// What a member sees of everyone: their screens, notifications, and a
// suspended member's photo.
async function view(viewer: string, photoOwner: string, version: string) {
  const screens: Record<string, unknown> = {};
  for (const path of [
    "/",
    "/people",
    "/people/cam",
    "/search",
    "/titles/movie/1",
  ])
    screens[path] = await loadScreen(viewer, path);
  return {
    screens,
    notifications: await notifications(viewer),
    photo: !!(await viewablePhoto(viewer, photoOwner, version, {
      image: false,
    })),
  };
}

test("suspension hides everything a member wrote and their profile from everyone, and lifting restores all of it", async (t) => {
  const { alice, ben, cam } = await setup();
  const ownerId = await owner(t);
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, cam);
  const { photo: version } = await uploadPhoto(ben, jpeg);
  // Ben's own entries of every kind.
  const bensPost = await createDiscussionPost(ben, "Ben's post", false);
  await createTitleComment(ben, "movie:1", "Ben's title comment", false);
  await saveReview(ben, "movie:1", 4, "Ben's review", false);
  await updateTitleActivity(ben, "movie:1", "recommended", true);
  for (const id of ["movie:2", "tv:3"])
    await db.query(
      "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,$2,$3,$1)",
      [id, id.split(":")[0], Number(id.split(":")[1])],
    );
  await updateWatchStatus(ben, "movie:2", "want_to_watch");
  await updateWatchStatus(ben, "tv:3", "watching");
  // Ben's replies and reactions on Alice's and Cam's posts.
  const alicesPost = await createDiscussionPost(alice, "Alice's post", false);
  await addComment(ben, alicesPost, "Ben's reply to Alice", false);
  await setReaction(ben, alicesPost, null, "like");
  const camsPost = await createDiscussionPost(cam, "Cam's post", false);
  await addComment(ben, camsPost, "Ben's reply to Cam", false);
  // Alice's phone shows her unread count.
  await bearerFor(alice);
  await registerDevice(alice, "ab");
  await db.query("DELETE FROM push_job");

  const shown = {
    alice: await view(alice, ben, version),
    cam: await view(cam, ben, version),
  };
  const text = JSON.stringify(shown.alice);
  for (const value of [ben, "Ben's post", "Ben's review", "Ben's reply"])
    assert.ok(text.includes(value), value);
  // Every kind of Ben's entries shows in Alice's feed; the Recommend joins
  // the review's card.
  type Card = {
    owner_id: string;
    item_type: string;
    combined: { item_type: string }[];
  };
  const kinds = (screen: unknown) =>
    (screen as { conversations: Card[] }).conversations
      .filter((item) => item.owner_id === ben)
      .flatMap((item) => [
        item.item_type,
        ...item.combined.map((entry) => entry.item_type),
      ])
      .sort();
  assert.deepEqual(kinds(shown.alice.screens["/"]), [
    "comment",
    "post",
    "progress",
    "recommended",
    "review",
    "want_to_watch",
  ]);
  assert.equal(shown.alice.photo, true);
  assert.ok(shown.alice.notifications.unread > 0);

  await suspendFromReport(ownerId, alice, ben);

  for (const viewer of [alice, cam]) {
    const hidden = await view(viewer, ben, version);
    const seen = JSON.stringify(hidden);
    for (const value of [ben, '"ben"', "Ben's"])
      assert.ok(!seen.includes(value), `${viewer} still sees ${value}`);
    assert.equal(hidden.photo, false);
    await assert.rejects(profileFor(viewer, "ben"), denied.person);
  }
  // Alice's count dropped, so her phone's badge updates.
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM push_job WHERE notification_id IS NULL",
    ),
    1,
  );
  // Nobody can reply to, react to, or befriend Ben meanwhile.
  await assert.rejects(
    addComment(alice, bensPost, "Hello?", false),
    denied.conversation,
  );
  await assert.rejects(
    setReaction(alice, bensPost, null, "like"),
    denied.conversation,
  );
  await assert.rejects(changeRelationship(cam, ben, "request"), denied.person);

  await liftSuspension(ownerId, ben);
  assert.deepEqual(await view(alice, ben, version), shown.alice);
  assert.deepEqual(await view(cam, ben, version), shown.cam);
});

test("suspension keeps a member's blocks, friendships, and data, and hides them from the people who blocked them", async (t) => {
  const { alice, ben, cam } = await setup();
  const ownerId = await owner(t);
  await friend(ben, cam);
  await changeRelationship(alice, ben, "block");
  const blocked = async () =>
    (await loadScreen(alice, "/people")) as { blocked?: { user_id: string }[] };
  assert.deepEqual(
    (await blocked()).blocked?.map((person) => person.user_id),
    [ben],
  );
  await suspendFromReport(ownerId, cam, ben);
  assert.deepEqual((await blocked()).blocked, []);
  const kept = await count(
    `SELECT (SELECT count(*) FROM friendship WHERE $1 IN (low_id,high_id))
      +(SELECT count(*) FROM block WHERE blocked_id=$1)
      +(SELECT count(*) FROM profile WHERE user_id=$1)::int AS n`,
    [ben],
  );
  assert.equal(kept, 3);
  await liftSuspension(ownerId, ben);
  assert.deepEqual(
    (await blocked()).blocked?.map((person) => person.user_id),
    [ben],
  );
  assert.ok((await profileFor(cam, "ben")).accepted_at);
});

test("only the owner suspends and lifts, never their own account, through the review route", async (t) => {
  const { alice, ben } = await setup();
  const ownerId = await owner(t);
  await reportContent(alice, { person: ben, reason: "spam" });
  await reportContent(alice, { person: ownerId, reason: "spam" });
  const [ownReport, benReport] = await pendingReports();
  assert.equal(ownReport.author.user_id, ownerId);
  const ownerCookie = await cookieFor(ownerId);
  const memberCookie = await cookieFor(alice);

  // Other members, and requests from other sites, get nothing.
  for (const data of [
    { report: benReport.id, action: "suspend" },
    { member: ben, action: "lift" },
  ])
    await assertRouteError(await act(memberCookie, data), {
      status: 404,
      message: "Page not found.",
    });
  await assertRouteError(
    await act(
      ownerCookie,
      { report: benReport.id, action: "suspend" },
      "https://evil.example",
    ),
    denied.origin,
  );
  await assertRouteError(
    await act(ownerCookie, { report: ownReport.id, action: "suspend" }),
    { status: 400, message: "You can’t suspend your own account." },
  );
  await assertRouteError(
    await act(ownerCookie, { member: ben, action: "lift" }),
    { status: 404, message: "Suspension not found." },
  );
  assert.deepEqual(await suspendedMembers(), []);

  assert.equal(
    (await act(ownerCookie, { report: benReport.id, action: "suspend" }))
      .status,
    200,
  );
  // Suspending again changes nothing.
  assert.equal(
    (await act(ownerCookie, { report: benReport.id, action: "suspend" }))
      .status,
    200,
  );
  assert.equal((await suspendedMembers()).length, 1);
  const lifted = await act(ownerCookie, { member: ben, action: "lift" });
  assert.equal(lifted.status, 200);
  assert.deepEqual(await lifted.json(), { ok: true });
  assert.deepEqual(await suspendedMembers(), []);
  await assertRouteError(
    await act(ownerCookie, { member: ben, action: "lift" }),
    { status: 404, message: "Suspension not found." },
  );
  // The report is still open for Remove or Dismiss.
  await reviewReport(ownerId, benReport.id, "dismiss");
  assert.deepEqual(
    (await pendingReports()).map((report) => report.id),
    [ownReport.id],
  );
});

test("a suspension goes with the member's account", async (t) => {
  const { alice, ben } = await setup();
  const ownerId = await owner(t);
  await suspendFromReport(ownerId, alice, ben);
  assert.equal(await redeleteAccounts([ben]), 1);
  assert.deepEqual(await suspendedMembers(), []);
});

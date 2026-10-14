import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  useDatabase,
  db,
  denied,
  assertRouteError,
  pending,
  person,
  friend,
  cookieFor,
  bearerFor,
  captureFailures,
} from "./social-fixture";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { GET: photoRoute } =
  await import("../../src/app/api/photos/[user]/[version]/route");
const { createAuth } = await import("../../src/server/auth");
const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");
const { member, profileFor } = await import("../../src/server/profiles");
const { people, changeRelationship } =
  await import("../../src/server/relationships");
const { conversations } = await import("../../src/server/feed");
const { addComment } = await import("../../src/server/comments");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { notifications } = await import("../../src/server/notifications");
const { watchTogether } = await import("../../src/server/watch-together");
const {
  backfillGooglePhotos,
  chooseGooglePhoto,
  googlePictureURL,
  photoBackfill,
  runPhotoBackfill,
} = await import("../../src/server/photos");

useDatabase();
afterEach(() => mock.restoreAll());

const origin = "http://localhost:3000";

// Bytes that start like a JPEG. The server checks only the leading bytes.
function jpeg(size = 4000, fill = 7) {
  const bytes = Buffer.alloc(size, fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(500, 3),
  ]);

function upload(cookie: string, body: BodyInit, requestOrigin = origin) {
  return POST(
    new Request(`${origin}/api/screenr/photo`, {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        Origin: requestOrigin,
        Cookie: cookie,
      },
      body,
    }),
    { params: Promise.resolve({ action: "photo" }) },
  );
}
function change(
  cookie: string,
  action: "remove-photo" | "google-photo",
  headers: Record<string, string> = {},
) {
  return POST(
    new Request(`${origin}/api/screenr/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
        ...headers,
      },
      body: "{}",
    }),
    { params: Promise.resolve({ action }) },
  );
}
function fetchPhoto(
  cookie: string,
  user: string,
  version: string,
  headers: Record<string, string> = {},
) {
  return photoRoute(
    new Request(`${origin}/api/photos/${user}/${version}`, {
      headers: { Cookie: cookie, ...headers },
    }),
    { params: Promise.resolve({ user, version }) },
  );
}
async function stored(user: string) {
  return (
    await db.query(
      "SELECT image,content_type,version,source FROM profile_photo WHERE user_id=$1",
      [user],
    )
  ).rows[0];
}
async function activeDays(user: string) {
  return (
    await db.query(
      "SELECT count(*)::int AS days FROM member_active_day WHERE user_id=$1",
      [user],
    )
  ).rows[0].days;
}

// A stand-in for Google's image servers that records each request.
function google(
  pictures: Record<string, () => Response> = {},
): typeof fetch & { requests: string[] } {
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    return pictures[url]?.() ?? new Response(null, { status: 404 });
  };
  return Object.assign(fetcher, { requests }) as typeof fetch & {
    requests: string[];
  };
}
const picture = (bytes: Buffer) => () =>
  new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/jpeg" },
  });
// An unsigned ID token carrying Google's picture claim.
const idToken = (claims: Record<string, unknown>) =>
  [{ alg: "none" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".") + ".signature";
async function googleAccount(
  user: string,
  options: { image?: string; picture?: string } = {},
) {
  if (options.image)
    await db.query('UPDATE "user" SET image=$2 WHERE id=$1', [
      user,
      options.image,
    ]);
  await db.query(
    `INSERT INTO account(id,"accountId","providerId","userId","idToken","createdAt","updatedAt")
    VALUES($1,$2,'google',$3,$4,now(),now())`,
    [
      randomUUID(),
      randomUUID(),
      user,
      options.picture ? idToken({ picture: options.picture }) : null,
    ],
  );
}
const lh3 = (id: string) => `https://lh3.googleusercontent.com/a/${id}`;

test("photo uploads accept JPEG bytes up to 200 KB before and after setup, and reject other types and sizes", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  await db.query("DELETE FROM member_active_day");

  const added = await upload(cookie, jpeg());
  assert.equal(added.status, 200);
  const { photo } = await added.json();
  assert.match(photo, /^[0-9a-f]{16}$/);
  assert.deepEqual(await stored(alice), {
    image: jpeg(),
    content_type: "image/jpeg",
    version: photo,
    source: "upload",
  });
  assert.equal((await member(alice)).photo, photo);
  assert.equal(await activeDays(alice), 1);

  const largest = jpeg(200 * 1024, 9);
  const replaced = await upload(cookie, largest);
  assert.equal(replaced.status, 200);
  const replacement = (await replaced.json()).photo;
  assert.notEqual(replacement, photo, "a new photo needs a new avatar URL");
  assert.equal((await stored(alice)).version, replacement);

  const rejected = [
    [jpeg(200 * 1024 + 1), { status: 413, message: "Request too large." }],
    [png(), { status: 415, message: "Photos must be JPEG images." }],
    [
      Buffer.from("<svg onload=alert(1)>"),
      { status: 415, message: "Photos must be JPEG images." },
    ],
    [Buffer.alloc(0), { status: 400, message: "Choose a photo to upload." }],
  ] as const;
  for (const [body, error] of rejected)
    await assertRouteError(await upload(cookie, body), error);
  await assertRouteError(
    await upload(cookie, jpeg(), "https://outside.example"),
    denied.origin,
  );
  await assertRouteError(await upload("", jpeg()), denied.signedOut);
  assert.equal((await stored(alice)).version, replacement);

  // During setup the person has no profile yet. The photo is kept for the
  // profile they create, and no active day is recorded.
  const { token } = await createInvitation(null);
  const newcomer = await pending("newcomer", token);
  const newcomerCookie = await cookieFor(newcomer);
  const early = await upload(newcomerCookie, jpeg(3000, 4));
  assert.equal(early.status, 200);
  const early_photo = (await early.json()).photo;
  assert.equal(await activeDays(newcomer), 0);
  await completeSignup(newcomer, "Newcomer", "newcomer");
  assert.equal((await member(newcomer)).photo, early_photo);
});

test("photos are served only to signed-in members who can see that profile, with private caching", async () => {
  const owner = await person("owner");
  const pal = await person("pal");
  const stranger = await person("stranger");
  const blocker = await person("blocker");
  const blocked = await person("blocked");
  await friend(owner, pal);
  const ownerCookie = await cookieFor(owner);
  const { photo } = await (await upload(ownerCookie, jpeg())).json();

  for (const viewer of [owner, pal, stranger]) {
    const response = await fetchPhoto(await cookieFor(viewer), owner, photo);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(
      response.headers.get("cache-control"),
      "private, max-age=86400",
    );
    assert.equal(response.headers.get("vary"), "Cookie, Authorization");
    assert.equal(response.headers.get("etag"), `"${photo}"`);
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg());
  }
  const revalidated = await fetchPhoto(await cookieFor(pal), owner, photo, {
    "If-None-Match": `"${photo}"`,
  });
  assert.equal(revalidated.status, 304);
  assert.equal(
    revalidated.headers.get("cache-control"),
    "private, max-age=86400",
  );

  // Blocking hides the photo in both directions.
  await changeRelationship(blocker, owner, "block");
  await changeRelationship(owner, blocked, "block");
  const denials: [string, string, number][] = [
    ["", photo, 401],
    [await cookieFor(blocker), photo, 404],
    [await cookieFor(blocked), photo, 404],
    [await cookieFor(pal), "0123456789abcdef", 404],
    [await cookieFor(pal), "../../../etc", 404],
  ];
  for (const [cookie, version, status] of denials) {
    const response = await fetchPhoto(cookie, owner, version);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }

  // Before setup, only the person themselves can see their photo; they
  // cannot see members' photos until they have a profile.
  const { token } = await createInvitation(null);
  const newcomer = await pending("newcomer", token);
  const newcomerCookie = await cookieFor(newcomer);
  const early = (await (await upload(newcomerCookie, jpeg(900))).json()).photo;
  assert.equal((await fetchPhoto(newcomerCookie, newcomer, early)).status, 200);
  assert.equal(
    (await fetchPhoto(await cookieFor(pal), newcomer, early)).status,
    404,
  );
  assert.equal((await fetchPhoto(newcomerCookie, owner, photo)).status, 404);

  // A removed photo is no longer served and the profile shows the initial.
  const removed = await change(ownerCookie, "remove-photo");
  assert.deepEqual(await removed.json(), { photo: null });
  assert.equal(
    (await fetchPhoto(await cookieFor(pal), owner, photo)).status,
    404,
  );
  assert.equal((await member(owner)).photo, null);
  assert.deepEqual(await stored(owner), {
    image: null,
    content_type: null,
    version: null,
    source: null,
  });
});

// The iPhone app sends `Authorization: Bearer <token>` without a cookie or
// Origin, for uploads and for photo fetches.
test("bearer sessions upload and fetch photos, and invalid tokens get 401", async () => {
  const owner = await person("owner");
  const pal = await person("pal");
  await friend(owner, pal);
  const uploaded = await POST(
    new Request(`${origin}/api/screenr/photo`, {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        Authorization: `Bearer ${await bearerFor(owner)}`,
      },
      body: jpeg(),
    }),
    { params: Promise.resolve({ action: "photo" }) },
  );
  assert.equal(uploaded.status, 200);
  const { photo } = await uploaded.json();

  const viewed = (authorization: string, cookie = "") =>
    photoRoute(
      new Request(`${origin}/api/photos/${owner}/${photo}`, {
        headers: { Authorization: authorization, Cookie: cookie },
      }),
      { params: Promise.resolve({ user: owner, version: photo }) },
    );
  const token = await bearerFor(pal);
  const response = await viewed(`Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(response.headers.get("vary"), "Cookie, Authorization");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg());

  // A bad token fails even beside a valid cookie.
  const cookie = await cookieFor(pal);
  for (const bad of ["Bearer not-a-token", "Bearer"]) {
    const denial = await viewed(bad, cookie);
    assert.equal(denial.status, 401);
    assert.equal(denial.headers.get("cache-control"), "private, no-store");
    assert.equal(denial.headers.get("vary"), "Cookie, Authorization");
  }
});

test("every place a member appears carries their photo, and blocked people show initials", async () => {
  const alice = await person("alice");
  const ben = await person("ben");
  const cam = await person("cam");
  const dana = await person("dana");
  await friend(alice, ben);
  await friend(ben, cam);
  const photos: Record<string, string> = {};
  for (const [user, fill] of [
    [alice, 1],
    [ben, 2],
    [cam, 3],
    [dana, 4],
  ] as const)
    photos[user] = (
      await (await upload(await cookieFor(user), jpeg(1000, fill))).json()
    ).photo;

  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Test Movie') ON CONFLICT DO NOTHING",
  );
  const item = await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  await addComment(alice, item, "A comment", false);
  const [entry] = (await conversations(alice)).filter((c) => c.id === item);
  assert.equal(entry.photo, photos[ben]);
  assert.equal(entry.comments[0].photo, photos[alice]);

  const profile = await profileFor(alice, "ben");
  assert.equal(profile.photo, photos[ben]);
  assert.deepEqual(
    profile.friends.map((person) => person.photo).sort(),
    [photos[alice], photos[cam]].sort(),
  );
  const list = await people(alice);
  assert.equal(list.connections[0].photo, photos[ben]);
  assert.equal(list.suggestions[0].photo, photos[cam]);
  assert.equal(list.suggestions[0].mutual_friends[0].photo, photos[ben]);
  const together = await watchTogether(alice, ["ben"]);
  assert.deepEqual(
    together.participants.map((person) => person.photo),
    [photos[alice], photos[ben]],
  );
  const { items } = await notifications(ben);
  assert.deepEqual(
    items.map((notification) => [notification.kind, notification.actorPhoto]),
    [
      ["comment", photos[alice]],
      ["friend_accepted", photos[cam]],
    ],
  );

  await changeRelationship(alice, dana, "block");
  assert.deepEqual((await people(alice)).blocked, [
    { user_id: dana, username: "dana", display_name: "dana", photo: null },
  ]);
});

test("Google picture URLs stay on Google's image hosts and request a 512-pixel square", () => {
  const cases: [string, string | null][] = [
    [`${lh3("ACg8oc-abc")}=s96-c`, `${lh3("ACg8oc-abc")}=s512-c`],
    [lh3("ACg8oc-abc"), `${lh3("ACg8oc-abc")}=s512-c`],
    [
      "https://lh5.googleusercontent.com/-x/AAAA/BBBB/s96-c/photo.jpg?sz=50",
      "https://lh5.googleusercontent.com/-x/AAAA/BBBB/s512-c/photo.jpg",
    ],
    ["http://lh3.googleusercontent.com/a/x=s96-c", null],
    ["https://lh3.googleusercontent.com.example/a/x", null],
    ["https://evil.example/lh3.googleusercontent.com/a/x", null],
    ["https://user@lh3.googleusercontent.com/a/x", null],
    ["https://lh3.googleusercontent.com:8443/a/x", null],
    ["https://127.0.0.1/a/x", null],
    ["not a url", null],
  ];
  for (const [input, expected] of cases)
    assert.equal(googlePictureURL(input)?.href ?? null, expected, input);
  assert.equal(googlePictureURL(undefined), null);
});

// Better Auth's HTTP handlers run with only Google's identity response and
// image servers replaced, as in authentication.test.ts.
async function googleAuth(fetcher: typeof fetch) {
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  const codes = new Map<string, string>();
  const auth = createAuth({
    rateLimit: false,
    fetchPhoto: fetcher,
    sendCode: async ({ email, otp }) => {
      codes.set(email, otp);
    },
  });
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const provider = (await auth.$context).socialProviders[0];
  assert.ok(provider);
  const identity = {
    id: "google-id",
    email: "google@example.test",
    image: undefined as string | undefined,
  };
  provider.idToken = { verify: async () => true };
  provider.getUserInfo = async () => ({
    user: {
      email: identity.email,
      name: "Google member",
      emailVerified: true,
      image: identity.image,
    },
    data: { sub: identity.id },
  });
  const post = (path: string, body: unknown, cookie = "") =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      }),
    );
  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  return { codes, identity, post, sessionCookie };
}

test("a Google signup copies the 512-pixel picture once, and a removed photo is never copied again", async () => {
  const image = jpeg(5000, 5);
  const fetcher = google({ [`${lh3("signup")}=s512-c`]: picture(image) });
  const { identity, post, sessionCookie } = await googleAuth(fetcher);
  const inviter = await person("inviter");
  const { token } = await createInvitation(inviter, 2);
  identity.image = `${lh3("signup")}=s96-c`;
  const signup = await post(
    "sign-in/social",
    { provider: "google", idToken: { token: idToken({}) } },
    `screenr-invite=${token}`,
  );
  assert.equal(signup.status, 200, await signup.clone().text());
  const user = (await signup.json()).user.id;
  assert.deepEqual(fetcher.requests, [`${lh3("signup")}=s512-c`]);
  const copied = await stored(user);
  assert.deepEqual(copied.image, image);
  assert.equal(copied.source, "google");
  // The copy exists during setup, and Screenr serves it, not Google.
  const cookie = sessionCookie(signup);
  assert.equal((await fetchPhoto(cookie, user, copied.version)).status, 200);
  await completeSignup(user, "Google member", "googler");
  assert.equal((await member(user)).photo, copied.version);

  // Signing in again never fetches or replaces the photo.
  await post("sign-in/social", {
    provider: "google",
    idToken: { token: idToken({}) },
  });
  assert.equal(fetcher.requests.length, 1);

  await change(cookie, "remove-photo");
  assert.equal((await member(user)).photo, null);
  assert.deepEqual(await backfillGooglePhotos(fetcher), {
    copied: 0,
    kept: 0,
    "no picture": 0,
    failed: 0,
  });
  assert.equal(fetcher.requests.length, 1);
  assert.equal((await member(user)).photo, null);

  // Choosing "Use my Google photo" brings it back.
  const chosen = await chooseGooglePhoto(user, fetcher);
  assert.equal(chosen.photo, copied.version);
  assert.equal((await member(user)).photo, copied.version);
});

test("linking Google after an email-code signup copies the ID token picture unless a photo was chosen", async () => {
  const image = jpeg(6000, 6);
  const fetcher = google({ [`${lh3("linked")}=s512-c`]: picture(image) });
  const { codes, identity, post, sessionCookie } = await googleAuth(fetcher);
  const { token } = await createInvitation(null, 2);
  async function emailMember(email: string, username: string) {
    await post(
      "email-otp/send-verification-otp",
      { email, type: "sign-in" },
      `screenr-invite=${token}`,
    );
    const signup = await post(
      "sign-in/email-otp",
      { email, otp: codes.get(email) },
      `screenr-invite=${token}`,
    );
    const user = (await signup.json()).user.id;
    await completeSignup(user, username, username);
    return { user, cookie: sessionCookie(signup) };
  }
  const link = (cookie: string) =>
    post(
      "link-social",
      {
        provider: "google",
        idToken: { token: idToken({ picture: `${lh3("linked")}=s96-c` }) },
      },
      cookie,
    );

  const plain = await emailMember("plain@example.test", "plain");
  assert.equal((await member(plain.user)).photo, null);
  identity.id = "plain-google";
  identity.email = "plain@example.test";
  assert.equal((await link(plain.cookie)).status, 200);
  const copied = await stored(plain.user);
  assert.deepEqual(copied.image, image);
  assert.equal(copied.source, "google");
  assert.equal(
    (await db.query('SELECT image FROM "user" WHERE id=$1', [plain.user]))
      .rows[0].image,
    null,
    "the picture came from the linked account's ID token",
  );

  const chooser = await emailMember("chooser@example.test", "chooser");
  const chosen = (await (await upload(chooser.cookie, jpeg(800, 8))).json())
    .photo;
  identity.id = "chooser-google";
  identity.email = "chooser@example.test";
  assert.equal((await link(chooser.cookie)).status, 200);
  assert.equal(fetcher.requests.length, 1, "a chosen photo needs no fetch");
  assert.equal((await member(chooser.user)).photo, chosen);
});

test("Use my Google photo replaces an upload, needs a Google picture, and reports failed copies", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  await assertRouteError(await change(cookie, "google-photo"), {
    status: 400,
    message: "Connect Google on Account to use your Google photo.",
  });
  await googleAccount(alice);
  await assertRouteError(await change(cookie, "google-photo"), {
    status: 400,
    message: "Your Google account has no photo to use.",
  });
  await db.query('DELETE FROM account WHERE "userId"=$1', [alice]);
  await googleAccount(alice, { picture: lh3("alice") });
  const uploaded = (await (await upload(cookie, jpeg())).json()).photo;

  const printed = captureFailures();
  await assert.rejects(
    chooseGooglePhoto(alice, google()),
    (error: Error & { status?: number }) =>
      error.message ===
        "Your Google photo could not be copied. Please try again." &&
      error.status === 502,
  );
  assert.equal((await member(alice)).photo, uploaded);
  assert.deepEqual(
    printed.map((line) => JSON.parse(line)),
    [
      {
        event: "google photo copy failed",
        user: alice,
        trigger: "choice",
        reason: "status",
        status: 404,
      },
    ],
  );

  // Through the API, the line names the request ID that the reply carries.
  mock.restoreAll();
  const logged = captureFailures();
  mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 404 }),
  );
  const failed = await change(cookie, "google-photo", {
    "Screenr-Request-Id": "photo-request-1",
  });
  assert.equal(failed.headers.get("Screenr-Request-Id"), "photo-request-1");
  await assertRouteError(failed, {
    status: 502,
    message: "Your Google photo could not be copied. Please try again.",
  });
  assert.deepEqual(
    logged.map((line) => JSON.parse(line)),
    [
      {
        event: "google photo copy failed",
        requestId: "photo-request-1",
        user: alice,
        trigger: "choice",
        reason: "status",
        status: 404,
      },
    ],
  );
  mock.restoreAll();

  const image = jpeg(3000, 2);
  const result = await chooseGooglePhoto(
    alice,
    google({ [`${lh3("alice")}=s512-c`]: picture(image) }),
  );
  assert.notEqual(result.photo, uploaded);
  assert.deepEqual((await stored(alice)).image, image);
  assert.equal((await stored(alice)).source, "google");
});

test("the one-time backfill copies each eligible Google member, logs failures, and can run again safely", async () => {
  await db.query("DELETE FROM screenr_backfill");
  const signup = await person("signup");
  const linked = await person("linked");
  const uploader = await person("uploader");
  const remover = await person("remover");
  const emailOnly = await person("emailonly");
  const missing = await person("missing");
  const broken = await person("broken");
  const huge = await person("huge");
  const redirected = await person("redirected");
  const outsider = await person("outsider");
  await googleAccount(signup, { image: `${lh3("signup")}=s96-c` });
  await googleAccount(linked, { picture: `${lh3("linked")}=s96-c` });
  await googleAccount(uploader, { image: lh3("uploader") });
  await googleAccount(remover, { image: lh3("remover") });
  await googleAccount(missing);
  await googleAccount(broken, { image: lh3("broken") });
  await googleAccount(huge, { image: lh3("huge") });
  await googleAccount(redirected, { image: lh3("redirected") });
  // A changed user.image outside Google falls back to the ID token picture.
  await googleAccount(outsider, {
    image: "http://127.0.0.1:5439/private",
    picture: lh3("outsider"),
  });
  const uploaded = (
    await (await upload(await cookieFor(uploader), jpeg(700, 1))).json()
  ).photo;
  await change(await cookieFor(remover), "remove-photo");

  let brokenWorks = false;
  const fetcher = google({
    [`${lh3("signup")}=s512-c`]: picture(jpeg(1000, 1)),
    [`${lh3("linked")}=s512-c`]: picture(jpeg(1000, 2)),
    [`${lh3("outsider")}=s512-c`]: picture(jpeg(1000, 3)),
    [`${lh3("broken")}=s512-c`]: () =>
      brokenWorks
        ? picture(jpeg(1000, 4))()
        : new Response(null, { status: 503 }),
    [`${lh3("huge")}=s512-c`]: picture(jpeg(200 * 1024 + 1)),
    [`${lh3("redirected")}=s512-c`]: () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/photo.jpg" },
      }),
  });

  const printed = captureFailures();
  const log = mock.method(console, "log", () => {});
  const counts = await runPhotoBackfill(fetcher);
  assert.deepEqual(counts, {
    copied: 3,
    kept: 0,
    "no picture": 1,
    failed: 3,
  });
  for (const [user, fill] of [
    [signup, 1],
    [linked, 2],
    [outsider, 3],
  ] as const) {
    assert.deepEqual((await stored(user)).image, jpeg(1000, fill));
    assert.equal((await stored(user)).source, "google");
  }
  assert.equal((await member(uploader)).photo, uploaded);
  assert.equal((await stored(remover)).image, null);
  for (const user of [emailOnly, missing, broken, huge, redirected])
    assert.equal((await member(user)).photo, null);
  assert.ok(!fetcher.requests.some((url) => !url.startsWith("https://lh3.")));
  assert.deepEqual(
    printed
      .map((line) => JSON.parse(line))
      .sort((a, b) => (a.user < b.user ? -1 : 1)),
    [
      { user: broken, reason: "status", status: 503 },
      { user: huge, reason: "too large" },
      { user: redirected, reason: "redirect", status: 302 },
    ]
      .map((fields) => ({
        event: "google photo copy failed",
        trigger: "backfill",
        ...fields,
      }))
      .sort((a, b) => (a.user < b.user ? -1 : 1)),
  );
  assert.deepEqual(
    log.mock.calls.map((call) => JSON.parse(call.arguments[0])),
    [
      {
        event: "google photo backfill finished",
        copied: 3,
        kept: 0,
        "no picture": 1,
        failed: 3,
      },
    ],
  );
  assert.equal(
    (
      await db.query("SELECT 1 FROM screenr_backfill WHERE name=$1", [
        photoBackfill,
      ])
    ).rowCount,
    1,
  );

  // The marker stops later worker starts.
  const before = fetcher.requests.length;
  assert.equal(await runPhotoBackfill(fetcher), null);
  assert.equal(fetcher.requests.length, before);

  // A retry fetches only for those still without a photo or removal.
  brokenWorks = true;
  const retry = await backfillGooglePhotos(fetcher);
  assert.deepEqual(retry, { copied: 1, kept: 0, "no picture": 1, failed: 2 });
  assert.deepEqual(fetcher.requests.slice(before).sort(), [
    `${lh3("broken")}=s512-c`,
    `${lh3("huge")}=s512-c`,
    `${lh3("redirected")}=s512-c`,
  ]);
  assert.deepEqual((await stored(broken)).image, jpeg(1000, 4));
  assert.equal((await member(uploader)).photo, uploaded);
  await db.query("DELETE FROM screenr_backfill");
});

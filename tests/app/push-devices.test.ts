import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  assertRouteError,
  person,
  bearerFor,
  cookieFor,
} from "./social-fixture";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { auth } = await import("../../src/server/auth");
const { loadScreen } = await import("../../src/server/screens");
const { pushDevices, removePushDevice } = await import("../../src/server/push");
useDatabase();

// iPhone push devices and per-kind push settings
// (docs/data-and-access.md#push-devices-and-settings).

const origin = "http://localhost:3000";
const dev = "com.artisanalsoftware.Screenr.dev";
const release = "com.artisanalsoftware.Screenr";
const tokenA = "a1".repeat(32);
const tokenB = "b2".repeat(32);

// The iPhone app's POST: a bearer token, and no cookie or Origin.
function post(action: string, token: string, body: unknown) {
  return POST(
    new Request(`${origin}/api/screenr/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ action }) },
  );
}

const register = (
  session: string,
  token: string,
  fields: Record<string, unknown> = {},
) =>
  post("push-device", session, {
    action: "register",
    token,
    environment: "sandbox",
    topic: dev,
    build: 42,
    ...fields,
  });

async function stored() {
  return (
    await db.query(
      `SELECT d.token,d.user_id,s.token AS session,d.environment,d.topic,d.build,
        d.last_seen_at>now()-interval '1 minute' AS seen
      FROM push_device d JOIN session s ON s.id=d.session_id ORDER BY d.token`,
    )
  ).rows;
}
// The stored session token that a signed bearer token names.
const sessionOf = (bearer: string) => decodeURIComponent(bearer).split(".")[0];

async function accountSettings(user: string) {
  const screen = await loadScreen(user, "/account");
  assert.equal(screen.kind, "account");
  return (screen as Extract<typeof screen, { kind: "account" }>).pushSettings;
}

test("registering stores the device for the member's session", async () => {
  const alice = await person("alice");
  const session = await bearerFor(alice);
  const response = await register(session, tokenA.toUpperCase());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(await stored(), [
    {
      token: tokenA,
      user_id: alice,
      session: sessionOf(session),
      environment: "sandbox",
      topic: dev,
      build: 42,
      seen: true,
    },
  ]);
  assert.deepEqual(await pushDevices(alice), [
    { token: tokenA, environment: "sandbox", topic: dev, build: 42 },
  ]);
  // The web's cookie session registers the same way.
  const web = await POST(
    new Request(`${origin}/api/screenr/push-device`, {
      method: "POST",
      headers: {
        Cookie: await cookieFor(alice),
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "register",
        token: tokenB,
        environment: "production",
        topic: release,
        build: 7,
      }),
    }),
    { params: Promise.resolve({ action: "push-device" }) },
  );
  assert.equal(web.status, 200);
  assert.equal((await pushDevices(alice)).length, 2);
});

test("registration rejects invalid tokens, environments, bundle IDs, builds, and actions", async () => {
  const alice = await person("alice");
  const session = await bearerFor(alice);
  for (const token of [
    undefined,
    42,
    "",
    "a1".repeat(31),
    "a1".repeat(101),
    `${"a1".repeat(32)}0`,
    "zz".repeat(32),
  ])
    await assertRouteError(await register(session, token as string), {
      status: 400,
      message: "Invalid push device token.",
    });
  for (const environment of [undefined, "development", "Sandbox"])
    await assertRouteError(await register(session, tokenA, { environment }), {
      status: 400,
      message: "Unknown push environment.",
    });
  for (const topic of [undefined, "com.example.Other", `${release}.beta`])
    await assertRouteError(await register(session, tokenA, { topic }), {
      status: 400,
      message: "Unknown app bundle ID.",
    });
  for (const build of [undefined, 0, -1, 1.5, "42", 2 ** 31])
    await assertRouteError(await register(session, tokenA, { build }), {
      status: 400,
      message: "Invalid app build.",
    });
  for (const action of [undefined, "update"])
    await assertRouteError(await register(session, tokenA, { action }), {
      status: 400,
      message: "Unknown push device action.",
    });
  assert.deepEqual(await stored(), []);
});

test("re-registering a token moves it to the current member and session", async () => {
  const alice = await person("alice");
  const ben = await person("ben");
  const first = await bearerFor(alice);
  const second = await bearerFor(alice);
  await register(first, tokenA);
  await db.query("UPDATE push_device SET last_seen_at=now()-interval '1 day'");

  // The same app on a later launch refreshes its build and last-seen time.
  assert.equal((await register(first, tokenA, { build: 43 })).status, 200);
  assert.deepEqual(
    (await stored()).map(({ session, build, seen }) => ({
      session,
      build,
      seen,
    })),
    [{ session: sessionOf(first), build: 43, seen: true }],
  );

  // Signing in again on the same phone keeps one device record.
  await register(second, tokenA);
  assert.deepEqual(
    (await stored()).map(({ user_id, session }) => ({ user_id, session })),
    [{ user_id: alice, session: sessionOf(second) }],
  );

  // A token belongs to one phone, so another member's sign-in takes it.
  const bens = await bearerFor(ben);
  await register(bens, tokenA, { environment: "production", topic: release });
  assert.deepEqual(await stored(), [
    {
      token: tokenA,
      user_id: ben,
      session: sessionOf(bens),
      environment: "production",
      topic: release,
      build: 42,
      seen: true,
    },
  ]);
  assert.deepEqual(await pushDevices(alice), []);
});

test("a new token from the same session and app replaces the old one", async () => {
  const alice = await person("alice");
  const session = await bearerFor(alice);
  await register(session, tokenA);
  // APNs issued the dev app a new token, for example after a reinstall that
  // kept the Keychain session.
  await register(session, tokenB);
  assert.deepEqual(
    (await stored()).map(({ token, topic }) => ({ token, topic })),
    [{ token: tokenB, topic: dev }],
  );
  // The release app sharing that session keeps its own device.
  await register(session, tokenA, { topic: release });
  assert.deepEqual(
    (await stored()).map(({ token, topic }) => ({ token, topic })),
    [
      { token: tokenA, topic: release },
      { token: tokenB, topic: dev },
    ],
  );
});

test("removing a device and signing out delete only that member's devices", async () => {
  const alice = await person("alice");
  const ben = await person("ben");
  const phone = await bearerFor(alice);
  const tablet = await bearerFor(alice);
  const bens = await bearerFor(ben);
  await register(phone, tokenA);
  await register(bens, tokenB);

  // Another member cannot remove a token, and an unknown one is ignored.
  for (const token of [tokenB, "c3".repeat(32)]) {
    const response = await post("push-device", phone, {
      action: "remove",
      token,
    });
    assert.equal(response.status, 200);
  }
  assert.equal((await stored()).length, 2);
  await assertRouteError(
    await post("push-device", phone, { action: "remove", token: "nope" }),
    { status: 400, message: "Invalid push device token." },
  );

  const removed = await post("push-device", phone, {
    action: "remove",
    token: tokenA,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  assert.deepEqual(await pushDevices(alice), []);

  // Signing out deletes the session's devices, even if the app never calls
  // the API again. Other sessions keep theirs.
  await register(phone, tokenA);
  await register(tablet, "d4".repeat(32));
  const signedOut = await auth().handler(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${phone}` },
    }),
  );
  assert.equal(signedOut.status, 200);
  assert.deepEqual(
    (await pushDevices(alice)).map(({ token }) => token),
    ["d4".repeat(32)],
  );
  assert.deepEqual(
    (await pushDevices(ben)).map(({ token }) => token),
    [tokenB],
  );
});

test("devices of expired sessions receive nothing, and APNs rejections delete them", async () => {
  const alice = await person("alice");
  const phone = await bearerFor(alice);
  const tablet = await bearerFor(alice);
  await register(phone, tokenA);
  await register(tablet, tokenB);
  await db.query(
    `UPDATE session SET "expiresAt"=now()-interval '1 second' WHERE token=$1`,
    [sessionOf(tablet)],
  );
  assert.deepEqual(
    (await pushDevices(alice)).map(({ token }) => token),
    [tokenA],
  );
  // APNs answered 410 for the token.
  await removePushDevice(tokenA);
  assert.deepEqual(await pushDevices(alice), []);
  assert.deepEqual(
    (await stored()).map(({ token }) => token),
    [tokenB],
  );
});

test("push settings default to on, save per kind, and filter devices", async () => {
  const alice = await person("alice");
  const ben = await person("ben");
  const session = await bearerFor(alice);
  await register(session, tokenA);
  const on = {
    friendRequest: true,
    friendAccepted: true,
    comment: true,
    reply: true,
  };
  assert.deepEqual(await accountSettings(alice), on);

  const saved = await post("push-settings", session, {
    comment: false,
    reply: false,
  });
  assert.equal(saved.status, 200);
  const off = { ...on, comment: false, reply: false };
  assert.deepEqual(await saved.json(), { pushSettings: off });
  assert.deepEqual(await accountSettings(alice), off);
  // Kinds left out keep their saved values.
  const again = await post("push-settings", session, { reply: true });
  assert.deepEqual(await again.json(), {
    pushSettings: { ...off, reply: true },
  });
  assert.deepEqual(await accountSettings(ben), on);

  for (const body of [
    {},
    { comment: "false" },
    { reply: null },
    { comment: false, friendRequest: 1 },
  ])
    await assertRouteError(await post("push-settings", session, body), {
      status: 400,
      message: "Choose whether to receive each kind of push notification.",
    });
  assert.deepEqual(await accountSettings(alice), { ...off, reply: true });

  // Devices receive only the kinds their member allows.
  assert.equal((await pushDevices(alice, "comment")).length, 0);
  for (const kind of ["friend_request", "friend_accepted", "reply"] as const)
    assert.equal((await pushDevices(alice, kind)).length, 1, kind);
  assert.equal((await pushDevices(alice)).length, 1);
});

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID, webcrypto } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import {
  useDatabase,
  setup,
  friend,
  db,
  bearerFor,
  cookieFor,
  captureFailures,
} from "./social-fixture";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { changeRelationship } = await import("../../src/server/relationships");
const { addComment, removeComment } = await import("../../src/server/comments");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { notifications, readNotification } =
  await import("../../src/server/notifications");
const { savePushSettings, queueBadgePush, deliverPushes, runPushPass } =
  await import("../../src/server/push");
const { Apns, apnsFromEnvironment } = await import("../../src/server/apns");
useDatabase();

// The worker's APNs delivery
// (docs/notifications.md#push-delivery), against fake APNs servers that
// speak HTTP/2 without TLS on loopback.

const dev = "com.artisanalsoftware.Screenr.dev";
const release = "com.artisanalsoftware.Screenr";
const tokenA = "a1".repeat(32);
const tokenB = "b2".repeat(32);
const tokenC = "c3".repeat(32);
const alert = { body: "New activity on Screenr" };
const sound = "default";

type Received = { token: string; headers: IncomingHttpHeaders; body: unknown };
type Reply = { status: number; reason?: string };

// One fake APNs host. It records each request and answers with `reply`.
async function fakeApns() {
  const received: Received[] = [];
  const sessions: ServerHttp2Session[] = [];
  const fake = {
    received,
    sessions,
    origin: "",
    reply: (_request: Received): Reply => ({ status: 200 }),
    // Ends every connection the way APNs does before it closes one.
    goaway: () => sessions.forEach((session) => session.goaway()),
    close: async () => {
      sessions.forEach((session) => session.destroy());
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
  const server = createServer();
  server.on("session", (session) => sessions.push(session));
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => {
      const request = {
        token: String(headers[":path"]).replace("/3/device/", ""),
        headers,
        body: JSON.parse(body),
      };
      received.push(request);
      const { status, reason } = fake.reply(request);
      stream.respond({ ":status": status, "apns-id": randomUUID() });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentials = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  key: keys.privateKey,
};
let sandbox: Awaited<ReturnType<typeof fakeApns>>;
let production: Awaited<ReturnType<typeof fakeApns>>;
let apns: InstanceType<typeof Apns>;
beforeEach(async () => {
  sandbox = await fakeApns();
  production = await fakeApns();
  apns = new Apns(credentials, {
    sandbox: sandbox.origin,
    production: production.origin,
  });
});
afterEach(async () => {
  mock.restoreAll();
  mock.timers.reset();
  apns.close();
  await Promise.all([sandbox.close(), production.close()]);
});

// An action from the web, with its session cookie and Origin, or from the
// iPhone app, with its bearer token.
type Client = { cookie: string } | { bearer: string };
const act = (client: Client, action: string, body: unknown) =>
  POST(
    new Request(`http://localhost:3000/api/screenr/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...("cookie" in client
          ? { Cookie: client.cookie, Origin: "http://localhost:3000" }
          : { Authorization: `Bearer ${client.bearer}` }),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ action }) },
  );

// The iPhone app registers its token over the API with a new bearer session.
async function device(
  user: string,
  token: string,
  environment = "sandbox",
  topic = dev,
) {
  const bearer = await bearerFor(user);
  const response = await act({ bearer }, "push-device", {
    action: "register",
    token,
    environment,
    topic,
    build: 42,
  });
  assert.equal(response.status, 200);
  return bearer;
}

const latest = async (user: string) => (await notifications(user)).items[0].id;
const bodies = (fake: typeof sandbox) =>
  fake.received.map(({ token, body }) => ({ token, body }));
const jobs = async () =>
  (await db.query("SELECT count(*)::int AS count FROM push_job")).rows[0].count;
type Badge = { aps: { badge: number }; notificationId?: string };

// In the badge tests, alice, ben, and cam each have one sandbox device. This
// sends the queued pushes and returns the badge of each member's alerts and
// badge-only updates.
const members: Record<string, string> = {
  [tokenA]: "alice",
  [tokenB]: "ben",
  [tokenC]: "cam",
};
async function pushed() {
  await deliverPushes(apns);
  const sent = { updates: {}, alerts: {} } as Record<
    "updates" | "alerts",
    Record<string, number>
  >;
  for (const { token, body } of sandbox.received.splice(0)) {
    const { aps, notificationId } = body as Badge;
    const kind = notificationId ? sent.alerts : sent.updates;
    assert.equal(kind[members[token]], undefined, "One push each");
    kind[members[token]] = aps.badge;
  }
  return sent;
}

test("each new notification pushes its ID, the generic alert, the unread badge, the default sound, its category, and its thread", async () => {
  const { alice, ben, conversation } = await setup();
  await device(alice, tokenA);
  await device(alice, tokenB, "production", release);
  await device(ben, tokenC);

  await changeRelationship(ben, alice, "request");
  const request = await latest(alice);
  assert.equal(await deliverPushes(apns), 2);
  const friendRequest = {
    aps: {
      alert,
      badge: 1,
      sound,
      "mutable-content": 1,
      category: "FRIEND_REQUEST",
    },
    notificationId: request,
  };
  // Each device's own APNs environment and bundle ID; the actor gets nothing.
  assert.deepEqual(bodies(sandbox), [{ token: tokenA, body: friendRequest }]);
  assert.deepEqual(bodies(production), [
    { token: tokenB, body: friendRequest },
  ]);
  const { headers } = sandbox.received[0];
  const expiration = Number(headers["apns-expiration"]);
  assert.ok(Math.abs(expiration - (Date.now() / 1000 + 86_400)) < 60);
  assert.match(
    String(headers.authorization),
    /^bearer [\w-]+\.[\w-]+\.[\w-]+$/,
  );
  assert.deepEqual(
    {
      method: headers[":method"],
      path: headers[":path"],
      type: headers["apns-push-type"],
      topic: headers["apns-topic"],
      priority: headers["apns-priority"],
      collapse: headers["apns-collapse-id"],
      content: headers["content-type"],
    },
    {
      method: "POST",
      path: `/3/device/${tokenA}`,
      type: "alert",
      topic: dev,
      priority: "10",
      collapse: request,
      content: "application/json",
    },
  );
  assert.equal(production.received[0].headers["apns-topic"], release);

  // An acceptance has no actions or conversation. Accepting the unread
  // request also sends alice's devices a badge-only update.
  await changeRelationship(alice, ben, "accept");
  await deliverPushes(apns);
  assert.deepEqual(production.received.at(-1)!.body, { aps: { badge: 0 } });
  const sent = bodies(sandbox).slice(-2);
  assert.deepEqual(
    sent.sort((a, b) => a.token.localeCompare(b.token)),
    [
      { token: tokenA, body: { aps: { badge: 0 } } },
      {
        token: tokenC,
        body: {
          aps: { alert, badge: 1, sound, "mutable-content": 1 },
          notificationId: await latest(ben),
        },
      },
    ],
  );

  // Comments and replies share the Reply action and group by their entry.
  // The answered request left the bell, so it leaves the badge too.
  const comment = await addComment(ben, conversation, "Loved it", false);
  await deliverPushes(apns);
  assert.deepEqual(bodies(production).at(-1), {
    token: tokenB,
    body: {
      aps: {
        alert,
        badge: 1,
        sound,
        "mutable-content": 1,
        category: "COMMENT",
        "thread-id": conversation,
      },
      notificationId: await latest(alice),
    },
  });
  await addComment(alice, conversation, "Me too", false, comment);
  await deliverPushes(apns);
  assert.deepEqual(bodies(sandbox).at(-1), {
    token: tokenC,
    body: {
      aps: {
        alert,
        badge: 2,
        sound,
        "mutable-content": 1,
        category: "COMMENT",
        "thread-id": conversation,
      },
      notificationId: await latest(ben),
    },
  });

  // Each push goes once.
  assert.equal(await jobs(), 0);
  assert.equal(await deliverPushes(apns), 0);
  assert.equal(sandbox.received.length + production.received.length, 8);
});

// WebCrypto verifies ES256 signatures in JWS's raw r||s form, independently
// of the signing code.
async function verifiedClaims(authorization: unknown) {
  const jwt = String(authorization).replace(/^bearer /, "");
  const [header, payload, signature] = jwt.split(".");
  const publicKey = await webcrypto.subtle.importKey(
    "jwk",
    keys.publicKey.export({ format: "jwk" }),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert.ok(
    await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(signature!, "base64url"),
      Buffer.from(`${header}.${payload}`),
    ),
  );
  const decode = (segment: string) =>
    JSON.parse(Buffer.from(segment, "base64url").toString());
  assert.deepEqual(decode(header!), { alg: "ES256", kid: "KEY1234567" });
  return decode(payload!);
}

test("provider tokens are ES256 JWTs from the APNs key, reused for 50 minutes and then replaced", async () => {
  const { alice } = await setup();
  await device(alice, tokenA);
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  const send = async () => {
    await queueBadgePush(alice);
    await deliverPushes(apns);
    return sandbox.received.at(-1)!.headers.authorization;
  };
  const first = await send();
  assert.deepEqual(await verifiedClaims(first), {
    iss: "TEAM123456",
    iat: Math.floor(start / 1000),
  });
  mock.timers.tick(49 * 60_000);
  assert.equal(await send(), first);
  mock.timers.tick(60_000);
  const second = await send();
  assert.notEqual(second, first);
  assert.deepEqual(await verifiedClaims(second), {
    iss: "TEAM123456",
    iat: Math.floor(start / 1000) + 50 * 60,
  });

  // APNs rejecting the token as expired replaces it, except within 20
  // minutes of signing, when APNs refuses a new one.
  captureFailures();
  sandbox.reply = () => ({ status: 403, reason: "ExpiredProviderToken" });
  mock.timers.tick(19 * 60_000);
  assert.equal(await send(), second);
  mock.timers.tick(60_000);
  assert.equal(await send(), second);
  sandbox.reply = () => ({ status: 200 });
  const third = await send();
  assert.deepEqual(await verifiedClaims(third), {
    iss: "TEAM123456",
    iat: Math.floor(start / 1000) + 70 * 60,
  });
});

test("rejected tokens delete their device, other rejections drop the push, and failures retry with backoff", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const replies: Record<string, Reply> = {
    ["d1".repeat(32)]: { status: 410, reason: "Unregistered" },
    ["d2".repeat(32)]: { status: 400, reason: "BadDeviceToken" },
    ["d3".repeat(32)]: { status: 400, reason: "DeviceTokenNotForTopic" },
    ["d4".repeat(32)]: { status: 413, reason: "PayloadTooLarge" },
    ["d5".repeat(32)]: { status: 503, reason: "ServiceUnavailable" },
  };
  for (const token of Object.keys(replies)) await device(alice, token);
  sandbox.reply = ({ token }) => replies[token];
  const failures = captureFailures();
  await addComment(ben, conversation, "Retry me", false);
  const ids = Object.fromEntries(
    (await db.query("SELECT token,id::text FROM push_job")).rows.map(
      ({ token, id }) => [token, id],
    ),
  );
  assert.equal(await deliverPushes(apns), 5);

  // A token APNs no longer accepts for the app is deleted.
  assert.deepEqual(
    (await db.query("SELECT token FROM push_device ORDER BY token")).rows,
    [{ token: "d4".repeat(32) }, { token: "d5".repeat(32) }],
  );
  const pending = await db.query(
    `SELECT token,attempts,last_error,
      available_at BETWEEN now()+interval '1 second' AND now()+interval '3 seconds' AS backoff
    FROM push_job`,
  );
  assert.deepEqual(pending.rows, [
    {
      token: "d5".repeat(32),
      attempts: 1,
      last_error: "APNs 503 ServiceUnavailable",
      backoff: true,
    },
  ]);
  assert.deepEqual(
    failures
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.status - b.status),
    [
      {
        event: "push delivery failed",
        job: ids["d4".repeat(32)],
        kind: "alert",
        environment: "sandbox",
        attempt: 1,
        status: 413,
        reason: "PayloadTooLarge",
        final: true,
      },
      {
        event: "push delivery failed",
        job: ids["d5".repeat(32)],
        kind: "alert",
        environment: "sandbox",
        attempt: 1,
        status: 503,
        reason: "ServiceUnavailable",
        final: false,
      },
    ],
  );
  assert.ok(!failures.join("").includes("d5"), "Tokens stay out of logs.");

  // The retry waits for its backoff, then sends the same push again.
  assert.equal(await deliverPushes(apns), 0);
  await db.query("UPDATE push_job SET available_at=now()");
  sandbox.reply = () => ({ status: 200 });
  assert.equal(await deliverPushes(apns), 1);
  const [first, retry] = sandbox.received.filter(
    ({ token }) => token === "d5".repeat(32),
  );
  assert.deepEqual(retry.body, first.body);
  assert.equal(
    retry.headers["apns-collapse-id"],
    first.headers["apns-collapse-id"],
  );
  assert.equal(await jobs(), 0);
});

test("only kinds the member left on are pushed as alerts, and the others update the badge", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await device(alice, tokenA);
  await savePushSettings(alice, { comment: false, friendRequest: false });
  const sent = () => sandbox.received.map(({ body }) => body as Badge);
  const alerts = () =>
    sent()
      .flatMap(({ notificationId }) => notificationId ?? [])
      .sort();
  // The badge counts every unread notification, pushed or not.
  const updates = () =>
    sent()
      .filter(({ notificationId }) => !notificationId)
      .map(({ aps }) => aps.badge);

  // A comment on her entry and a friend request stay out of her alerts and
  // only update the badge; a reply to her comment is pushed.
  const mine = await addComment(alice, conversation, "First!", false);
  await addComment(ben, conversation, "Top-level", false);
  await addComment(ben, conversation, "Answer", false, mine);
  const reply = await latest(alice);
  await changeRelationship(cam, alice, "request");
  await deliverPushes(apns);
  assert.deepEqual(alerts(), [reply]);
  assert.deepEqual(updates(), [4, 4]);
  assert.equal(await jobs(), 0);
  for (const { body, headers } of sandbox.received)
    if (!(body as Badge).notificationId)
      assert.deepEqual(
        [headers["apns-priority"], headers["apns-collapse-id"]],
        ["5", undefined],
      );

  await savePushSettings(alice, { comment: true, reply: false });
  await addComment(ben, conversation, "Another", false);
  const comment = await latest(alice);
  await addComment(ben, conversation, "Answer again", false, mine);
  await changeRelationship(alice, outsider, "request");
  await changeRelationship(outsider, alice, "accept");
  const accepted = await latest(alice);
  await deliverPushes(apns);
  assert.deepEqual(alerts(), [reply, comment, accepted].sort());
  assert.deepEqual(
    sent()
      .filter(({ notificationId }) => notificationId)
      .map(({ aps }) => aps.badge),
    [4, 7, 7],
  );
  assert.deepEqual(updates(), [4, 4, 7]);
});

test("pushes go only to notifications still visible and unread when sent, on the recipient's live devices", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(alice, outsider);
  const phone = await device(alice, tokenA);
  await deliverPushes(apns);
  sandbox.received.length = 0;

  await addComment(ben, conversation, "Blocked before sending", false);
  await changeRelationship(alice, ben, "block");
  const removed = await addComment(cam, conversation, "Removed", false);
  await removeComment(alice, removed);
  await addComment(outsider, conversation, "Read on the web", false);
  await readNotification(alice, await latest(alice));
  await deliverPushes(apns);
  // Only one badge update goes, for the block, the removal, and the read:
  // cam's and outsider's acceptances.
  assert.deepEqual(bodies(sandbox), [
    { token: tokenA, body: { aps: { badge: 2 } } },
  ]);
  assert.equal(await jobs(), 0);
  sandbox.received.length = 0;

  await addComment(cam, conversation, "Unfriended before sending", false);
  await changeRelationship(alice, cam, "remove");
  await deliverPushes(apns);
  assert.deepEqual(bodies(sandbox), [
    { token: tokenA, body: { aps: { badge: 1 } } },
  ]);
  sandbox.received.length = 0;

  // A device whose session expired receives nothing.
  await addComment(outsider, conversation, "Expired session", false);
  await db.query(
    `UPDATE session SET "expiresAt"=now()-interval '1 second' WHERE token=$1`,
    [decodeURIComponent(phone).split(".")[0]],
  );
  await deliverPushes(apns);
  assert.deepEqual(sandbox.received, []);

  // A phone that another member signed in to never receives alice's pushes.
  await device(alice, tokenA);
  await addComment(outsider, conversation, "Moved phone", false);
  await device(outsider, tokenA);
  await deliverPushes(apns);
  assert.deepEqual(sandbox.received, []);
  assert.equal(await jobs(), 0);
});

test("badge-only pushes carry only the current unread count", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await device(alice, tokenA);
  await device(alice, tokenB, "production", release);
  await addComment(ben, conversation, "Unread", false);
  await deliverPushes(apns);
  sandbox.received.length = 0;
  production.received.length = 0;

  // Queued updates that have not been sent yet collapse into one.
  await queueBadgePush(alice);
  await queueBadgePush(alice);
  await deliverPushes(apns);
  for (const [fake, token, topic] of [
    [sandbox, tokenA, dev],
    [production, tokenB, release],
  ] as const) {
    assert.deepEqual(bodies(fake), [{ token, body: { aps: { badge: 2 } } }]);
    const { headers } = fake.received[0];
    assert.deepEqual(
      [
        headers["apns-push-type"],
        headers["apns-topic"],
        headers["apns-priority"],
        headers["apns-collapse-id"],
      ],
      ["alert", topic, "5", undefined],
    );
  }

  // Reading both notifications queues one update, since the first is waiting.
  for (const { id } of (await notifications(alice)).items)
    await readNotification(alice, id);
  assert.equal(await jobs(), 2);
  await deliverPushes(apns);
  assert.deepEqual(sandbox.received.at(-1)!.body, { aps: { badge: 0 } });
  assert.equal(await jobs(), 0);
});

test("reads on any client send the member's devices a badge-only update with the new count", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  const app = { bearer: await device(alice, tokenA) };
  await device(alice, tokenB, "production", release);
  const web = { cookie: await cookieFor(alice) };
  await addComment(ben, conversation, "One", false);
  await addComment(ben, conversation, "Two", false);
  await changeRelationship(cam, alice, "request");
  await changeRelationship(outsider, alice, "request");
  await deliverPushes(apns);
  const [outsiderRequest, camRequest, , one] = (
    await notifications(alice)
  ).items.map(({ id }) => id);

  // Each read queues its update before it answers, and the worker then sends
  // the new count to both devices.
  const read = async (client: Client, action: string, body: unknown) => {
    assert.equal((await act(client, action, body)).status, 200);
    assert.equal(await jobs(), 2);
    await deliverPushes(apns);
    assert.equal(await jobs(), 0);
    const sent = [sandbox, production].map((fake) => fake.received.at(-1)!);
    assert.deepEqual(
      sent.map(({ token, headers }) => [token, headers["apns-priority"]]),
      [
        [tokenA, "5"],
        [tokenB, "5"],
      ],
    );
    assert.deepEqual(sent[0].body, sent[1].body);
    return sent[0].body;
  };
  const badge = (count: number) => ({ aps: { badge: count } });
  // Of 5 unread: ben's acceptance, two comments, and two requests.
  assert.deepEqual(await read(web, "read-notification", { id: one }), badge(4));
  assert.deepEqual(
    await read(app, "respond-friend-request", {
      id: camRequest,
      action: "accept",
    }),
    badge(3),
  );
  assert.deepEqual(
    await read(web, "respond-friend-request", {
      id: outsiderRequest,
      action: "decline",
    }),
    badge(2),
  );
  const { through } = await notifications(alice);
  assert.deepEqual(
    await read(app, "read-notifications", { through }),
    badge(0),
  );

  // Reads that leave the count alone, and failed reads, queue nothing.
  const sent = sandbox.received.length;
  assert.equal((await act(app, "read-notification", { id: one })).status, 200);
  assert.equal((await act(web, "read-notifications", { through })).status, 200);
  assert.equal(
    (
      await act(app, "respond-friend-request", {
        id: camRequest,
        action: "decline",
      })
    ).status,
    404,
  );
  assert.equal(await jobs(), 0);
  await deliverPushes(apns);
  assert.equal(sandbox.received.length, sent);

  // Answering a request it already read still updates the badge: accepting
  // restores the requester's earlier comments.
  await addComment(ben, conversation, "Before unfriending", false);
  await changeRelationship(alice, ben, "remove");
  await changeRelationship(ben, alice, "request");
  await deliverPushes(apns);
  const request = await latest(alice);
  assert.deepEqual(
    await read(web, "read-notification", { id: request }),
    badge(0),
  );
  assert.deepEqual(
    await read(app, "respond-friend-request", {
      id: request,
      action: "accept",
    }),
    badge(1),
  );
});

test("friendship changes on any client update the badge of each member whose count they change", async () => {
  const { alice, ben, cam, conversation } = await setup();
  const web = { cookie: await cookieFor(alice) };
  const app = { bearer: await device(alice, tokenA) };
  const benApp = { bearer: await device(ben, tokenB) };
  const camApp = { bearer: await device(cam, tokenC) };
  const relationship = async (client: Client, target: string, action: string) =>
    assert.equal(
      (await act(client, "relationship", { target, action })).status,
      200,
    );

  // Ben answers cam's comment on alice's entry. Unread: alice has both
  // comments, ben has alice's acceptance, and cam has hers and ben's reply.
  await friend(ben, alice);
  await friend(cam, alice);
  const camComment = await addComment(cam, conversation, "Cam's take", false);
  await addComment(ben, conversation, "Ben answers", false, camComment);
  await deliverPushes(apns);
  sandbox.received.length = 0;

  // Unfriending hides ben's comment and reply, and alice's acceptance.
  await relationship(web, ben, "remove");
  assert.deepEqual(await pushed(), {
    updates: { alice: 1, ben: 0, cam: 1 },
    alerts: {},
  });

  // A new request sends its alert with the count, and no separate update.
  await relationship(benApp, alice, "request");
  assert.deepEqual(await pushed(), { updates: {}, alerts: { alice: 2 } });

  // Accepting from his profile swaps the request for ben's restored comment,
  // so alice's count stays 2. Ben's acceptance alert carries his count, and
  // cam's restored reply updates hers.
  await relationship(web, ben, "accept");
  assert.deepEqual(await pushed(), {
    updates: { cam: 2 },
    alerts: { ben: 1 },
  });

  // Cam blocking and unblocking ben hides and restores his reply for her only.
  await relationship(camApp, ben, "block");
  assert.deepEqual(await pushed(), { updates: { cam: 1 }, alerts: {} });
  await relationship(camApp, ben, "unblock");
  assert.deepEqual(await pushed(), { updates: { cam: 2 }, alerts: {} });

  // Blocking a friend hides what unfriending does. Unblocking restores no
  // friendship, so nothing returns and no count changes.
  await relationship(web, ben, "block");
  assert.deepEqual(await pushed(), {
    updates: { alice: 1, ben: 0, cam: 1 },
    alerts: {},
  });
  await relationship(web, ben, "unblock");
  assert.deepEqual(await pushed(), { updates: {}, alerts: {} });

  // Declining from his profile removes the unread request.
  await relationship(benApp, alice, "request");
  assert.deepEqual(await pushed(), { updates: {}, alerts: { alice: 2 } });
  await relationship(web, ben, "remove");
  assert.deepEqual(await pushed(), { updates: { alice: 1 }, alerts: {} });

  // Accepting from the bell also restores cam's reply.
  await relationship(benApp, alice, "request");
  assert.deepEqual(await pushed(), { updates: {}, alerts: { alice: 2 } });
  const request = await latest(alice);
  const response = await act(app, "respond-friend-request", {
    id: request,
    action: "accept",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await pushed(), {
    updates: { cam: 2 },
    alerts: { ben: 1 },
  });

  // A failed change rolls back and queues nothing.
  const failed = await act(web, "relationship", {
    target: cam,
    action: "accept",
  });
  assert.equal(failed.status, 404);
  assert.equal(await jobs(), 0);
});

test("removing a reply updates the badge of each member who had it unread", async () => {
  const { alice, ben, cam, conversation } = await setup();
  const web = { cookie: await cookieFor(alice) };
  await device(alice, tokenA);
  const benApp = { bearer: await device(ben, tokenB) };
  await device(cam, tokenC);
  await friend(ben, alice);
  await friend(cam, alice);
  const camComment = await addComment(cam, conversation, "Cam's take", false);
  const answer = await addComment(
    ben,
    conversation,
    "Answer",
    false,
    camComment,
  );
  const benComment = await addComment(ben, conversation, "Ben's take", false);
  await deliverPushes(apns);
  sandbox.received.length = 0;
  const remove = async (client: Client, id: string) =>
    assert.equal((await act(client, "remove-comment", { id })).status, 200);

  // Of 3 unread for alice and 2 for cam, ben's reply to cam leaves both.
  await remove(benApp, answer);
  assert.deepEqual(await pushed(), {
    updates: { alice: 2, cam: 1 },
    alerts: {},
  });
  // Removing it again changes nothing.
  await remove(benApp, answer);
  assert.deepEqual(await pushed(), { updates: {}, alerts: {} });

  // A comment alice already read leaves her badge as it is.
  await readNotification(alice, await latest(alice));
  assert.deepEqual(await pushed(), { updates: { alice: 1 }, alerts: {} });
  await remove(web, benComment);
  assert.deepEqual(await pushed(), { updates: {}, alerts: {} });

  // The entry's owner removes cam's comment from the web.
  await remove(web, camComment);
  assert.deepEqual(await pushed(), { updates: { alice: 0 }, alerts: {} });
});

test("deleting an account updates the badge of each member whose unread notifications go with it", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await device(alice, tokenA);
  await device(ben, tokenB);
  await device(cam, tokenC);
  await friend(ben, alice);
  await friend(cam, alice);
  await friend(cam, ben);
  const bensEntry = await updateTitleActivity(
    ben,
    "movie:1",
    "recommended",
    true,
  );
  const camOnBen = await addComment(cam, bensEntry, "Cam's take", false);
  await addComment(alice, bensEntry, "Alice answers", false, camOnBen);
  await addComment(ben, conversation, "Ben's take", false);
  await deliverPushes(apns);
  sandbox.received.length = 0;

  // Unread: alice has ben's comment; cam has both acceptances and alice's
  // reply on ben's entry. Ben deletes his account on the web.
  const response = await act(
    { cookie: await cookieFor(ben) },
    "delete-account",
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await pushed(), {
    updates: { alice: 0, cam: 1 },
    alerts: {},
  });
});

test("each APNs host keeps one connection and reconnects after GOAWAY or a lost connection", async () => {
  const { alice } = await setup();
  await device(alice, tokenA);
  const failures = captureFailures();
  for (let round = 0; round < 2; round++) {
    await queueBadgePush(alice);
    await deliverPushes(apns);
  }
  assert.equal(sandbox.received.length, 2);
  assert.equal(sandbox.sessions.length, 1);

  sandbox.goaway();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await queueBadgePush(alice);
  await deliverPushes(apns);
  assert.equal(sandbox.received.length, 3);
  assert.equal(sandbox.sessions.length, 2);

  // An unreachable host leaves the push for a retry.
  await sandbox.close();
  await queueBadgePush(alice);
  await deliverPushes(apns);
  const [failure] = failures.map((line) => JSON.parse(line));
  assert.deepEqual(
    {
      event: failure.event,
      kind: failure.kind,
      final: failure.final,
      status: failure.status,
    },
    {
      event: "push delivery failed",
      kind: "badge",
      final: false,
      status: undefined,
    },
  );
  assert.ok(failure.error, "The connection error is described.");
  assert.equal(await jobs(), 1);
});

test("the worker's push pass deletes expired pushes and sends only with APNs settings", async () => {
  const { alice } = await setup();
  await device(alice, tokenA);
  await queueBadgePush(alice);
  await db.query("UPDATE push_job SET expires_at=now()-interval '1 second'");
  await device(alice, tokenB);
  await queueBadgePush(alice);
  await runPushPass(null, 0);
  assert.equal(await jobs(), 1);
  await runPushPass(apns, 1);
  assert.deepEqual(
    sandbox.received.map(({ token }) => token),
    [tokenB],
  );
  assert.equal(await jobs(), 0);
});

test("without APNs settings the worker skips push delivery and says so once", () => {
  const printed: string[] = [];
  mock.method(console, "log", (line: string) => printed.push(line));
  const failures = captureFailures();
  assert.equal(apnsFromEnvironment({}), null);
  assert.deepEqual(printed, [
    '{"event":"push delivery off","reason":"no APNs settings"}',
  ]);
  assert.deepEqual(failures, []);

  // Incomplete or unreadable settings are failures.
  const key = keys.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  assert.equal(
    apnsFromEnvironment({ APPLE_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: key }),
    null,
  );
  assert.equal(
    apnsFromEnvironment({
      APPLE_TEAM_ID: "TEAM123456",
      APNS_KEY_ID: "KEY1234567",
      APNS_PRIVATE_KEY: "bm90IGEga2V5",
    }),
    null,
  );
  const [missing, invalid] = failures.map((line) => JSON.parse(line));
  assert.deepEqual(missing, {
    event: "push delivery off",
    missing: "APNS_KEY_ID",
  });
  assert.deepEqual(
    { event: invalid.event, reason: invalid.reason },
    { event: "push delivery off", reason: "invalid key" },
  );
  assert.ok(!failures.join("").includes(key.slice(0, 20)));

  const configured = apnsFromEnvironment({
    APPLE_TEAM_ID: "TEAM123456",
    APNS_KEY_ID: "KEY1234567",
    APNS_PRIVATE_KEY: key,
  });
  assert.ok(configured instanceof Apns);
  configured.close();
  assert.equal(printed.length, 1);
});

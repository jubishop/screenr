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
  captureFailures,
} from "./social-fixture";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { changeRelationship } = await import("../../src/server/relationships");
const { addComment, removeComment } = await import("../../src/server/comments");
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

// The iPhone app registers its token over the API with a new bearer session.
async function device(
  user: string,
  token: string,
  environment = "sandbox",
  topic = dev,
) {
  const bearer = await bearerFor(user);
  const response = await POST(
    new Request("http://localhost:3000/api/screenr/push-device", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "register",
        token,
        environment,
        topic,
        build: 42,
      }),
    }),
    { params: Promise.resolve({ action: "push-device" }) },
  );
  assert.equal(response.status, 200);
  return bearer;
}

const latest = async (user: string) => (await notifications(user)).items[0].id;
const bodies = (fake: typeof sandbox) =>
  fake.received.map(({ token, body }) => ({ token, body }));
const jobs = async () =>
  (await db.query("SELECT count(*)::int AS count FROM push_job")).rows[0].count;

test("each new notification pushes its ID, the generic alert, the unread badge, its category, and its thread", async () => {
  const { alice, ben, conversation } = await setup();
  await device(alice, tokenA);
  await device(alice, tokenB, "production", release);
  await device(ben, tokenC);

  await changeRelationship(ben, alice, "request");
  const request = await latest(alice);
  assert.equal(await deliverPushes(apns), 2);
  const friendRequest = {
    aps: { alert, badge: 1, "mutable-content": 1, category: "FRIEND_REQUEST" },
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

  // An acceptance has no actions or conversation.
  await changeRelationship(alice, ben, "accept");
  await deliverPushes(apns);
  assert.deepEqual(bodies(sandbox).at(-1), {
    token: tokenC,
    body: {
      aps: { alert, badge: 1, "mutable-content": 1 },
      notificationId: await latest(ben),
    },
  });

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
  assert.equal(sandbox.received.length + production.received.length, 6);
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

test("only kinds the member left on are pushed", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await device(alice, tokenA);
  await savePushSettings(alice, { comment: false, friendRequest: false });
  const pushed = () =>
    sandbox.received
      .map(({ body }) => (body as { notificationId: string }).notificationId)
      .sort();

  // A comment on her entry and a friend request stay in the bell only; a
  // reply to her comment is pushed.
  const mine = await addComment(alice, conversation, "First!", false);
  await addComment(ben, conversation, "Top-level", false);
  await addComment(ben, conversation, "Answer", false, mine);
  const reply = await latest(alice);
  await changeRelationship(cam, alice, "request");
  await deliverPushes(apns);
  assert.deepEqual(pushed(), [reply]);
  assert.equal(await jobs(), 0);

  await savePushSettings(alice, { comment: true, reply: false });
  await addComment(ben, conversation, "Another", false);
  const comment = await latest(alice);
  await addComment(ben, conversation, "Answer again", false, mine);
  await changeRelationship(alice, outsider, "request");
  await changeRelationship(outsider, alice, "accept");
  const accepted = await latest(alice);
  await deliverPushes(apns);
  assert.deepEqual(pushed(), [reply, comment, accepted].sort());
  // The badge counts every unread notification, pushed or not.
  assert.deepEqual(
    sandbox.received.map(
      ({ body }) => (body as { aps: { badge: number } }).aps.badge,
    ),
    [4, 7, 7],
  );
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
  assert.deepEqual(sandbox.received, []);
  assert.equal(await jobs(), 0);

  await addComment(cam, conversation, "Unfriended before sending", false);
  await changeRelationship(alice, cam, "remove");
  await deliverPushes(apns);
  assert.deepEqual(sandbox.received, []);

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

  for (const { id } of (await notifications(alice)).items)
    await readNotification(alice, id);
  await queueBadgePush(alice);
  await deliverPushes(apns);
  assert.deepEqual(sandbox.received.at(-1)!.body, { aps: { badge: 0 } });
  assert.equal(await jobs(), 0);
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

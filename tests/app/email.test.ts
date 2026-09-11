import { test, before, beforeEach, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.EMAIL_TRANSPORT = "resend";
process.env.RESEND_API_KEY = "test-key-never-used-on-the-network";
process.env.EMAIL_FROM = "Screenr <screenr@example.test>";
const { db } = await import("../../src/server/db");
const { migrate } = await import("../../scripts/migrate");
const { queueCode, deliverOne } = await import("../../src/server/email");
before(migrate);
beforeEach(async () => {
  await db.query("TRUNCATE email_job CASCADE");
});
afterEach(() => mock.restoreAll());
after(() => db.end());

test("email jobs encrypt codes, deliver once under concurrent workers, and clear delivered payloads", async () => {
  await queueCode({ email: "mail@example.test", otp: "123456" });
  const stored = (await db.query("SELECT payload FROM email_job")).rows[0]
    .payload;
  assert.ok(
    !stored.includes("123456") && !stored.includes("mail@example.test"),
  );
  const sent: Record<string, unknown>[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.resend.com/emails");
      sent.push(JSON.parse(String(options.body)));
      return Response.json({ id: "test-provider-id" });
    },
  );
  await Promise.all([deliverOne(), deliverOne()]);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /123456/);
  const job = (await db.query("SELECT * FROM email_job")).rows[0];
  assert.ok(job.sent_at);
  assert.equal(job.payload, "");
  assert.equal(await deliverOne(), false);
});

test("failed delivery backs off and retries with the same provider idempotency key", async () => {
  await queueCode({ email: "retry@example.test", otp: "654321" });
  const keys: string[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      keys.push(new Headers(options.headers).get("Idempotency-Key")!);
      return keys.length === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : Response.json({ id: "success" });
    },
  );
  await deliverOne();
  const job = (
    await db.query("SELECT *,available_at>now() AS delayed FROM email_job")
  ).rows[0];
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, "Resend HTTP 503");
  assert.equal(job.delayed, true);
  assert.equal(job.sent_at, null);
  assert.equal(await deliverOne(), false);
  await db.query("UPDATE email_job SET available_at=now()");
  await deliverOne();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("expired sign-in codes are not delivered", async () => {
  await queueCode({ email: "expired@example.test", otp: "999999" });
  await db.query("UPDATE email_job SET expires_at=now()-interval '1 second'");
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("Must not send an expired code");
  });
  assert.equal(await deliverOne(), false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("requesting a new code replaces an older pending retry for the same recipient", async () => {
  const texts: string[] = [];
  const keys: string[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      texts.push(JSON.parse(String(options.body)).text);
      keys.push(new Headers(options.headers).get("Idempotency-Key")!);
      return texts.length === 1
        ? new Response("unavailable", { status: 503 })
        : Response.json({ id: "success" });
    },
  );
  await queueCode({ email: "newcode@example.test", otp: "111111" });
  await deliverOne();
  await queueCode({ email: "newcode@example.test", otp: "222222" });
  await db.query("UPDATE email_job SET available_at=now()");
  while (await deliverOne()) {
    /* Drain all due jobs. */
  }
  assert.equal(texts.length, 2, "The superseded code must not be retried");
  assert.match(texts[1], /222222/);
  assert.notEqual(
    keys[0],
    keys[1],
    "New content needs a new provider idempotency key",
  );
});

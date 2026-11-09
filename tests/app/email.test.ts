import { test, before, beforeEach, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import {
  db,
  captureFailures,
  assertNotLogged,
  testDatabaseURL,
} from "./social-fixture";

process.env.EMAIL_TRANSPORT = "resend";
process.env.RESEND_API_KEY = "test-key-never-used-on-the-network";
process.env.EMAIL_FROM = "Screenr <screenr@example.test>";
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
  const printed = captureFailures();
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
  // Only the failed attempt logs.
  assert.deepEqual(
    printed.map((line) => JSON.parse(line)),
    [
      {
        event: "email delivery failed",
        job: job.id,
        kind: "code",
        attempt: 1,
        status: 503,
        final: false,
      },
    ],
  );
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
  const printed = captureFailures();
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
  const { id } = (await db.query("SELECT id FROM email_job")).rows[0];
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
  // Only the older code's failed attempt logs.
  assert.deepEqual(
    printed.map((line) => JSON.parse(line)),
    [
      {
        event: "email delivery failed",
        job: id,
        kind: "code",
        attempt: 1,
        status: 503,
        final: false,
      },
    ],
  );
});

async function retryNow() {
  await db.query("UPDATE email_job SET available_at=now()");
  return deliverOne();
}

test("each Resend failure logs the job, attempt, status, and provider error without the recipient, code, or key", async () => {
  await queueCode({ email: "private-recipient@example.test", otp: "246810" });
  const { id } = (await db.query("SELECT id FROM email_job")).rows[0];
  mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        statusCode: 429,
        name: "daily_quota_exceeded",
        message: "Quota reached sending to private-recipient@example.test",
      },
      { status: 429 },
    ),
  );
  const printed = captureFailures();
  await deliverOne();
  await retryNow();
  const failure = {
    event: "email delivery failed",
    job: id,
    kind: "code",
    status: 429,
    provider: "daily_quota_exceeded",
    final: false,
  };
  assert.deepEqual(
    printed.map((line) => JSON.parse(line)),
    [
      { ...failure, attempt: 1 },
      { ...failure, attempt: 2 },
    ],
  );
  for (const value of [
    "private-recipient",
    "246810",
    "Quota reached",
    "sign-in code",
    process.env.RESEND_API_KEY!,
  ])
    assert.ok(!printed.join("\n").includes(value), `Logged ${value}`);
});

test("network failures log the error class, cause code, and stack without messages", async () => {
  await queueCode({ email: "network@example.test", otp: "112233" });
  const { id } = (await db.query("SELECT id FROM email_job")).rows[0];
  mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("getaddrinfo ENOTFOUND network@example.test"),
        { code: "ENOTFOUND" },
      ),
    });
  });
  const printed = captureFailures();
  await deliverOne();
  assert.equal(printed.length, 1);
  const { stack, ...fields } = JSON.parse(printed[0]);
  assert.deepEqual(fields, {
    event: "email delivery failed",
    job: id,
    kind: "code",
    attempt: 1,
    final: false,
    error: "TypeError",
    cause: { error: "Error", code: "ENOTFOUND" },
  });
  assert.ok(
    stack.length > 0 && stack.every((frame: string) => /^at /.test(frame)),
  );
  assertNotLogged(printed, [
    "fetch failed",
    "getaddrinfo",
    "network@example.test",
  ]);
});

test("permanent Resend rejections are not retried; timeouts, conflicts, limits, and server errors are", async () => {
  const cases: [number, boolean][] = [
    [408, true],
    [409, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
    [422, false],
    [403, false],
  ];
  for (const [status, retried] of cases) {
    await db.query("TRUNCATE email_job CASCADE");
    await queueCode({ email: "rejected@example.test", otp: "135790" });
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      Response.json({ name: "validation_error" }, { status }),
    );
    const printed = captureFailures();
    await deliverOne();
    await retryNow();
    assert.equal(fetchMock.mock.callCount(), retried ? 2 : 1, `HTTP ${status}`);
    assert.equal(JSON.parse(printed[0]).final, !retried, `HTTP ${status}`);
    const job = (await db.query("SELECT * FROM email_job")).rows[0];
    assert.equal(job.last_error, `Resend HTTP ${status}`);
    assert.equal(job.sent_at, null);
    mock.restoreAll();
  }
  // The last case left a permanently rejected code. Once the cause is fixed,
  // a new request for the same address replaces it and is delivered.
  const sent: string[] = [];
  await queueCode({ email: "rejected@example.test", otp: "975310" });
  mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      sent.push(JSON.parse(String(options.body)).text);
      return Response.json({ id: "success" });
    },
  );
  assert.equal(await deliverOne(), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /975310/);
});

async function until(condition: () => boolean, limit = 2_000) {
  const deadline = Date.now() + limit;
  while (!condition() && Date.now() < deadline) await setTimeout(5);
  assert.ok(condition(), "Timed out");
}

test("a send whose result cannot be recorded holds its job for a minute, then retries with the same idempotency key", async () => {
  await queueCode({ email: "unrecorded@example.test", otp: "102938" });
  const printed = captureFailures();
  const keys: string[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      keys.push(new Headers(options.headers).get("Idempotency-Key")!);
      // The database fails while Resend accepts the first request, so the
      // worker cannot record that it was sent. A worker that still locked
      // the job would fail the rename after a second instead of hanging.
      if (keys.length === 1)
        await db.query(
          "SET lock_timeout='1s'; ALTER TABLE email_job RENAME TO email_job_hidden; RESET lock_timeout",
        );
      return Response.json({ id: "sent" });
    },
  );
  try {
    await assert.rejects(deliverOne(), { code: "42P01" });
  } finally {
    await db.query(
      "ALTER TABLE IF EXISTS email_job_hidden RENAME TO email_job",
    );
  }
  assert.equal(db.idleCount, db.totalCount, "No client stays checked out");
  // The worker loop logs the failed pass; Resend accepted the send.
  assert.deepEqual(printed, []);
  const job = (
    await db.query(
      `SELECT attempts,sent_at,available_at BETWEEN now()+interval '50 seconds'
      AND now()+interval '1 minute' AS held FROM email_job`,
    )
  ).rows[0];
  assert.deepEqual(job, { attempts: 0, sent_at: null, held: true });
  assert.equal(await deliverOne(), false);
  await db.query("UPDATE email_job SET available_at=now()");
  assert.equal(await deliverOne(), true);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok((await db.query("SELECT sent_at FROM email_job")).rows[0].sent_at);
});

test("a new code requested while the last one is being sent does not wait for Resend, and is sent next", async () => {
  await queueCode({ email: "again@example.test", otp: "111111" });
  let requested!: () => void;
  let answer!: () => void;
  const arrived = new Promise<void>((resolve) => (requested = resolve));
  const reply = new Promise<void>((resolve) => (answer = resolve));
  const texts: string[] = [];
  mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      texts.push(JSON.parse(String(options.body)).text);
      if (texts.length === 1) {
        requested();
        await reply;
      }
      return Response.json({ id: "sent" });
    },
  );
  const delivery = deliverOne();
  const timer = new AbortController();
  try {
    await arrived;
    await Promise.race([
      queueCode({ email: "again@example.test", otp: "222222" }),
      setTimeout(1000, undefined, { signal: timer.signal }).then(
        () => assert.fail("The new code waited for the last send."),
        () => {},
      ),
    ]);
  } finally {
    timer.abort();
    answer();
    await delivery;
  }
  // Recording the first send leaves the new code pending.
  assert.equal(await deliverOne(), true);
  assert.equal(texts.length, 2);
  assert.match(texts[1], /222222/);
  assert.equal(await deliverOne(), false);
});

// The worker runs as its own process with the suite's database and Resend
// settings. Its fetch always fails, so it can never reach Resend.
const worker = [
  "--import",
  "tsx",
  "--import",
  "data:text/javascript,globalThis.fetch=()=>Promise.reject(new Error('No network in worker tests'))",
  "scripts/worker.ts",
];

test("the worker refuses to start without the Resend transport, key, and sender", async () => {
  await Promise.all(
    ["EMAIL_TRANSPORT", "RESEND_API_KEY", "EMAIL_FROM"].map(async (name) => {
      const { stderr } = await promisify(execFile)(process.execPath, worker, {
        env: { ...process.env, [name]: "" },
        timeout: 15_000,
      }).then(
        () => assert.fail(`The worker must not start without ${name}.`),
        (error: Error & { stderr: string }) => error,
      );
      assert.match(
        stderr,
        /Configure the Resend transport, API key, and sender before starting the worker\./,
      );
    }),
  );
});

test("the worker deletes expired jobs on its first pass and exits cleanly on SIGTERM", async () => {
  // No member left by another suite can queue activity email for the worker.
  await db.query('TRUNCATE "user" CASCADE');
  await queueCode({ email: "stale@example.test", otp: "000000" });
  await db.query("UPDATE email_job SET expires_at=now()-interval '1 second'");
  const child = spawn(process.execPath, worker, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const exited = once(child, "exit");
  try {
    // The worker handles SIGTERM before its first pass, which deletes
    // expired jobs.
    const deadline = Date.now() + 15_000;
    while ((await db.query("SELECT 1 FROM email_job")).rowCount) {
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, `No expired job cleanup. ${output}`);
      await setTimeout(50);
    }
    child.kill("SIGTERM");
    // A stopping worker finishes its pass, ends its pause early, then closes
    // the database pool and exits.
    const [code, signal] = await Promise.race([
      exited,
      setTimeout(5_000).then(() => assert.fail("The worker did not stop.")),
    ]);
    // Push delivery, without APNs settings, says once that it is off.
    // Nothing else is printed.
    assert.deepEqual(
      { code, signal, output },
      {
        code: 0,
        signal: null,
        output: '{"event":"push delivery off","reason":"no APNs settings"}\n',
      },
    );
  } finally {
    child.kill("SIGKILL");
  }
});

test("the worker keeps running while PostgreSQL is unreachable, logs the email loop's failure and the push loop's cleanup failure once, and stops during its backoff", async () => {
  // A loopback port that nothing listens on.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const unreachable = new URL(testDatabaseURL);
  unreachable.port = String(port);
  const child = spawn(process.execPath, worker, {
    env: { ...process.env, DATABASE_URL: unreachable.href },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const exited = once(child, "exit");
  const lines = () =>
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    // The email loop's first pass fails at once and waits two seconds; its
    // second fails again without a line, and it then waits four seconds.
    // Without APNs settings, the push loop's first pass only runs its
    // cleanup, whose failure never fails the pass, and the passes after it
    // need no database. Stopping half a second into the email loop's
    // four-second pause shows that SIGTERM ends it early.
    const logged = (event: string) =>
      lines().some((line) => line.event === event);
    await until(
      () => logged("worker failed") && logged("worker cleanup failed"),
      10_000,
    );
    await setTimeout(2_500);
    assert.equal(child.exitCode, null, output);
    child.kill("SIGTERM");
    // A stopping worker ends its pause early.
    const [code, signal] = await Promise.race([
      exited,
      setTimeout(2_000).then(() => assert.fail("The worker did not stop.")),
    ]);
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, output);
    const failed = {
      error: "Error",
      code: "ECONNREFUSED",
    };
    assert.deepEqual(
      lines()
        .map(({ stack, ...fields }) => fields)
        .sort((a, b) => a.event.localeCompare(b.event)),
      [
        { event: "push delivery off", reason: "no APNs settings" },
        { event: "worker cleanup failed", step: "push jobs", ...failed },
        { event: "worker failed", failures: 1, ...failed },
      ],
    );
  } finally {
    child.kill("SIGKILL");
  }
});

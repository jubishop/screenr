import { test, before, beforeEach, after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { db, captureFailures } from "./social-fixture";

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
  captureFailures();
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
  captureFailures();
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
  for (const value of ["fetch failed", "getaddrinfo", "network@example.test"])
    assert.ok(!printed[0].includes(value), `Logged ${value}`);
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
  // The first start also runs the one-time Google photo backfill.
  await db.query("DELETE FROM screenr_backfill");
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
    // expired jobs, and before the backfill records its marker.
    const deadline = Date.now() + 15_000;
    while (
      (await db.query("SELECT 1 FROM email_job")).rowCount ||
      !(await db.query("SELECT 1 FROM screenr_backfill")).rowCount
    ) {
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, `No expired job cleanup. ${output}`);
      await setTimeout(50);
    }
    child.kill("SIGTERM");
    // A stopping worker finishes its pass and its one-second pause, then
    // closes the database pool and exits.
    const [code, signal] = await Promise.race([
      exited,
      setTimeout(5_000).then(() => assert.fail("The worker did not stop.")),
    ]);
    // Push delivery, without APNs settings, says once that it is off. The
    // backfill, with no Google members, reports its counts. Nothing else is
    // printed.
    assert.deepEqual(
      { code, signal, output },
      {
        code: 0,
        signal: null,
        output:
          '{"event":"push delivery off","reason":"no APNs settings"}\n' +
          '{"event":"google photo backfill finished","copied":0,"kept":0,"no picture":0,"failed":0}\n',
      },
    );
  } finally {
    child.kill("SIGKILL");
    await db.query("DELETE FROM screenr_backfill");
  }
});

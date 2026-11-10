import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import {
  useDatabase,
  db,
  cookieFor,
  captureFailures,
  assertNotLogged,
  person,
} from "./social-fixture";
import {
  logged,
  until,
  failWorkerPass,
  postRejectedComment,
  envelope,
  acceptReports,
} from "./failure-fixture";

// How failures reach Sentry (docs/deployment.md#failure-reports-in-sentry):
// envelopes, request ID tags, rejected or unreachable endpoints, invalid
// DSNs, and hourly folding. failure-logs.test.ts covers the lines they print.

const { GET } = await import("../../src/app/api/screenr/[action]/route");
const { logFailure } = await import("../../src/server/log");
useDatabase();
// Fake Sentry endpoints still open after a failed test.
const endpoints = new Set<Server>();
afterEach(() => {
  mock.restoreAll();
  delete process.env.SENTRY_DSN;
  for (const server of endpoints) {
    server.closeAllConnections();
    server.close();
  }
  endpoints.clear();
});

type Report = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  reply: (status: number) => void;
};

// A loopback Sentry endpoint named by SENTRY_DSN. It holds each envelope's
// reply until the test sends it, so a caller that waited for Sentry would
// never finish.
async function fakeSentry() {
  const arrived: Report[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    arrived.push({
      path: request.url!,
      headers: request.headers,
      body,
      reply: (status) =>
        void response.writeHead(status, { Connection: "close" }).end(),
    });
  });
  endpoints.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.SENTRY_DSN = `http://public-key@127.0.0.1:${port}/42`;
  return {
    async next() {
      await until(() => arrived.length > 0);
      return arrived.shift()!;
    },
    // A report from a process, which load can hold up for seconds: only a
    // hang reaches the bound. A process that exits first never sent one.
    async fromProcess(child: ChildProcess, output: () => string) {
      for (let waited = 0; !arrived.length; waited += 20) {
        assert.ok(
          waited < hang && child.exitCode === null,
          `No Sentry report.\n${output()}`,
        );
        await setTimeout(20);
      }
      return arrived.shift()!;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The bound on a wait for another process, which only a hang reaches:
// memory/process-test-waits.md
const hang = 180_000;

// Runs screenr-worker as its own process with the suite's database. Its
// data: import lets fetch reach only the loopback Sentry endpoint, and makes
// SIGUSR2 run `crash` in a signal listener, outside the worker's loops, as
// a crash in a timer or event listener would. Its error message is
// CRASH_DETAIL, which nothing may print or send.
function crashingWorker(crash: string, env: Record<string, string>) {
  const probe = `
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, init) => String(url).startsWith("http://127.0.0.1:")
      ? fetch(url, init) : Promise.reject(new Error("No network in worker tests"));
    process.on("SIGUSR2", () => { ${crash}; });`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(probe)}`,
      "scripts/worker.ts",
    ],
    {
      env: {
        ...process.env,
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "test-key-never-used-on-the-network",
        EMAIL_FROM: "Screenr <screenr@example.test>",
        CRASH_DETAIL: "Private crash detail 271828",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.on("data", (data) => (stderr += data));
  const closed = once(child, "close");
  const output = () => `${stdout}${stderr}`;
  return {
    child,
    output,
    stderr: () => stderr,
    // The worker says push delivery is off after it starts handling crashes.
    async ready() {
      for (
        let waited = 0;
        !stdout.includes('"push delivery off"');
        waited += 20
      ) {
        assert.ok(
          waited < hang && child.exitCode === null,
          `The worker did not start.\n${output()}`,
        );
        await setTimeout(20);
      }
    },
    async exit() {
      const timer = new AbortController();
      const [code, signal] = await Promise.race([
        closed,
        setTimeout(hang, undefined, { signal: timer.signal }).then(() =>
          assert.fail(`The worker did not exit.\n${output()}`),
        ),
      ]);
      timer.abort();
      return { code, signal };
    },
  };
}

test("with a Sentry DSN, a request failure is also sent as an envelope with the logged fields and frames but no message, and the response does not wait for it", async () => {
  const sentry = await fakeSentry();
  const printed = captureFailures();
  const { response, privateValues } = await postRejectedComment();
  // The endpoint has not replied yet.
  assert.equal(response.status, 500);
  const report = await sentry.next();
  report.reply(200);
  await sentry.close();
  assert.equal(report.path, "/api/42/envelope/");
  assert.equal(report.headers["content-type"], "application/x-sentry-envelope");
  assert.match(
    String(report.headers["x-sentry-auth"]),
    /^Sentry sentry_version=7, sentry_key=public-key, sentry_client=screenr\/\S+$/,
  );
  const { fields, stack } = logged(printed);
  const { event_id, timestamp, environment, exception, ...event } = envelope(
    report.body,
  );
  assert.ok(Math.abs(timestamp - Date.now() / 1000) < 60);
  assert.equal(typeof environment, "string");
  // Nothing else is sent: the logged fields, apart from the stack, are the
  // failure context, and no message or log entry is present.
  assert.deepEqual(event, {
    platform: "node",
    level: "error",
    tags: {
      event: "request failed",
      request_id: response.headers.get("Screenr-Request-Id"),
    },
    contexts: { failure: fields },
  });
  assert.equal(exception.values.length, 1);
  const [{ stacktrace, ...thrown }] = exception.values;
  // The log event stands in for the error message.
  assert.deepEqual(thrown, {
    type: "DatabaseError",
    value: "request failed",
    mechanism: { type: "generic", handled: true },
  });
  // Sentry lists frames from the outermost call to the failing one.
  const frames = stacktrace.frames.toReversed();
  assert.equal(frames.length, stack.length);
  frames.forEach((frame: Record<string, unknown>, index: number) =>
    assert.ok(
      stack[index].includes(`:${frame.lineno}:${frame.colno}`),
      stack[index],
    ),
  );
  const query = frames.find(
    (frame: Record<string, unknown>) =>
      frame.filename === "src/server/comments.ts",
  );
  assert.ok(query?.in_app, "The frames lead back to the failing query");
  assert.match(query.abs_path, /^\/.+\/src\/server\/comments\.ts$/);
  assertNotLogged([report.body], [...privateValues, "Private comment"]);
});

test("a Sentry report tags the failure's request ID, and a rejected report prints its status without reaching the caller", async () => {
  const sentry = await fakeSentry();
  const printed = captureFailures();
  const message = "Private detail 271828";
  assert.equal(
    logFailure(
      "request failed",
      { action: "comment", requestId: "3f2a9c" },
      new TypeError(message),
    ),
    undefined,
  );
  const report = await sentry.next();
  const event = envelope(report.body);
  assert.deepEqual(event.tags, {
    event: "request failed",
    request_id: "3f2a9c",
  });
  assert.equal(event.contexts.failure.requestId, "3f2a9c");
  report.reply(429);
  await until(() => printed.length === 2);
  await sentry.close();
  assert.deepEqual(JSON.parse(printed[1]), {
    event: "sentry report failed",
    status: 429,
  });
  assertNotLogged([report.body, ...printed], [message]);
});

test("an unreachable Sentry endpoint prints the network error without reaching the caller", async () => {
  const sentry = await fakeSentry();
  await sentry.close();
  const printed = captureFailures();
  logFailure("worker failed", {}, new Error("Private detail 314159"));
  await until(() => printed.length === 2);
  assert.deepEqual(JSON.parse(printed[1]), {
    event: "sentry report failed",
    error: "TypeError",
    cause: { error: "Error", code: "ECONNREFUSED" },
  });
});

test("a Sentry DSN without a key and project ID prints that it is invalid and sends nothing", () => {
  process.env.SENTRY_DSN = "https://sentry.example.test/";
  const fetch = mock.method(globalThis, "fetch");
  const printed = captureFailures();
  logFailure("worker failed", {}, new Error("Private detail 141421"));
  assert.equal(printed.length, 2);
  assert.deepEqual(JSON.parse(printed[1]), {
    event: "sentry report failed",
    reason: "invalid DSN",
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("without a Sentry DSN, a failure is only logged", () => {
  const fetch = mock.method(globalThis, "fetch");
  const printed = captureFailures();
  logFailure("worker failed", {}, new Error("Private detail 161803"));
  assert.equal(printed.length, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test("a failed email worker pass is also reported to Sentry", async () => {
  const sentry = await fakeSentry();
  const printed = captureFailures();
  await db.query("ALTER TABLE email_job RENAME TO email_job_hidden");
  try {
    await failWorkerPass(printed);
  } finally {
    await db.query("ALTER TABLE email_job_hidden RENAME TO email_job");
  }
  const report = await sentry.next();
  report.reply(200);
  await sentry.close();
  const event = envelope(report.body);
  assert.deepEqual(event.contexts.failure, {
    event: "worker failed",
    failures: 1,
    error: "DatabaseError",
    code: "42P01",
  });
  assert.equal(event.exception.values[0].value, "worker failed");
  assert.ok(
    event.exception.values[0].stacktrace.frames.some(
      (frame: Record<string, unknown>) =>
        frame.filename === "src/server/email.ts",
    ),
  );
});

test("polls that fail the same way, as in a database outage, each log a line with their request ID, but only the first goes to Sentry, while another action's failure goes at once", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  const sent = acceptReports();
  const printed = captureFailures();
  async function poll(action: string) {
    const response = await GET(
      new Request(`http://localhost:3000/api/screenr/${action}`, {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ action }) },
    );
    assert.equal(response.status, 500);
    return response.headers.get("Screenr-Request-Id");
  }
  // The notification sheet's poll and the screen's poll both read it.
  await db.query(
    "ALTER VIEW visible_notification RENAME TO visible_notification_hidden",
  );
  try {
    const polls = [];
    for (let count = 0; count < 20; count++)
      polls.push(await poll("notifications"));
    const screen = await poll("screen");
    polls.push(await poll("notifications"));
    const lines = printed.map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map(({ action, requestId, error, code }) => ({
        action,
        requestId,
        error,
        code,
      })),
      [...polls.slice(0, 20), screen, polls[20]].map((requestId, index) => ({
        action: index === 20 ? "screen" : "notifications",
        requestId,
        error: "DatabaseError",
        code: "42P01",
      })),
    );
    assert.equal(new Set(lines.map(({ requestId }) => requestId)).size, 22);
    assert.deepEqual(
      sent().map(({ tags, contexts }) => ({
        action: contexts.failure.action,
        request_id: tags.request_id,
        folded: contexts.failure.folded,
      })),
      [
        { action: "notifications", request_id: polls[0], folded: undefined },
        { action: "screen", request_id: screen, folded: undefined },
      ],
    );
  } finally {
    await db.query(
      "ALTER VIEW visible_notification_hidden RENAME TO visible_notification",
    );
  }
});

test("after a kind's first report, Sentry gets the failures folded in the next hour as one report with their number and the latest request ID, hourly while they continue, until an hour passes without one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hour = 60 * 60 * 1000;
  const sent = acceptReports();
  const printed = captureFailures();
  const fail = (requestId: string, code: string) =>
    logFailure(
      "request failed",
      { action: "notifications", method: "GET", status: 500, requestId },
      Object.assign(new Error("Private detail 299792"), { code }),
    );
  const reports = () =>
    sent().map(({ tags, contexts }) => {
      assert.equal(contexts.failure.requestId, tags.request_id);
      const { requestId, folded, code } = contexts.failure;
      return folded === undefined
        ? { requestId, code }
        : { requestId, code, folded };
    });
  fail("a1", "ECONNREFUSED");
  fail("a2", "ECONNREFUSED");
  fail("a3", "ECONNREFUSED");
  // Another code is another kind.
  fail("b1", "57P03");
  assert.deepEqual(reports(), [
    { requestId: "a1", code: "ECONNREFUSED" },
    { requestId: "b1", code: "57P03" },
  ]);
  t.mock.timers.tick(hour - 1);
  assert.equal(reports().length, 2);
  t.mock.timers.tick(1);
  // The second kind folded nothing, so its next failure reports at once.
  fail("b2", "57P03");
  fail("a4", "ECONNREFUSED");
  assert.deepEqual(reports().slice(2), [
    { requestId: "a3", code: "ECONNREFUSED", folded: 2 },
    { requestId: "b2", code: "57P03" },
  ]);
  t.mock.timers.tick(hour);
  assert.deepEqual(reports().slice(4), [
    { requestId: "a4", code: "ECONNREFUSED", folded: 1 },
  ]);
  // An hour without a failure of the kind ends its fold.
  t.mock.timers.tick(hour);
  assert.equal(reports().length, 5);
  fail("a5", "ECONNREFUSED");
  assert.deepEqual(reports().slice(5), [
    { requestId: "a5", code: "ECONNREFUSED" },
  ]);
  // The journal keeps a line for every failure.
  assert.deepEqual(
    printed.map((line) => JSON.parse(line).requestId),
    ["a1", "a2", "a3", "b1", "b2", "a4", "a5"],
  );
  assertNotLogged(
    [...printed, ...sent().map((event) => JSON.stringify(event))],
    ["Private detail"],
  );
});

test("an uncaught exception or unhandled rejection in the worker logs `worker crashed`, reaches Sentry, and only then exits with a failure, so systemd restarts it", async () => {
  for (const [origin, error, crash] of [
    [
      "uncaughtException",
      "TypeError",
      "throw new TypeError(process.env.CRASH_DETAIL)",
    ],
    [
      "unhandledRejection",
      "RangeError",
      "Promise.reject(new RangeError(process.env.CRASH_DETAIL))",
    ],
  ]) {
    const sentry = await fakeSentry();
    const worker = crashingWorker(crash, {
      SENTRY_DSN: process.env.SENTRY_DSN!,
    });
    try {
      await worker.ready();
      worker.child.kill("SIGUSR2");
      const report = await sentry.fromProcess(worker.child, worker.output);
      // The worker waits for Sentry's reply before it exits.
      assert.equal(worker.child.exitCode, null, worker.output());
      report.reply(200);
      assert.deepEqual(
        await worker.exit(),
        { code: 1, signal: null },
        worker.output(),
      );
      const failure = { event: "worker crashed", origin, error };
      const lines = worker
        .stderr()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        lines.map(({ stack, ...fields }) => fields),
        [failure],
        worker.output(),
      );
      assert.ok(lines[0].stack.length > 0);
      const event = envelope(report.body);
      assert.deepEqual(event.contexts.failure, failure);
      assert.equal(event.exception.values[0].type, error);
      assert.equal(event.exception.values[0].value, "worker crashed");
      assert.equal(event.tags.event, "worker crashed");
      assertNotLogged([worker.output(), report.body], ["271828"]);
    } finally {
      worker.child.kill("SIGKILL");
      await sentry.close();
      delete process.env.SENTRY_DSN;
    }
  }
});

test("without a Sentry DSN, a worker crash only logs `worker crashed` and exits with a failure", async () => {
  const worker = crashingWorker(
    "throw new TypeError(process.env.CRASH_DETAIL)",
    { SENTRY_DSN: "" },
  );
  try {
    await worker.ready();
    worker.child.kill("SIGUSR2");
    assert.deepEqual(
      await worker.exit(),
      { code: 1, signal: null },
      worker.output(),
    );
    const [{ stack, ...fields }, ...rest] = worker
      .stderr()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      { fields, rest },
      {
        fields: {
          event: "worker crashed",
          origin: "uncaughtException",
          error: "TypeError",
        },
        rest: [],
      },
    );
    assert.ok(stack.length > 0);
    assertNotLogged([worker.output()], ["271828"]);
  } finally {
    worker.child.kill("SIGKILL");
  }
});

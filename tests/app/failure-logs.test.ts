import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import {
  useDatabase,
  db,
  setup,
  cookieFor,
  captureFailures,
} from "./social-fixture";

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { initialScreen } = await import("../../src/server/screens");
const { runWorkerPass } = await import("../../src/server/email");
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

// Each failure prints one JSON line. Its stack holds only frames, so the
// remaining fields are compared exactly: nothing else may be logged.
function logged(printed: string[]) {
  assert.equal(printed.length, 1, printed.join("\n"));
  const { stack, ...fields } = JSON.parse(printed[0]);
  assert.ok(Array.isArray(stack) && stack.length > 0, printed[0]);
  for (const frame of stack) assert.match(frame, /^at /);
  return { fields, stack: stack as string[] };
}

// loadScreen rejects when its screen read fails while its unread count, a
// single query, may still run. Let it finish before the schema is restored or
// the next test resets tables, so their locks cannot deadlock.
async function settled() {
  while (db.idleCount < db.totalCount) await setTimeout(5);
}

function excludes(printed: string[], values: string[]) {
  for (const value of values)
    assert.ok(!printed.join("\n").includes(value), `Logged ${value}`);
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 400 && !condition(); wait++) await setTimeout(5);
  assert.ok(condition(), "Timed out");
}

// Posts a comment that only a probe check constraint rejects, so the request
// fails unexpectedly. PostgreSQL's message names the constraint and its detail
// repeats the whole failing row. Returns the private values the request held.
async function postRejectedComment() {
  const { alice, conversation } = await setup();
  const cookie = await cookieFor(alice);
  const comment = "Private comment text 4815162342";
  await db.query(
    `ALTER TABLE comment ADD CONSTRAINT failure_log_probe CHECK (body <> '${comment}') NOT VALID`,
  );
  try {
    const response = await POST(
      new Request("http://localhost:3000/api/screenr/comment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify({ conversation, body: comment, spoiler: false }),
      }),
      { params: Promise.resolve({ action: "comment" }) },
    );
    const privateValues = [
      comment,
      alice,
      conversation,
      "alice@example.test",
      ...cookie.split("; ").map((pair) => pair.split("=")[1]),
      "violates",
      "Failing row",
    ];
    return { response, privateValues };
  } finally {
    await db.query("ALTER TABLE comment DROP CONSTRAINT failure_log_probe");
  }
}

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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// An envelope is a header line, then one item header and its event.
function envelope(body: string) {
  const lines = body.trimEnd().split("\n");
  assert.equal(lines.length, 3, body);
  const [header, item, event] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(item, { type: "event" });
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(header.event_id, event.event_id);
  return event;
}

test("an unexpected database failure in a request logs its action, error class, code, constraint, and stack without request data", async () => {
  const printed = captureFailures();
  const { response, privateValues } = await postRejectedComment();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Something went wrong. Please try again.",
  });
  const { fields, stack } = logged(printed);
  assert.deepEqual(fields, {
    event: "request failed",
    action: "comment",
    method: "POST",
    status: 500,
    error: "DatabaseError",
    code: "23514",
    constraint: "failure_log_probe",
    table: "comment",
  });
  assert.ok(
    stack.some((frame) => frame.includes("src/server/comments.ts")),
    "The stack leads back to the failing query",
  );
  excludes(printed, privateValues);
});

test("an unexpected page failure logs its route kind, error class, code, and stack without the path", async () => {
  const { alice } = await setup();
  const query = "private search words";
  // The search screen reads saved services last, after its other queries.
  await db.query(
    "ALTER TABLE member_streaming_service RENAME TO member_streaming_service_hidden",
  );
  try {
    const printed = captureFailures();
    assert.deepEqual(
      await initialScreen(alice, `/search?q=${encodeURIComponent(query)}`),
      {
        data: null,
        error: "This page could not load. Please try again.",
        status: 500,
      },
    );
    const { fields, stack } = logged(printed);
    assert.deepEqual(fields, {
      event: "page failed",
      route: "search",
      error: "DatabaseError",
      code: "42P01",
    });
    assert.ok(
      stack.some((frame) => frame.includes("src/server/streaming-services.ts")),
    );
    excludes(printed, [query, encodeURIComponent(query), alice, "exist"]);
  } finally {
    await settled();
    await db.query(
      "ALTER TABLE member_streaming_service_hidden RENAME TO member_streaming_service",
    );
  }
});

test("expected page errors show their message and log nothing", async () => {
  const { alice } = await setup();
  const printed = captureFailures();
  assert.deepEqual(await initialScreen(alice, "/watch-together"), {
    data: null,
    error: "Choose one friend from their profile.",
    status: 400,
  });
  await settled();
  assert.deepEqual(printed, []);
});

test("a failed email worker pass logs its error class, code, and stack", async () => {
  await db.query("ALTER TABLE email_job RENAME TO email_job_hidden");
  try {
    const printed = captureFailures();
    await runWorkerPass(1);
    const { fields, stack } = logged(printed);
    assert.deepEqual(fields, {
      event: "worker failed",
      error: "DatabaseError",
      code: "42P01",
    });
    assert.ok(stack.some((frame) => frame.includes("src/server/email.ts")));
    excludes(printed, ["exist"]);
  } finally {
    await db.query("ALTER TABLE email_job_hidden RENAME TO email_job");
  }
});

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
    tags: { event: "request failed" },
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
  excludes([report.body], [...privateValues, "Private comment"]);
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
  excludes([report.body, ...printed], [message]);
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
  captureFailures();
  await db.query("ALTER TABLE email_job RENAME TO email_job_hidden");
  try {
    await runWorkerPass(1);
  } finally {
    await db.query("ALTER TABLE email_job_hidden RENAME TO email_job");
  }
  const report = await sentry.next();
  report.reply(200);
  await sentry.close();
  const event = envelope(report.body);
  assert.deepEqual(event.contexts.failure, {
    event: "worker failed",
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

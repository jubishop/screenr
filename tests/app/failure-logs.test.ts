import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
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
useDatabase();
afterEach(() => mock.restoreAll());

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

test("an unexpected database failure in a request logs its action, error class, code, constraint, and stack without request data", async () => {
  const { alice, conversation } = await setup();
  const cookie = await cookieFor(alice);
  const comment = "Private comment text 4815162342";
  // A check that only this comment violates. PostgreSQL's message names the
  // constraint and its detail repeats the whole failing row.
  await db.query(
    `ALTER TABLE comment ADD CONSTRAINT failure_log_probe CHECK (body <> '${comment}') NOT VALID`,
  );
  try {
    const printed = captureFailures();
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
    excludes(printed, [
      comment,
      alice,
      conversation,
      "alice@example.test",
      ...cookie.split("; ").map((pair) => pair.split("=")[1]),
      "violates",
      "Failing row",
    ]);
  } finally {
    await db.query("ALTER TABLE comment DROP CONSTRAINT failure_log_probe");
  }
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
      { data: null, error: "This page could not load. Please try again." },
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

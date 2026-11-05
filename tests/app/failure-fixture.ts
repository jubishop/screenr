import { mock } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { db, setup, cookieFor } from "./social-fixture";

// What failure-logs.test.ts and sentry-reports.test.ts share: reading a
// failure line, failing a comment request for real, running the email worker
// until a pass fails, and reading the Sentry reports a replaced fetch
// receives. A suite that uses them restores mocks and deletes SENTRY_DSN after
// each test.

const { POST } = await import("../../src/app/api/screenr/[action]/route");
const { runWorkerPass } = await import("../../src/server/email");
const { runWorkerLoop } = await import("../../src/server/worker-loop");

// Each failure prints one JSON line. Its stack holds only frames, so the
// remaining fields are compared exactly: nothing else may be logged.
export function logged(printed: string[]) {
  assert.equal(printed.length, 1, printed.join("\n"));
  const { stack, ...fields } = JSON.parse(printed[0]);
  assert.ok(Array.isArray(stack) && stack.length > 0, printed[0]);
  for (const frame of stack) assert.match(frame, /^at /);
  return { fields, stack: stack as string[] };
}

export async function until(condition: () => boolean) {
  for (let wait = 0; wait < 400 && !condition(); wait++) await setTimeout(5);
  assert.ok(condition(), "Timed out");
}

// Runs screenr-worker's email loop until its first pass fails and is logged.
export async function failWorkerPass(printed: string[]) {
  const stop = new AbortController();
  const loop = runWorkerLoop(runWorkerPass, stop.signal);
  await until(() => printed.length > 0);
  stop.abort();
  await loop;
}

// Posts a comment that only a probe check constraint rejects, so the request
// fails unexpectedly. PostgreSQL's message names the constraint and its detail
// repeats the whole failing row. Returns the private values the request held.
export async function postRejectedComment() {
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

// An envelope is a header line, then one item header and its event.
export function envelope(body: string) {
  const lines = body.trimEnd().split("\n");
  assert.equal(lines.length, 3, body);
  const [header, item, event] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(item, { type: "event" });
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(header.event_id, event.event_id);
  return event;
}

// Replaces fetch with a Sentry endpoint that accepts every envelope, and
// returns a function that lists the events sent so far. A report calls fetch
// before logFailure returns, so the list is complete at once.
export function acceptReports() {
  process.env.SENTRY_DSN = "https://public-key@sentry.example.test/42";
  const fetch = mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  return () =>
    fetch.mock.calls.map(({ arguments: [url, init] }) => {
      assert.equal(url, "https://sentry.example.test/api/42/envelope/");
      return envelope(String(init?.body));
    });
}

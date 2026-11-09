import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { captureFailures } from "./social-fixture";

const { runWorkerLoop, runCleanup } =
  await import("../../src/server/worker-loop");

// The fake clock and timers replace the node:timers/promises functions too.
// Modules that imported them by name see the change only after a sync.
function fakeTime() {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  syncBuiltinESMExports();
}
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  syncBuiltinESMExports();
  delete process.env.SENTRY_DSN;
});

// Lets the loop run until it waits on a timer again.
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function runUntil(time: number) {
  await settle();
  while (Date.now() < time) {
    mock.timers.tick(1000);
    await settle();
  }
}

const unreachable = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5439"), {
    code: "ECONNREFUSED",
  });
const startingUp = () =>
  Object.assign(new Error("the database system is starting up"), {
    code: "57P03",
  });

// A loop whose passes record when they start, then run `run` for their pass
// number and fail with the error it returns, if any.
function start(run: (pass: number) => Error | undefined | Promise<void>) {
  fakeTime();
  const printed = captureFailures();
  const recovered: string[] = [];
  mock.method(console, "log", (line: string) => recovered.push(line));
  const starts: number[] = [];
  const stop = new AbortController();
  const loop = runWorkerLoop(async (pass) => {
    starts.push(Date.now());
    const error = await run(pass);
    if (error) throw error;
  }, stop.signal);
  return {
    starts,
    recovered,
    failed: () =>
      printed.map((line) => {
        const { stack, ...fields } = JSON.parse(line);
        assert.ok(stack.length > 0);
        return fields;
      }),
    // Stopping ends the current pause without waiting for its timer.
    stop: async () => {
      const passes = starts.length;
      stop.abort();
      await loop;
      assert.equal(starts.length, passes);
    },
  };
}

test("a failing worker loop doubles its pause after each failure up to 30 seconds, and logs each kind of failure once until an hour passes", async () => {
  const loop = start((pass) => (pass === 2 ? startingUp() : unreachable()));
  await runUntil(3_600_000);
  await loop.stop();
  assert.deepEqual(
    loop.starts.slice(0, 7),
    [0, 2_000, 6_000, 14_000, 30_000, 60_000, 90_000],
  );
  assert.equal(loop.starts.at(-1), 3_600_000);
  const failed = { event: "worker failed", error: "Error" };
  assert.deepEqual(loop.failed(), [
    { ...failed, failures: 1, code: "ECONNREFUSED" },
    { ...failed, failures: 3, code: "57P03" },
    { ...failed, failures: loop.starts.length, code: "ECONNREFUSED" },
  ]);
  assert.deepEqual(loop.recovered, []);
});

test("a worker loop that recovers says so, returns to a one-second pause, and logs its next failure at once", async () => {
  const loop = start((pass) =>
    [0, 1, 2, 5].includes(pass) ? unreachable() : undefined,
  );
  await runUntil(19_000);
  await loop.stop();
  assert.deepEqual(
    loop.starts,
    [0, 2_000, 6_000, 14_000, 15_000, 16_000, 18_000, 19_000],
  );
  const failed = {
    event: "worker failed",
    failures: 1,
    error: "Error",
    code: "ECONNREFUSED",
  };
  assert.deepEqual(loop.failed(), [failed, failed]);
  assert.deepEqual(loop.recovered, [
    '{"event":"worker recovered","failures":3}',
    '{"event":"worker recovered","failures":1}',
  ]);
});

test("each failure a worker loop logs also goes to Sentry, even a new run's first failure of a kind that the last run reported moments before", async () => {
  process.env.SENTRY_DSN = "https://public-key@sentry.example.test/42";
  const fetch = mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  const loop = start((pass) =>
    [0, 2].includes(pass) ? unreachable() : undefined,
  );
  await runUntil(4_000);
  await loop.stop();
  assert.deepEqual(loop.starts, [0, 2_000, 3_000]);
  assert.equal(loop.failed().length, 2);
  const reported = fetch.mock.calls.map(({ arguments: [, init] }) => {
    const event = JSON.parse(String(init?.body).trimEnd().split("\n")[2]);
    return event.contexts.failure;
  });
  assert.deepEqual(reported, loop.failed());
});

test("a cleanup step that keeps failing logs each run and reaches Sentry once an hour, while the loop keeps its one-second pause and the other steps run", async () => {
  process.env.SENTRY_DSN = "https://public-key@sentry.example.test/42";
  const fetch = mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  const cleaned: number[] = [];
  const steps = {
    broken: async () => {
      throw startingUp();
    },
    working: async () => {
      cleaned.push(Date.now());
    },
  };
  // As in production, the first pass and every 60th run the cleanup.
  const loop = start((pass) =>
    pass % 60 === 0 ? runCleanup(steps) : undefined,
  );
  await runUntil(3_599_000);
  await loop.stop();
  const minutes = Array.from({ length: 60 }, (_, minute) => minute * 60_000);
  assert.deepEqual(
    loop.starts,
    Array.from({ length: 3_600 }, (_, pass) => pass * 1_000),
  );
  assert.deepEqual(cleaned, minutes);
  const failure = {
    event: "worker cleanup failed",
    step: "broken",
    error: "Error",
    code: "57P03",
  };
  assert.deepEqual(
    loop.failed(),
    minutes.map(() => failure),
  );
  assert.deepEqual(loop.recovered, []);
  const reported = fetch.mock.calls.map(({ arguments: [, init] }) => {
    const event = JSON.parse(String(init?.body).trimEnd().split("\n")[2]);
    return event.contexts.failure;
  });
  assert.deepEqual(reported, [failure]);
});

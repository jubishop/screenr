import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import type { PoolClient } from "pg";
import { useDatabase, db, captureFailures } from "./social-fixture";

const { transaction } = await import("../../src/server/db");
useDatabase();
afterEach(() => mock.restoreAll());

const backend = async (client: PoolClient) =>
  (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;

// Resolves when the pool next closes and drops a connection. (events.once
// would reject on the pool's error event, which these tests cause.)
const removal = () =>
  new Promise<void>((resolve) => db.once("remove", () => resolve()));

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 400 && !condition(); wait++) await setTimeout(5);
  assert.ok(condition(), "Timed out");
}

// The fields of each printed failure line, without its stack frames.
const fields = (printed: string[]) =>
  printed.map((line) => {
    const { stack, ...rest } = JSON.parse(line);
    void stack;
    return rest;
  });

// PostgreSQL ends a connection this way when it restarts or recovers from a
// crash, and when an administrator terminates it.
const terminated = {
  event: "database connection failed",
  error: "DatabaseError",
  code: "57P01",
};

test("PostgreSQL ending an idle pooled connection logs it once without stopping the process, and the pool reconnects", async () => {
  const [idle, other] = await Promise.all([db.connect(), db.connect()]);
  const pid = await backend(idle);
  idle.release();
  const printed = captureFailures();
  const removed = removal();
  await other.query("SELECT pg_terminate_backend($1)", [pid]);
  other.release();
  await removed;
  assert.deepEqual(fields(printed), [terminated]);
  assert.equal((await db.query("SELECT 1 AS one")).rows[0].one, 1);
});

test("a transaction whose connection breaks rethrows its own error, not the failed ROLLBACK's, logs the broken connection once, and releases its client", async () => {
  const printed = captureFailures();
  const removed = removal();
  const failure = new Error("The work failed after its connection broke");
  await assert.rejects(
    transaction(async (client) => {
      // Another pooled connection ends this one between its queries.
      await db.query("SELECT pg_terminate_backend($1)", [
        await backend(client),
      ]);
      await until(() => printed.length > 0);
      throw failure;
    }),
    (error) => error === failure,
  );
  await removed;
  assert.deepEqual(fields(printed), [terminated]);
  assert.equal(db.idleCount, db.totalCount, "No client stays checked out");
  assert.equal((await db.query("SELECT 1 AS one")).rows[0].one, 1);
});

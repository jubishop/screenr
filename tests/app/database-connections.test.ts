import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { useDatabase, db, captureFailures } from "./social-fixture";

const { transaction } = await import("../../src/server/db");
// The production build copies src/server/db.ts into each server bundle that
// imports it, such as the pages' and the route handlers', and each copy runs
// in the same process. A development reload also runs the module again. A
// query string imports such a copy: another instance of the module.
const module = new URL("../../src/server/db.ts", import.meta.url).href;
const copy = (name: string) =>
  import(`${module}?copy=${name}`) as Promise<
    typeof import("../../src/server/db")
  >;
const execute = promisify(execFile);
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

// Ends a transaction's connection from another one between its queries, then
// fails its work, and checks what the transaction reports and releases.
async function breakTransaction(run: typeof transaction) {
  const printed = captureFailures();
  const removed = removal();
  const failure = new Error("The work failed after its connection broke");
  await assert.rejects(
    run(async (client) => {
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
}

test("a transaction whose connection breaks rethrows its own error, not the failed ROLLBACK's, logs the broken connection once, and releases its client", () =>
  breakTransaction(transaction));

test("a transaction that another copy of the module runs, as another bundle or a development reload does, also logs its broken connection once and no failed ROLLBACK", async () =>
  breakTransaction((await copy("routes")).transaction));

test("copies of the module in one production process, as the pages' and the route handlers' bundles are, share one pool", async () => {
  const { stdout } = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const pages = await import(${JSON.stringify(`${module}?copy=pages`)});
      const routes = await import(${JSON.stringify(`${module}?copy=routes`)});
      console.log(pages.db === routes.db);`,
    ],
    { env: { ...process.env, NODE_ENV: "production" } },
  );
  assert.equal(stdout.trim(), "true");
});

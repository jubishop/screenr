import { test, afterEach, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
import type { PoolClient } from "pg";
import { useDatabase, db } from "./social-fixture";
import { hang } from "./process-waits";
const { migrate, migrateFrom } = await import("../../scripts/migrate");

useDatabase();
afterEach(() => mock.restoreAll());

const files = (await readdir("db")).filter((name) => name.endsWith(".sql"));
const latest = Math.max(...files.map((name) => Number(name.slice(0, 3))));
// Numbers after the newest real migration, so new migrations don't collide.
const number = (offset: number) => String(latest + offset).padStart(3, "0");
// A probe that fails if it runs proves that rejection came first.
const fails = "SELECT 1/0;";

// Copies the real migrations, so the test database counts them as applied.
async function migrations(extra: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "screenr-migrations-"));
  await cp("db", directory, { recursive: true });
  for (const [name, sql] of Object.entries(extra))
    await writeFile(join(directory, name), sql);
  return directory;
}

async function rejection(
  directory: string,
  limits?: Parameters<typeof migrateFrom>[1],
) {
  const error = await migrateFrom(pathToFileURL(`${directory}/`), limits).then(
    () => assert.fail("The migration run must be rejected."),
    (error: Error) => error,
  );
  assert.doesNotMatch(error.message, /division by zero/);
  return error.message;
}

test("a migration that sorts before one the database already applied is rejected before any change", async () => {
  const [earlier, later, pending] = [1, 2, 3].map(number);
  const directory = await migrations({
    [`${later}-later.sql`]: "CREATE TABLE migration_order_probe (id int);",
  });
  try {
    // Ordered runs and reruns apply each migration once.
    await migrateFrom(pathToFileURL(`${directory}/`));
    await migrateFrom(pathToFileURL(`${directory}/`));
    // Another branch picked a lower number than the one already deployed.
    await writeFile(join(directory, `${earlier}-earlier.sql`), fails);
    await writeFile(join(directory, `${pending}-pending.sql`), fails);
    assert.match(
      await rejection(directory),
      new RegExp(`${earlier}-earlier\\.sql.*${later}-later\\.sql`),
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT name FROM screenr_migration WHERE name = ANY($1)",
          [
            [
              `${earlier}-earlier.sql`,
              `${later}-later.sql`,
              `${pending}-pending.sql`,
            ],
          ],
        )
      ).rows,
      [{ name: `${later}-later.sql` }],
    );
  } finally {
    await db.query("DELETE FROM screenr_migration WHERE name=$1", [
      `${later}-later.sql`,
    ]);
    await db.query("DROP TABLE IF EXISTS migration_order_probe");
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrations that share a number are rejected except the two pairs production already applied", async () => {
  const next = number(1);
  // Two branches each added the next migration number.
  let directory = await migrations({
    [`${next}-first.sql`]: fails,
    [`${next}-second.sql`]: fails,
  });
  try {
    assert.match(
      await rejection(directory),
      new RegExp(`unique.*${next}-first\\.sql, ${next}-second\\.sql`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // The exemption covers only the existing pairs, not their numbers.
  directory = await migrations({ "004-third.sql": fails });
  try {
    assert.match(await rejection(directory), /unique.*004-third\.sql/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an applied migration that changed is rejected before any change", async () => {
  const directory = await migrations({ [`${number(1)}-pending.sql`]: fails });
  try {
    await appendFile(join(directory, "001-domain.sql"), "\n-- Edited.\n");
    assert.match(await rejection(directory), /changed: 001-domain\.sql/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrations applied before checksums existed get checksums without running again", async () => {
  // Production recorded migrations without checksums before this change.
  await db.query("ALTER TABLE screenr_migration DROP COLUMN checksum");
  const rows = async (columns: string) =>
    (await db.query(`SELECT ${columns} FROM screenr_migration`)).rows.sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    );
  const before = await rows("name, applied_at");
  await migrate();
  const after = await rows("name, applied_at, checksum");
  assert.deepEqual(
    after.map(({ name, applied_at }) => ({ name, applied_at })),
    before,
  );
  for (const name of files)
    assert.equal(
      after.find((row) => row.name === name)?.checksum,
      createHash("sha256")
        .update(await readFile(join("db", name)))
        .digest("hex"),
      name,
    );
});

// The migration's own 200 ms limits end these runs, so each test's timeout
// only ends a hang. A run that ignored its lock limit would wait until the
// test timed out, and one that ignored its statement limit would finish its
// five-second sleep and be applied.
test(
  "a migration run stops with a clear error while another run holds the migration lock",
  { timeout: hang },
  async () => {
    const pending = `${number(1)}-pending.sql`;
    const directory = await migrations({ [pending]: fails });
    const holder = await db.connect();
    // Warnings that PostgreSQL sends the migration's connection, such as for
    // releasing a lock it never held.
    const notices: string[] = [];
    const notice = ({ message }: { message?: string }) =>
      notices.push(String(message));
    const listen = (client: PoolClient) => client.on("notice", notice);
    try {
      await holder.query("SELECT pg_advisory_lock(713934202)");
      db.on("acquire", listen);
      const message = await rejection(directory, { lockTimeout: "200ms" });
      assert.match(message, /waited 200ms for a database lock/);
      assert.match(message, /No SQL migration was applied/);
      assert.deepEqual(notices, []);
      assert.equal(
        (
          await db.query("SELECT 1 FROM screenr_migration WHERE name=$1", [
            pending,
          ])
        ).rowCount,
        0,
      );
    } finally {
      db.off("acquire", listen);
      await holder.query("SELECT pg_advisory_unlock(713934202)");
      holder.release();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a migration statement that runs too long is canceled and rolled back",
  { timeout: hang },
  async () => {
    const slow = `${number(1)}-slow.sql`;
    const directory = await migrations({
      [slow]:
        "CREATE TABLE migration_timeout_probe (id int); SELECT pg_sleep(5);",
    });
    try {
      const message = await rejection(directory, { statementTimeout: "200ms" });
      assert.match(message, /ran longer than 200ms/);
      assert.match(message, /No SQL migration was applied/);
      assert.equal(
        (
          await db.query(
            "SELECT to_regclass('migration_timeout_probe') AS name",
          )
        ).rows[0].name,
        null,
      );
    } finally {
      await db.query("DELETE FROM screenr_migration WHERE name=$1", [slow]);
      await db.query("DROP TABLE IF EXISTS migration_timeout_probe");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a migration run whose connection breaks fails with that error and releases its client", async () => {
  const name = `${number(1)}-broken.sql`;
  const directory = await migrations({
    [name]: "SELECT pg_terminate_backend(pg_backend_pid());",
  });
  // The run releases its client before the closed connection reports its
  // end, so the broken connection logs no failure line.
  const closed = new Promise((resolve) => db.once("remove", resolve));
  try {
    const error = await migrateFrom(pathToFileURL(`${directory}/`)).then(
      () => assert.fail("The migration run must be rejected."),
      (error: Error & { code?: string }) => error,
    );
    assert.equal(error.code, "57P01", String(error));
    // The run released its client, and the pool closed it. Load can hold the
    // close up, so only a hang ends the wait. Ending the bound's timer lets
    // the file finish.
    const timer = new AbortController();
    await Promise.race([
      closed,
      setTimeout(hang, undefined, { signal: timer.signal }).then(() =>
        assert.fail("The client was not released."),
      ),
    ]).finally(() => timer.abort());
    assert.equal(
      (await db.query("SELECT 1 FROM screenr_migration WHERE name=$1", [name]))
        .rowCount,
      0,
    );
  } finally {
    await db.query("DELETE FROM screenr_migration WHERE name=$1", [name]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration runs bound lock waits and statements by default, and leave no pooled connection with those limits", async () => {
  const name = `${number(1)}-limits.sql`;
  const directory = await migrations({
    [name]:
      "CREATE TABLE migration_limit_probe AS SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout;",
  });
  try {
    await migrateFrom(pathToFileURL(`${directory}/`));
    assert.deepEqual(
      (await db.query("SELECT * FROM migration_limit_probe")).rows,
      [{ lock_timeout: "30s", statement_timeout: "5min" }],
    );
    // No pooled connection keeps the migration's limits.
    assert.deepEqual(
      (
        await db.query(
          "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
        )
      ).rows,
      [{ lock_timeout: "0", statement_timeout: "0" }],
    );
  } finally {
    await db.query("DELETE FROM screenr_migration WHERE name=$1", [name]);
    await db.query("DROP TABLE IF EXISTS migration_limit_probe");
    await rm(directory, { recursive: true, force: true });
  }
});

// What a migration run prints through the console.
async function printedDuring(t: TestContext, run: () => Promise<unknown>) {
  const printed: string[] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      printed.push(format(...args));
    });
  await run();
  return printed.join("\n");
}

test("a migration run prints no Better Auth schema line for a database it already migrated", async (t) => {
  assert.doesNotMatch(await printedDuring(t, migrate), /\[Better Auth\]/);
});

test("a migration run that creates Better Auth's missing tables prints no schema mismatch", async (t) => {
  // A fresh database, such as the browser harness's, has none of them.
  await db.query('DROP TABLE "rateLimit"');
  assert.doesNotMatch(await printedDuring(t, migrate), /\[Better Auth\]/);
  assert.equal(
    (await db.query(`SELECT to_regclass('"rateLimit"') AS name`)).rows[0].name,
    '"rateLimit"',
  );
});

test("a migration run reports a Better Auth schema mismatch that remains after it", async (t) => {
  // Better Auth never writes this column, so every verification insert fails.
  await db.query(
    "ALTER TABLE verification ADD COLUMN migration_probe text NOT NULL",
  );
  try {
    const printed = await printedDuring(t, migrate);
    assert.match(printed, /ERROR \[Better Auth\]: Database schema mismatch/);
    assert.match(printed, /verification\.migration_probe/);
  } finally {
    await db.query(
      "ALTER TABLE verification DROP COLUMN IF EXISTS migration_probe",
    );
  }
});

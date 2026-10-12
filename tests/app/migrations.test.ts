import { test } from "node:test";
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
import { pathToFileURL } from "node:url";
import { useDatabase, db } from "./social-fixture";
const { migrate, migrateFrom } = await import("../../scripts/migrate");

useDatabase();

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

async function rejection(directory: string) {
  const error = await migrateFrom(pathToFileURL(`${directory}/`)).then(
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

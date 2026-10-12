import { getMigrations } from "better-auth/db/migration";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createAuth } from "../src/server/auth";
import { db } from "../src/server/db";

// Databases applied each of these independent pairs in different orders
// before numbers had to be unique. Every other migration needs its own number.
const sharedNumbers = new Set([
  "004-feed-items.sql",
  "004-invitation-links.sql",
  "006-reactions.sql",
  "006-remove-title-comments.sql",
]);
const disposable =
  "A disposable development or test database can be recreated instead.";

// Test hooks call migrate with their context, so tests that need another
// directory use migrateFrom.
export const migrate = () => migrateFrom(new URL("../db/", import.meta.url));

// Activation holds the deploy lock while migrations run. Bound each lock wait,
// including the migration lock, and each statement, so a stuck run fails
// with a clear error instead.
export async function migrateFrom(
  directory: URL,
  { lockTimeout = "30s", statementTimeout = "5min" } = {},
) {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const invalid = files.filter((name) => !/^\d{3}-[a-z-]+\.sql$/.test(name));
  if (invalid.length)
    throw new Error(
      `Migration files must match NNN-name.sql: ${invalid.join(", ")}`,
    );
  const shared = files.filter((name) =>
    files.some(
      (other) =>
        other !== name &&
        other.slice(0, 3) === name.slice(0, 3) &&
        !(sharedNumbers.has(name) && sharedNumbers.has(other)),
    ),
  );
  if (shared.length)
    throw new Error(
      `Migration numbers must be unique: ${shared.join(", ")}. Renumber the new migration after the latest one.`,
    );
  const migrations = await Promise.all(
    files.map(async (name) => {
      const sql = await readFile(new URL(name, directory));
      return {
        name,
        sql: sql.toString("utf8"),
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  const client = await db.connect();
  try {
    await client.query(
      "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
      [lockTimeout, statementTimeout],
    );
    await client.query("SELECT pg_advisory_lock(713934202)");
    // Check what this database applied before changing anything. Releases
    // before checksums existed, and rollbacks to them, record no checksum.
    const applied = new Map<string, string | null>();
    if (
      (await client.query("SELECT to_regclass('screenr_migration') AS name"))
        .rows[0].name
    )
      for (const row of (await client.query("SELECT * FROM screenr_migration"))
        .rows)
        applied.set(row.name, row.checksum ?? null);
    const latest = [...applied.keys()].sort().at(-1) ?? "";
    const late = files.filter((name) => !applied.has(name) && name < latest);
    if (late.length)
      throw new Error(
        `Migrations must run in order: ${late.join(", ")} would run after ${latest}, which this database already applied. Renumber the new migration after the latest one. ${disposable}`,
      );
    const changed = migrations.filter(
      ({ name, checksum }) => (applied.get(name) ?? checksum) !== checksum,
    );
    if (changed.length)
      throw new Error(
        `Applied migrations changed: ${changed.map(({ name }) => name).join(", ")}. Restore the applied version and put the change in a new migration. ${disposable}`,
      );
    await (await getMigrations(createAuth().options)).runMigrations();
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE IF NOT EXISTS screenr_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    // Stays nullable, so a rollback's older migration command can still record.
    await client.query(
      "ALTER TABLE screenr_migration ADD COLUMN IF NOT EXISTS checksum text",
    );
    for (const { name, sql, checksum } of migrations) {
      if (applied.has(name)) {
        if (!applied.get(name))
          await client.query(
            "UPDATE screenr_migration SET checksum=$2 WHERE name=$1",
            [name, checksum],
          );
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO screenr_migration(name, checksum) VALUES($1, $2)",
        [name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // Every SQL migration runs in the transaction that was just rolled back.
    const unapplied = "No SQL migration was applied.";
    const { code, message } = error as { code?: string; message?: string };
    if (code === "55P03")
      throw new Error(
        `Database migrations waited ${lockTimeout} for a database lock and stopped. Another migration run or a long transaction holds it. ${unapplied} Retry after it finishes.`,
        { cause: error },
      );
    if (code === "57014" && message?.includes("statement timeout"))
      throw new Error(
        `A database migration statement ran longer than ${statementTimeout} and was canceled. ${unapplied}`,
        { cause: error },
      );
    throw error;
  } finally {
    // The pool reuses this connection, so restore its default limits.
    await client.query(
      "SELECT pg_advisory_unlock(713934202); RESET lock_timeout; RESET statement_timeout",
    );
    client.release();
  }
}
if (process.argv[1]?.endsWith("scripts/migrate.ts")) {
  await migrate();
  console.log("Database migrations applied.");
  await db.end();
}

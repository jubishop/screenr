import { getMigrations } from "better-auth/db/migration";
import { readFile, readdir } from "node:fs/promises";
import { createAuth } from "../src/server/auth";
import { db } from "../src/server/db";

export async function migrate() {
  const directory = new URL("../db/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const invalid = files.filter((name) => !/^\d{3}-[a-z-]+\.sql$/.test(name));
  if (invalid.length)
    throw new Error(
      `Migration files must match NNN-name.sql: ${invalid.join(", ")}`,
    );
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(713934202)");
    const migrations = await getMigrations(createAuth().options);
    await migrations.runMigrations();
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE IF NOT EXISTS screenr_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of files) {
      if (
        (
          await client.query("SELECT 1 FROM screenr_migration WHERE name=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO screenr_migration(name) VALUES($1)", [
        name,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(713934202)");
    client.release();
  }
}
if (process.argv[1]?.endsWith("scripts/migrate.ts")) {
  await migrate();
  console.log("Database migrations applied.");
  await db.end();
}

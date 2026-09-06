import { getMigrations } from "better-auth/db/migration";
import { readFile } from "node:fs/promises";
import { createAuth } from "../src/server/auth";
import { db } from "../src/server/db";

export async function migrate() {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(713934202)");
    const migrations = await getMigrations(createAuth().options);
    await migrations.runMigrations();
    await client.query("BEGIN");
    await client.query(
      await readFile(new URL("../db/001-domain.sql", import.meta.url), "utf8"),
    );
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a test database.");

test("notification migration preserves old data, seeds only pending requests, and supports previous app writes", async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA notification_migration_test");
    await client.query("SET LOCAL search_path=notification_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    for (const name of [
      "001-domain",
      "002-current-email",
      "004-feed-items",
      "005-title-comments",
      "006-remove-title-comments",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben'),('cam');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by) VALUES ('alice','ben','ben');
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES ('alice','cam','cam',now());
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Migration');
      INSERT INTO conversation(id,owner_id,title_id,recommended) VALUES (gen_random_uuid(),'alice','movie:1',true);
      INSERT INTO comment(conversation_id,author_id,body) SELECT id,'cam','Historical comment' FROM conversation;
      INSERT INTO email_job(id,payload,expires_at) VALUES (gen_random_uuid(),'opaque existing code',now()+interval '10 minutes')`);
    const old = (await client.query("SELECT * FROM comment")).rows;
    await client.query(await readFile("db/010-notifications.sql", "utf8"));
    assert.deepEqual((await client.query("SELECT * FROM comment")).rows, old);
    assert.equal(
      (await client.query("SELECT payload FROM email_job")).rows[0].payload,
      "opaque existing code",
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT recipient_id,actor_id,kind,email_pending FROM notification",
        )
      ).rows,
      [
        {
          recipient_id: "alice",
          actor_id: "ben",
          kind: "friend_request",
          email_pending: false,
        },
      ],
    );
    await client.query(
      "INSERT INTO comment(conversation_id,author_id,body) SELECT id,'cam','Previous app write' FROM conversation",
    );
    assert.equal(
      (await client.query("SELECT * FROM visible_notification")).rows.length,
      2,
    );
    await client.query(
      "UPDATE friendship SET accepted_at=now() WHERE high_id='ben'",
    );
    assert.equal(
      (
        await client.query(
          "SELECT * FROM visible_notification WHERE recipient_id='ben'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT * FROM visible_notification WHERE kind='friend_request'",
        )
      ).rows.length,
      0,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

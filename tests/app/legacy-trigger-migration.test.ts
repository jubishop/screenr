import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { db, testDatabaseURL, useDatabase } from "./social-fixture";

useDatabase();

const triggers = `SELECT c.relname AS "table",t.tgname AS name
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  WHERE c.relnamespace=current_schema()::text::regnamespace AND NOT t.tgisinternal
  ORDER BY 1,2`;
const legacyFunctions = `SELECT proname FROM pg_proc
  WHERE pronamespace=current_schema()::text::regnamespace
  AND proname IN ('screenr_sync_actions','screenr_attach_legacy_comment')`;

test("migrated databases keep only the notification triggers", async () => {
  assert.deepEqual((await db.query(triggers)).rows, [
    { table: "comment", name: "comment_notify" },
    { table: "friendship", name: "friendship_notify" },
  ]);
  assert.deepEqual((await db.query(legacyFunctions)).rows, []);
});

async function snapshot(client: PoolClient) {
  const rows = async (sql: string) => (await client.query(sql)).rows;
  return {
    conversations: await rows("SELECT * FROM conversation ORDER BY id"),
    items: await rows("SELECT * FROM feed_item ORDER BY id"),
    standalone: await rows("SELECT * FROM title_comment ORDER BY id"),
    comments: await rows("SELECT * FROM comment ORDER BY id"),
  };
}

test("legacy trigger migration keeps every conversation, entry, and reply", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA legacy_trigger_migration_test");
    await client.query("SET LOCAL search_path=legacy_trigger_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    for (const name of [
      "001-domain",
      "004-feed-items",
      "005-title-comments",
      "006-remove-title-comments",
      "008-exclusive-title-actions",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    // Old-app writes that the triggers synchronized, then current writes.
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Legacy');
      INSERT INTO conversation(id,owner_id,title_id,recommended)
        VALUES ('00000000-0000-4000-8000-000000000001','alice','movie:1',true);
      INSERT INTO comment(conversation_id,author_id,body)
        VALUES ('00000000-0000-4000-8000-000000000001','ben','Earlier reply');
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'ben','Action reply' FROM feed_item WHERE item_type='recommended';
      INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
        VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','alice','movie:1','Standalone');
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ben','Standalone reply')`);
    assert.deepEqual(
      (await client.query(triggers)).rows.map(({ name }) => name),
      ["comment_attach_item", "conversation_sync_actions"],
    );
    const before = await snapshot(client);
    assert.deepEqual(
      before.items.map((item) => `${item.item_type}:${item.active}`).sort(),
      ["earlier:false", "recommended:true"],
    );
    assert.equal(before.comments.length, 3);

    await client.query(
      await readFile("db/017-retire-legacy-triggers.sql", "utf8"),
    );
    assert.deepEqual((await client.query(triggers)).rows, []);
    assert.deepEqual((await client.query(legacyFunctions)).rows, []);
    assert.deepEqual(await snapshot(client), before);

    // The preceding release still saves the flags; they no longer change
    // feed items.
    await client.query(
      "UPDATE conversation SET recommended=false,want_to_watch=true WHERE owner_id='alice'",
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM feed_item ORDER BY id")).rows,
      before.items,
    );
    // Every reply names its entry; none attaches to an earlier discussion.
    await assert.rejects(
      client.query(
        "INSERT INTO comment(conversation_id,author_id,body) VALUES ('00000000-0000-4000-8000-000000000001','ben','Unattached')",
      ),
      { code: "23514" },
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

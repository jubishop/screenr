import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a test database.");

test("migration preserves old discussions and creates only known active actions", async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA feed_migration_test");
    await client.query("SET LOCAL search_path=feed_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    await client.query(await readFile("db/001-domain.sql", "utf8"));
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) VALUES ('alice','alice','Alice'),('ben','ben','Ben');
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Movie');
      INSERT INTO conversation(id,owner_id,title_id,recommended,want_to_watch,created_at,activity_at)
      VALUES ('00000000-0000-0000-0000-000000000001','alice','movie:1',true,true,'2020-01-01','2020-02-01'),
             ('00000000-0000-0000-0000-000000000002','ben','movie:1',false,true,'2020-01-02','2020-02-02');
      INSERT INTO comment(conversation_id,author_id,body,spoiler,created_at)
      VALUES ('00000000-0000-0000-0000-000000000001','ben','Spoiler',true,'2020-03-01');
      INSERT INTO comment(conversation_id,author_id,body,root_id,addressed_id,removed_at,created_at)
      VALUES ('00000000-0000-0000-0000-000000000001','alice','[removed]',1,'ben','2020-04-01','2020-03-02');`);
    const oldComments = (
      await client.query("SELECT * FROM comment ORDER BY id")
    ).rows;
    await client.query(await readFile("db/004-feed-items.sql", "utf8"));
    assert.deepEqual(
      (await client.query("SELECT * FROM comment ORDER BY id")).rows.map(
        ({ feed_item_id, ...comment }) => comment,
      ),
      oldComments,
    );
    const items = (
      await client.query("SELECT * FROM feed_item ORDER BY owner_id,item_type")
    ).rows;
    assert.equal(items.length, 4);
    assert.deepEqual(
      items.map((c) => [c.owner_id, c.item_type, c.active]),
      [
        ["alice", "earlier", false],
        ["alice", "recommended", true],
        ["alice", "want_to_watch", true],
        ["ben", "want_to_watch", true],
      ],
    );
    assert.equal(items[0].id, "00000000-0000-0000-0000-000000000001");
    assert.equal(
      new Date(items[1].activity_at).toISOString(),
      "2020-02-01T00:00:00.000Z",
    );
    assert.equal(
      new Date(items[2].activity_at).toISOString(),
      "2020-02-01T00:00:00.000Z",
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM conversation"))
        .rows[0].n,
      2,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM comment cm JOIN feed_item c ON c.id=cm.feed_item_id WHERE c.item_type <> 'earlier'",
        )
      ).rows[0].n,
      0,
    );
    // Exercise the preceding release's SQL after migration: no new columns
    // are supplied. Its writes must remain visible in the new item model.
    await client.query(
      `UPDATE conversation SET recommended=false,activity_at='2020-05-01' WHERE owner_id='alice'`,
    );
    const withdrawn = (
      await client.query(
        "SELECT active,activity_at FROM feed_item WHERE owner_id='alice' AND item_type='recommended'",
      )
    ).rows[0];
    assert.equal(withdrawn.active, false);
    assert.equal(
      new Date(withdrawn.activity_at).toISOString(),
      "2020-02-01T00:00:00.000Z",
    );
    await client.query(
      `UPDATE conversation SET recommended=true,activity_at='2020-06-01' WHERE owner_id='alice'`,
    );
    assert.equal(
      (
        await client.query(
          "SELECT id FROM feed_item WHERE owner_id='alice' AND item_type='recommended'",
        )
      ).rows[0].id,
      items[1].id,
    );
    await client.query(
      `INSERT INTO comment(conversation_id,author_id,body) VALUES ('00000000-0000-0000-0000-000000000002','ben','Old app reply')`,
    );
    const oldWrite = (
      await client.query(
        "SELECT c.item_type,cm.body FROM comment cm JOIN feed_item c ON c.id=cm.feed_item_id WHERE cm.body='Old app reply'",
      )
    ).rows[0];
    assert.deepEqual(oldWrite, { item_type: "earlier", body: "Old app reply" });
    await client.query(
      `INSERT INTO comment(conversation_id,feed_item_id,author_id,body) VALUES ('00000000-0000-0000-0000-000000000001',$1,'ben','New action reply')`,
      [items[1].id],
    );
    assert.equal(
      (
        await client.query(
          "SELECT body FROM comment WHERE conversation_id='00000000-0000-0000-0000-000000000001' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0].body,
      "New action reply",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

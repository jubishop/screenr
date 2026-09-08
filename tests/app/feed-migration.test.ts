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
    const beforeStandalone = (
      await client.query("SELECT * FROM comment ORDER BY id")
    ).rows;
    await client.query(await readFile("db/005-title-comments.sql", "utf8"));
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM feed_item ORDER BY owner_id,item_type",
        )
      ).rows,
      items,
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM comment ORDER BY id")).rows.map(
        ({ title_comment_id, ...comment }) => {
          assert.equal(title_comment_id, null);
          return comment;
        },
      ),
      beforeStandalone,
    );
    const beforeReactions = (
      await client.query("SELECT * FROM comment ORDER BY id")
    ).rows;
    await client.query(await readFile("db/006-reactions.sql", "utf8"));
    assert.deepEqual(
      (await client.query("SELECT * FROM comment ORDER BY id")).rows,
      beforeReactions,
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM feed_item ORDER BY owner_id,item_type",
        )
      ).rows,
      items,
    );
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
    // The immediate predecessor upserts the canonical action directly too.
    const upsert = await client.query(
      `INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
       VALUES(gen_random_uuid(),'00000000-0000-0000-0000-000000000001','alice','movie:1','recommended',true)
       ON CONFLICT(owner_id,title_id,item_type) DO UPDATE SET active=excluded.active RETURNING id`,
    );
    assert.equal(upsert.rows[0].id, items[1].id);
    await client.query(`INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
      VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','alice','movie:1','First'),
             ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','alice','movie:1','Second');
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
      VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','alice','Standalone reply');`);
    const standaloneReply = (
      await client.query(
        "SELECT feed_item_id,title_comment_id FROM comment WHERE body='Standalone reply'",
      )
    ).rows[0];
    assert.deepEqual(standaloneReply, {
      feed_item_id: null,
      title_comment_id: "00000000-0000-0000-0000-000000000003",
    });
    const beforeRemoval = (
      await client.query("SELECT * FROM title_comment ORDER BY id")
    ).rows;
    await client.query(
      await readFile("db/006-remove-title-comments.sql", "utf8"),
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM title_comment ORDER BY id")).rows.map(
        ({ removed_at, ...entry }) => {
          assert.equal(removed_at, null);
          return entry;
        },
      ),
      beforeRemoval,
    );
    // The preceding release can still create standalone entries without a removal field.
    await client.query(`INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
      VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','alice','movie:1','Old app standalone');
      UPDATE title_comment SET body='[removed]',removed_at=now() WHERE id='00000000-0000-0000-0000-000000000003'`);
    assert.equal(
      (
        await client.query(
          "SELECT body FROM comment WHERE title_comment_id='00000000-0000-0000-0000-000000000003'",
        )
      ).rows[0].body,
      "Standalone reply",
    );
    for (const sql of [
      `INSERT INTO comment(conversation_id,title_comment_id,author_id,body) VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ben','Wrong conversation')`,
      `INSERT INTO comment(conversation_id,feed_item_id,title_comment_id,author_id,body) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','alice','Two groups')`,
    ]) {
      await client.query("SAVEPOINT invalid_reply");
      await assert.rejects(client.query(sql), /constraint/);
      await client.query("ROLLBACK TO SAVEPOINT invalid_reply");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

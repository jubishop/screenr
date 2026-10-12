import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { testDatabaseURL } from "./social-fixture";

// Migration 018 must leave existing data intact and keep the previous release
// working during activation or rollback. That release writes feed items,
// comments, and reactions without knowing about progress entries.
test("watch status migration keeps existing data and the previous release's writes working", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA watch_status_migration_test");
    await client.query("SET LOCAL search_path=watch_status_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    for (const name of [
      "001-domain",
      "004-feed-items",
      "005-title-comments",
      "006-reactions",
      "006-remove-title-comments",
      "008-exclusive-title-actions",
      "010-notifications",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES ('alice','ben','ben',now());
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Film'),('tv:2','tv',2,'Show');
      INSERT INTO conversation(id,owner_id,title_id,want_to_watch) VALUES
        (gen_random_uuid(),'alice','movie:1',true),(gen_random_uuid(),'alice','tv:2',false);
      INSERT INTO comment(conversation_id,author_id,body)
        SELECT id,'ben','Earlier discussion' FROM conversation WHERE title_id='movie:1';
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'ben','Want to watch reply' FROM feed_item WHERE item_type='want_to_watch';
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT 'ben',id,'love' FROM feed_item;
      INSERT INTO reaction(user_id,comment_id,kind) SELECT 'alice',id,'like' FROM comment;
      INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
        SELECT gen_random_uuid(),id,owner_id,title_id,'Standalone' FROM conversation WHERE title_id='tv:2';
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,'ben','Standalone reply' FROM title_comment`);
    await client.query(
      await readFile("db/017-retire-legacy-triggers.sql", "utf8"),
    );
    const tables = [
      "conversation",
      "feed_item",
      "title_comment",
      "comment",
      "reaction",
      "notification",
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            await rows(`SELECT * FROM ${table} ORDER BY 1,2,3,4,5`),
          ]),
        ),
      );
    const notifications = await rows(
      "SELECT id,item_id FROM visible_notification ORDER BY id",
    );
    const before = await snapshot();

    await client.query(await readFile("db/018-watch-statuses.sql", "utf8"));
    // Existing rows keep every value; added columns are empty.
    const after = await snapshot();
    for (const table of tables)
      assert.deepEqual(
        after[table].map(
          ({ watch_progress_id, ...row }: Record<string, unknown>) => {
            assert.equal(watch_progress_id ?? null, null);
            return row;
          },
        ),
        before[table],
        table,
      );
    assert.deepEqual(
      await rows("SELECT id,item_id FROM visible_notification ORDER BY id"),
      notifications,
    );

    // This release records a progress status as it switches Want to watch off.
    await client.query(`UPDATE feed_item SET active=false WHERE item_type='want_to_watch';
      INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
        SELECT gen_random_uuid(),id,owner_id,title_id,'watching' FROM conversation WHERE title_id='movie:1'`);
    const [progress] = await rows("SELECT id,activity_at FROM watch_progress");
    await client.query(
      `INSERT INTO comment(conversation_id,watch_progress_id,author_id,body)
       SELECT conversation_id,id,'ben','Progress reply' FROM watch_progress`,
    );
    await client.query(
      "INSERT INTO reaction(user_id,watch_progress_id,kind) SELECT 'ben',id,'wow' FROM watch_progress",
    );
    // A progress reply never joins an earlier discussion, and its
    // notification links to the progress entry.
    assert.deepEqual(
      await rows(
        "SELECT feed_item_id,watch_progress_id FROM comment WHERE body='Progress reply'",
      ),
      [{ feed_item_id: null, watch_progress_id: progress.id }],
    );
    assert.deepEqual(
      await rows(
        "SELECT v.item_id FROM visible_notification v JOIN comment c ON c.id=v.comment_id WHERE c.body='Progress reply'",
      ),
      [{ item_id: progress.id }],
    );

    // The previous release's Recommend leaves the status alone.
    await client.query(`INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
      SELECT gen_random_uuid(),id,owner_id,title_id,'recommended',true FROM conversation WHERE title_id='movie:1'`);
    assert.deepEqual(await rows("SELECT active FROM watch_progress"), [
      { active: true },
    ]);
    // Its Want to watch replaces the status without moving the entry.
    await client.query(`UPDATE feed_item SET active=false WHERE item_type='recommended';
      UPDATE feed_item SET active=true WHERE item_type='want_to_watch'`);
    assert.deepEqual(
      await rows("SELECT active,activity_at FROM watch_progress"),
      [{ active: false, activity_at: progress.activity_at }],
    );
    assert.deepEqual(
      await rows(
        "SELECT item_type FROM feed_item WHERE active AND title_id='movie:1'",
      ),
      [{ item_type: "want_to_watch" }],
    );
    // Its replies and reactions still save, and a reply without an entry
    // still fails.
    await client.query(`INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'alice','Previous release reply' FROM feed_item WHERE item_type='want_to_watch';
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,'alice','Previous release standalone reply' FROM title_comment;
      INSERT INTO reaction(user_id,title_comment_id,kind) SELECT 'alice',id,'haha' FROM title_comment`);

    // Constraints keep one entry per person and title, Caught up for TV,
    // and exactly one target per reply and reaction.
    const rejects = async (sql: string, code: string) => {
      await client.query("SAVEPOINT probe");
      await assert.rejects(client.query(sql), { code });
      await client.query("ROLLBACK TO SAVEPOINT probe");
    };
    await rejects(
      `INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
       SELECT gen_random_uuid(),conversation_id,owner_id,title_id,'finished' FROM watch_progress`,
      "23505",
    );
    await rejects("UPDATE watch_progress SET status='caught_up'", "23514");
    await rejects(
      `INSERT INTO comment(conversation_id,author_id,body)
       SELECT id,'ben','No entry' FROM conversation WHERE title_id='movie:1'`,
      "23514",
    );
    await rejects(
      `INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
       SELECT gen_random_uuid(),id,owner_id,title_id,'paused' FROM conversation WHERE title_id='tv:2'`,
      "23514",
    );
    await client.query(`INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
       SELECT gen_random_uuid(),id,owner_id,title_id,'caught_up' FROM conversation WHERE title_id='tv:2'`);
    await rejects(
      `INSERT INTO comment(conversation_id,feed_item_id,watch_progress_id,author_id,body)
       SELECT w.conversation_id,f.id,w.id,'ben','Two targets' FROM watch_progress w
       JOIN feed_item f ON f.conversation_id=w.conversation_id`,
      "23514",
    );
    await rejects(
      `INSERT INTO comment(conversation_id,watch_progress_id,author_id,body)
       SELECT c.id,w.id,'ben','Wrong conversation' FROM watch_progress w
       JOIN conversation c ON c.id<>w.conversation_id LIMIT 1`,
      "23503",
    );
    await rejects(
      `INSERT INTO reaction(user_id,feed_item_id,watch_progress_id,kind)
       SELECT 'alice',f.id,w.id,'like' FROM watch_progress w
       JOIN feed_item f ON f.conversation_id=w.conversation_id`,
      "23514",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

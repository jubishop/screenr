import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { testDatabaseURL } from "./social-fixture";

// Migration 022 must leave existing data intact and keep the previous release
// working during activation or rollback. That release writes feed items,
// standalone comments, progress entries, replies, and reactions without
// knowing about reviews.
test("review migration keeps existing data and the previous release's writes working", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA review_migration_test");
    await client.query("SET LOCAL search_path=review_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    for (const name of [
      "001-domain",
      "004-feed-items",
      "005-title-comments",
      "006-reactions",
      "006-remove-title-comments",
      "008-exclusive-title-actions",
      "010-notifications",
      "015-usage-telemetry",
      "017-retire-legacy-triggers",
      "018-watch-statuses",
      "019-profile-photos",
      "020-drop-legacy-conversation-columns",
      "021-save-follow-through",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES ('alice','ben','ben',now());
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Film'),('tv:2','tv',2,'Show');
      INSERT INTO conversation(id,owner_id,title_id) VALUES
        (gen_random_uuid(),'alice','movie:1'),(gen_random_uuid(),'alice','tv:2');
      INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
        SELECT gen_random_uuid(),id,owner_id,title_id,'recommended',true FROM conversation WHERE title_id='movie:1';
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'ben','Recommend reply' FROM feed_item;
      INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
        SELECT gen_random_uuid(),id,owner_id,title_id,'Standalone' FROM conversation WHERE title_id='tv:2';
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,'ben','Standalone reply' FROM title_comment;
      INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
        SELECT gen_random_uuid(),id,owner_id,title_id,'watching' FROM conversation WHERE title_id='tv:2';
      INSERT INTO comment(conversation_id,watch_progress_id,author_id,body)
        SELECT conversation_id,id,'ben','Progress reply' FROM watch_progress;
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT 'ben',id,'love' FROM feed_item;
      INSERT INTO reaction(user_id,watch_progress_id,kind) SELECT 'ben',id,'wow' FROM watch_progress;
      INSERT INTO reaction(user_id,comment_id,kind) SELECT 'alice',id,'like' FROM comment`);
    const tables = [
      "conversation",
      "feed_item",
      "title_comment",
      "watch_progress",
      "comment",
      "reaction",
      "notification",
    ];
    const snapshot = async () => {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of tables)
        result[table] = await rows(
          `SELECT * FROM ${table} t ORDER BY t::text COLLATE "C"`,
        );
      return result;
    };
    const notifications = await rows(
      "SELECT id,item_id FROM visible_notification ORDER BY id",
    );
    const before = await snapshot();

    await client.query(await readFile("db/022-reviews.sql", "utf8"));
    // Existing rows keep every value; added columns are empty.
    const after = await snapshot();
    for (const table of tables)
      assert.deepEqual(
        after[table].map(({ review_id, ...row }: Record<string, unknown>) => {
          assert.equal(review_id ?? null, null);
          return row;
        }),
        before[table],
        table,
      );
    assert.deepEqual(
      await rows("SELECT id,item_id FROM visible_notification ORDER BY id"),
      notifications,
    );

    // This release saves a review with replies and reactions. A review reply
    // never joins another entry, and its notification links to the review.
    await client.query(`INSERT INTO review(id,conversation_id,owner_id,title_id,rating,body)
      SELECT gen_random_uuid(),id,owner_id,title_id,4,'Good' FROM conversation WHERE title_id='movie:1'`);
    const [review] = await rows("SELECT id FROM review");
    await client.query(`INSERT INTO comment(conversation_id,review_id,author_id,body)
        SELECT conversation_id,id,'ben','Review reply' FROM review;
      INSERT INTO reaction(user_id,review_id,kind) SELECT 'ben',id,'haha' FROM review`);
    assert.deepEqual(
      await rows(
        "SELECT feed_item_id,title_comment_id,watch_progress_id,review_id FROM comment WHERE body='Review reply'",
      ),
      [
        {
          feed_item_id: null,
          title_comment_id: null,
          watch_progress_id: null,
          review_id: review.id,
        },
      ],
    );
    assert.deepEqual(
      await rows(
        "SELECT v.item_id FROM visible_notification v JOIN comment c ON c.id=v.comment_id WHERE c.body='Review reply'",
      ),
      [{ item_id: review.id }],
    );

    // The previous release's actions, replies, and reactions still save, and
    // its Want to watch still withdraws a progress status.
    await client.query(`INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
        SELECT gen_random_uuid(),id,owner_id,title_id,'want_to_watch',true FROM conversation WHERE title_id='tv:2';
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'alice','Previous release reply' FROM feed_item WHERE item_type='want_to_watch';
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,'alice','Previous release standalone reply' FROM title_comment;
      INSERT INTO comment(conversation_id,watch_progress_id,author_id,body)
        SELECT conversation_id,id,'alice','Previous release progress reply' FROM watch_progress;
      INSERT INTO reaction(user_id,title_comment_id,kind) SELECT 'alice',id,'haha' FROM title_comment`);
    assert.deepEqual(await rows("SELECT active FROM watch_progress"), [
      { active: false },
    ]);

    // Constraints keep one review per person and title, whole stars from 1
    // to 5, a rating or text on a current review and neither on a removed
    // one, and exactly one target per reply and reaction.
    const rejects = async (sql: string, code: string) => {
      await client.query("SAVEPOINT probe");
      await assert.rejects(client.query(sql), { code });
      await client.query("ROLLBACK TO SAVEPOINT probe");
    };
    await rejects(
      `INSERT INTO review(id,conversation_id,owner_id,title_id,rating)
       SELECT gen_random_uuid(),conversation_id,owner_id,title_id,3 FROM review`,
      "23505",
    );
    for (const update of [
      "rating=0",
      "rating=6",
      "rating=NULL,body=NULL",
      "body=''",
      `body=repeat('x',2001)`,
      "active=false",
    ])
      await rejects(`UPDATE review SET ${update}`, "23514");
    await client.query("UPDATE review SET active=false,rating=NULL,body=NULL");
    await client.query("UPDATE review SET active=true,rating=NULL,body='Text'");
    await client.query(`INSERT INTO review(id,conversation_id,owner_id,title_id,rating)
      SELECT gen_random_uuid(),id,owner_id,title_id,5 FROM conversation WHERE title_id='tv:2'`);
    await rejects(
      `INSERT INTO comment(conversation_id,author_id,body)
       SELECT id,'ben','No entry' FROM conversation WHERE title_id='movie:1'`,
      "23514",
    );
    await rejects(
      `INSERT INTO comment(conversation_id,feed_item_id,review_id,author_id,body)
       SELECT r.conversation_id,f.id,r.id,'ben','Two targets' FROM review r
       JOIN feed_item f ON f.conversation_id=r.conversation_id`,
      "23514",
    );
    await rejects(
      `INSERT INTO comment(conversation_id,review_id,author_id,body)
       SELECT c.id,r.id,'ben','Wrong conversation' FROM review r
       JOIN conversation c ON c.id<>r.conversation_id LIMIT 1`,
      "23503",
    );
    await rejects(
      `INSERT INTO reaction(user_id,feed_item_id,review_id,kind)
       SELECT 'alice',f.id,r.id,'like' FROM review r
       JOIN feed_item f ON f.conversation_id=r.conversation_id`,
      "23514",
    );
    await rejects(
      "INSERT INTO reaction(user_id,review_id,kind) SELECT 'ben',id,'sad' FROM review WHERE title_id='movie:1'",
      "23505",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

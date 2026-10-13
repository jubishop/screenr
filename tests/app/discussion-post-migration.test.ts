import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { testDatabaseURL } from "./social-fixture";

// Migration 024 must leave existing data intact and keep the previous release
// working during activation or rollback. That release writes title comments,
// replies, and reactions without labels and never reads posts without a title.
test("discussion post migration keeps existing data and the previous release's writes working", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA discussion_post_migration_test");
    await client.query("SET LOCAL search_path=discussion_post_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    for (const name of [
      "001-domain",
      "004-feed-items",
      "005-title-comments",
      "006-reactions",
      "006-remove-title-comments",
      "008-exclusive-title-actions",
      "010-notifications",
      "017-retire-legacy-triggers",
      "018-watch-statuses",
      "020-drop-legacy-conversation-columns",
      "022-reviews",
      "023-drop-watch-status-guard",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben'),('cam');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES
        ('alice','ben','ben',now()),('alice','cam','cam',now());
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
      INSERT INTO review(id,conversation_id,owner_id,title_id,rating)
        SELECT gen_random_uuid(),id,owner_id,title_id,4 FROM conversation WHERE title_id='movie:1';
      INSERT INTO comment(conversation_id,review_id,author_id,body)
        SELECT conversation_id,id,'ben','Review reply' FROM review;
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT 'ben',id,'love' FROM feed_item;
      INSERT INTO reaction(user_id,comment_id,kind) SELECT 'alice',id,'like' FROM comment`);
    const tables = [
      "conversation",
      "feed_item",
      "title_comment",
      "review",
      "comment",
      "reaction",
      "notification",
    ];
    const snapshot = async () => {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of tables)
        result[table] = await rows(`SELECT * FROM ${table} ORDER BY 1,2,3,4`);
      return result;
    };
    const notifications = await rows(
      "SELECT id,title_id,item_id FROM visible_notification ORDER BY id",
    );
    // Two friendships and three title replies.
    assert.equal(notifications.length, 5);
    const before = await snapshot();

    await client.query(await readFile("db/024-discussion-posts.sql", "utf8"));
    // Existing rows keep every value; added columns are empty.
    const added = [
      "discussion_post_id",
      "season_number",
      "episode_number",
    ] as const;
    const after = await snapshot();
    for (const table of tables)
      assert.deepEqual(
        after[table].map((row) => {
          const kept = { ...row };
          for (const column of added) {
            assert.equal(kept[column] ?? null, null);
            delete kept[column];
          }
          return kept;
        }),
        before[table],
        table,
      );
    assert.deepEqual(
      await rows(
        "SELECT id,title_id,item_id FROM visible_notification ORDER BY id",
      ),
      notifications,
    );

    // This release saves a post without a title and its replies, which
    // notify the post's owner and the addressed person.
    await client.query(`INSERT INTO discussion_post(id,owner_id,body)
      VALUES ('00000000-0000-4000-8000-000000000020','alice','Any good comedies?')`);
    await client.query(`INSERT INTO comment(discussion_post_id,author_id,body)
      VALUES ('00000000-0000-4000-8000-000000000020','ben','Try this one')`);
    await client.query(`INSERT INTO comment(discussion_post_id,author_id,body,root_id,addressed_id)
      SELECT discussion_post_id,'cam','Seconded',id,author_id FROM comment WHERE body='Try this one'`);
    await client.query(
      "INSERT INTO reaction(user_id,discussion_post_id,kind) SELECT 'ben',id,'haha' FROM discussion_post",
    );
    assert.deepEqual(
      await rows(`SELECT n.recipient_id,n.kind,v.title_id,v.title_name,v.item_id
        FROM notification n JOIN comment c ON c.id=n.comment_id
        LEFT JOIN visible_notification v ON v.id=n.id
        WHERE c.discussion_post_id IS NOT NULL ORDER BY n.id`),
      [
        {
          recipient_id: "alice",
          kind: "comment",
          title_id: null,
          title_name: null,
          item_id: "00000000-0000-4000-8000-000000000020",
        },
        {
          recipient_id: "alice",
          kind: "comment",
          title_id: null,
          title_name: null,
          item_id: "00000000-0000-4000-8000-000000000020",
        },
        {
          recipient_id: "ben",
          kind: "reply",
          title_id: null,
          title_name: null,
          item_id: "00000000-0000-4000-8000-000000000020",
        },
      ],
    );
    // Ending the friendship hides the replier's notification, as for titles.
    await client.query(
      "DELETE FROM friendship WHERE low_id='alice' AND high_id='cam'",
    );
    assert.equal(
      (
        await rows(`SELECT 1 FROM visible_notification v JOIN comment c ON c.id=v.comment_id
          WHERE c.discussion_post_id IS NOT NULL`)
      ).length,
      1,
    );
    // A TV comment can name a season, or an episode within it.
    await client.query(`INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,season_number,episode_number)
      SELECT gen_random_uuid(),id,owner_id,title_id,'Season two talk',2,NULL FROM conversation WHERE title_id='tv:2';
      INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,season_number,episode_number)
      SELECT gen_random_uuid(),id,owner_id,title_id,'Episode talk',2,4 FROM conversation WHERE title_id='tv:2'`);

    // The previous release still saves its title comments, replies, review
    // replies, and reactions, and its title replies still notify.
    await client.query(`INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
        SELECT gen_random_uuid(),id,owner_id,title_id,'Previous release comment' FROM conversation WHERE title_id='movie:1';
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,'ben','Previous release reply' FROM title_comment WHERE body='Previous release comment';
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'ben','Previous release action reply' FROM feed_item;
      INSERT INTO comment(conversation_id,review_id,author_id,body)
        SELECT conversation_id,id,'ben','Previous release review reply' FROM review;
      INSERT INTO reaction(user_id,review_id,kind) SELECT 'ben',id,'like' FROM review;
      INSERT INTO reaction(user_id,title_comment_id,kind)
        SELECT 'ben',id,'wow' FROM title_comment WHERE body='Previous release comment'`);
    assert.deepEqual(
      await rows(`SELECT v.title_id FROM visible_notification v JOIN comment c ON c.id=v.comment_id
        WHERE c.body LIKE 'Previous release%' ORDER BY v.id`),
      [
        { title_id: "movie:1" },
        { title_id: "movie:1" },
        { title_id: "movie:1" },
      ],
    );

    // Constraints keep one entry per reply and reaction, a conversation for
    // every title reply and none for a post reply, and labels on TV only.
    const rejects = async (sql: string, code: string) => {
      await client.query("SAVEPOINT probe");
      await assert.rejects(client.query(sql), { code });
      await client.query("ROLLBACK TO SAVEPOINT probe");
    };
    await rejects(
      `INSERT INTO comment(conversation_id,author_id,body)
       SELECT id,'ben','No entry' FROM conversation WHERE title_id='movie:1'`,
      "23514",
    );
    await rejects(
      `INSERT INTO comment(feed_item_id,author_id,body)
       SELECT id,'ben','No conversation' FROM feed_item`,
      "23514",
    );
    await rejects(
      `INSERT INTO comment(conversation_id,discussion_post_id,author_id,body)
       SELECT c.id,p.id,'ben','Post with a conversation' FROM conversation c,discussion_post p LIMIT 1`,
      "23514",
    );
    await rejects(
      `INSERT INTO comment(conversation_id,feed_item_id,discussion_post_id,author_id,body)
       SELECT f.conversation_id,f.id,p.id,'ben','Two targets' FROM feed_item f,discussion_post p`,
      "23514",
    );
    await rejects(
      `INSERT INTO reaction(user_id,feed_item_id,discussion_post_id,kind)
       SELECT 'cam',f.id,p.id,'like' FROM feed_item f,discussion_post p`,
      "23514",
    );
    await rejects(
      "INSERT INTO reaction(user_id,discussion_post_id,kind) SELECT 'ben',id,'love' FROM discussion_post",
      "23505",
    );
    await rejects(
      `INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,season_number)
       SELECT gen_random_uuid(),id,owner_id,title_id,'Movie season',1 FROM conversation WHERE title_id='movie:1'`,
      "23514",
    );
    for (const [season, episode] of [
      ["NULL", "3"],
      ["0", "NULL"],
      ["1", "0"],
    ])
      await rejects(
        `INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,season_number,episode_number)
         SELECT gen_random_uuid(),id,owner_id,title_id,'Bad label',${season},${episode} FROM conversation WHERE title_id='tv:2'`,
        "23514",
      );
    await rejects(
      "INSERT INTO discussion_post(id,owner_id,body) VALUES (gen_random_uuid(),'alice','')",
      "23514",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

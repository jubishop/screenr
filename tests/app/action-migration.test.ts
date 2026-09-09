import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a test database.");

test("exclusive action migration retains latest choices and all discussion history", async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA action_migration_test");
    await client.query("SET LOCAL search_path=action_migration_test");
    await client.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    for (const name of [
      "001-domain",
      "004-feed-items",
      "005-title-comments",
      "006-reactions",
      "006-remove-title-comments",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    await client.query(`INSERT INTO "user" VALUES ('newrec'),('newwant'),('tie'),('single'),('empty');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:78','movie',78,'Switching');
      INSERT INTO conversation(id,owner_id,title_id,recommended,want_to_watch,created_at,activity_at)
      SELECT gen_random_uuid(),id,'movie:78',id NOT IN ('single','empty'),id <> 'empty','2020-01-01','2020-02-01' FROM "user";
      UPDATE feed_item SET activity_at='2020-03-01'
        WHERE (owner_id='newrec' AND item_type='recommended') OR (owner_id='newwant' AND item_type='want_to_watch');
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body,spoiler)
        SELECT conversation_id,id,owner_id,item_type,true FROM feed_item;
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body,root_id,addressed_id)
        SELECT conversation_id,feed_item_id,author_id,'Nested reply',id,author_id FROM comment;
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT owner_id,id,'love' FROM feed_item;
      INSERT INTO reaction(user_id,comment_id,kind) SELECT author_id,id,'like' FROM comment;
      INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
        SELECT gen_random_uuid(),id,owner_id,title_id,'Standalone discussion' FROM conversation;
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,owner_id,'Standalone reply' FROM title_comment`);
    const items = (await client.query("SELECT * FROM feed_item ORDER BY id"))
      .rows;
    const comments = (await client.query("SELECT * FROM comment ORDER BY id"))
      .rows;
    const reactions = (
      await client.query(
        "SELECT * FROM reaction ORDER BY user_id,feed_item_id,comment_id",
      )
    ).rows;
    const standalone = (
      await client.query("SELECT * FROM title_comment ORDER BY id")
    ).rows;
    const oldConversations = (
      await client.query(
        "SELECT id,created_at,activity_at FROM conversation ORDER BY id",
      )
    ).rows;

    await client.query(
      await readFile("db/008-exclusive-title-actions.sql", "utf8"),
    );
    const updated = (await client.query("SELECT * FROM feed_item ORDER BY id"))
      .rows;
    assert.deepEqual(
      updated.map(({ active, ...item }) => item),
      items.map(({ active, ...item }) => item),
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT owner_id,item_type FROM feed_item WHERE active ORDER BY owner_id",
        )
      ).rows,
      [
        { owner_id: "newrec", item_type: "recommended" },
        { owner_id: "newwant", item_type: "want_to_watch" },
        { owner_id: "single", item_type: "want_to_watch" },
        { owner_id: "tie", item_type: "recommended" },
      ],
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT owner_id,recommended,want_to_watch FROM conversation ORDER BY owner_id",
        )
      ).rows,
      [
        { owner_id: "empty", recommended: false, want_to_watch: false },
        { owner_id: "newrec", recommended: true, want_to_watch: false },
        { owner_id: "newwant", recommended: false, want_to_watch: true },
        { owner_id: "single", recommended: false, want_to_watch: true },
        { owner_id: "tie", recommended: true, want_to_watch: false },
      ],
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM comment ORDER BY id")).rows,
      comments,
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM reaction ORDER BY user_id,feed_item_id,comment_id",
        )
      ).rows,
      reactions,
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM title_comment ORDER BY id")).rows,
      standalone,
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT id,created_at,activity_at FROM conversation ORDER BY id",
        )
      ).rows,
      oldConversations,
    );
    // Both directions work even with the immediate unique index. Dates change
    // only for the reactivated action, and the original reply target survives.
    for (const recommended of [false, true]) {
      await client.query(
        "UPDATE conversation SET recommended=$1,want_to_watch=NOT $1,activity_at='2021-01-01' WHERE owner_id='tie'",
        [recommended],
      );
      const active = (
        await client.query(
          "SELECT id,item_type FROM feed_item WHERE owner_id='tie' AND active",
        )
      ).rows;
      assert.equal(active.length, 1);
      const kind = recommended ? "recommended" : "want_to_watch";
      assert.deepEqual(active[0], {
        id: items.find(
          (item) => item.owner_id === "tie" && item.item_type === kind,
        ).id,
        item_type: kind,
      });
    }
    assert.deepEqual(
      (await client.query("SELECT * FROM comment ORDER BY id")).rows,
      comments,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

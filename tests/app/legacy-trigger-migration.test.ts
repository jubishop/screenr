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
  AND proname IN ('screenr_sync_actions','screenr_attach_legacy_comment',
    'screenr_withdraw_progress','screenr_leave_top_ten')`;

// Migrations 017, 023, and 026 dropped every compatibility trigger.
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

// Every retained release creates conversation rows without the legacy action
// flags and activity date and never reads them, so migration 020 drops them.
const dropLegacyColumns = "db/020-drop-legacy-conversation-columns.sql";

test("legacy column migration drops the conversation flags and keeps every row and reference", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA legacy_column_migration_test");
    await client.query("SET LOCAL search_path=legacy_column_migration_test");
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
    // Pre-feed writes saved the flags and a shared activity date, which the
    // triggers turned into entries until migration 017.
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES ('alice','ben','ben',now());
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Film'),('tv:2','tv',2,'Show');
      INSERT INTO conversation(id,owner_id,title_id,recommended,want_to_watch,created_at,activity_at) VALUES
        (gen_random_uuid(),'alice','movie:1',false,true,'2020-01-01','2020-02-01'),
        (gen_random_uuid(),'ben','tv:2',true,false,'2020-03-01','2020-04-01');
      INSERT INTO comment(conversation_id,author_id,body)
        SELECT id,'ben','Earlier discussion' FROM conversation WHERE owner_id='alice';
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'alice','Action reply' FROM feed_item WHERE item_type<>'earlier'`);
    for (const name of ["017-retire-legacy-triggers", "018-watch-statuses"])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    // Later writes create anchors without flags and add standalone comments,
    // progress entries, replies, and reactions on every kind of target.
    await client.query(`INSERT INTO conversation(id,owner_id,title_id) VALUES (gen_random_uuid(),'alice','tv:2');
      INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body)
        SELECT gen_random_uuid(),id,owner_id,title_id,'Standalone' FROM conversation WHERE owner_id='alice' AND title_id='tv:2';
      INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status)
        SELECT gen_random_uuid(),id,owner_id,title_id,'caught_up' FROM conversation WHERE owner_id='ben';
      INSERT INTO comment(conversation_id,title_comment_id,author_id,body)
        SELECT conversation_id,id,'ben','Standalone reply' FROM title_comment;
      INSERT INTO comment(conversation_id,watch_progress_id,author_id,body)
        SELECT conversation_id,id,'alice','Progress reply' FROM watch_progress;
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT 'ben',id,'love' FROM feed_item;
      INSERT INTO reaction(user_id,title_comment_id,kind) SELECT 'ben',id,'haha' FROM title_comment;
      INSERT INTO reaction(user_id,watch_progress_id,kind) SELECT 'alice',id,'wow' FROM watch_progress;
      INSERT INTO reaction(user_id,comment_id,kind) SELECT 'alice',id,'like' FROM comment WHERE author_id='ben'`);

    const legacy = ["recommended", "want_to_watch", "activity_at"];
    const tables = [
      "conversation",
      "feed_item",
      "title_comment",
      "watch_progress",
      "comment",
      "reaction",
      "notification",
    ];
    // Each row's text starts with its unique ID where it has one, so the
    // order holds when columns are dropped.
    const snapshot = async () => {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of tables)
        result[table] = (
          await rows(`SELECT * FROM ${table} t ORDER BY t::text`)
        ).map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([column]) =>
                table !== "conversation" || !legacy.includes(column),
            ),
          ),
        );
      return result;
    };
    const shape = async () => ({
      columns: (
        await rows(`SELECT column_name FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name='conversation'
          ORDER BY ordinal_position`)
      ).map((row) => row.column_name),
      constraints: (
        await rows(`SELECT conname FROM pg_constraint
          WHERE conrelid='conversation'::regclass AND contype<>'n' ORDER BY conname`)
      ).map((row) => row.conname),
      indexes: (
        await rows(`SELECT indexname FROM pg_indexes
          WHERE schemaname=current_schema() AND tablename='conversation'
          ORDER BY indexname`)
      ).map((row) => row.indexname),
    });
    const notifications = await rows(
      "SELECT id,item_id,title_id FROM visible_notification ORDER BY id",
    );
    const before = await snapshot();
    const shapeBefore = await shape();
    assert.deepEqual(shapeBefore.columns, [
      "id",
      "owner_id",
      "title_id",
      "recommended",
      "want_to_watch",
      "created_at",
      "activity_at",
    ]);
    assert.equal(before.conversation.length, 3);
    assert.deepEqual(
      before.feed_item.map((item) => `${item.item_type}:${item.active}`).sort(),
      ["earlier:false", "recommended:true", "want_to_watch:true"],
    );
    assert.equal(before.comment.length, 5);
    assert.equal(before.reaction.length, 7);
    // The friendship and the four replies to another person's entry.
    assert.deepEqual(
      (await rows("SELECT kind FROM notification ORDER BY id")).map(
        (row) => row.kind,
      ),
      ["friend_accepted", "comment", "comment", "comment", "comment"],
    );
    assert.equal(notifications.length, 5);
    assert.ok(
      shapeBefore.constraints.includes("conversation_exclusive_actions"),
    );

    // It drops only the legacy check and columns; running it again changes
    // nothing.
    for (let run = 0; run < 2; run++) {
      await client.query(await readFile(dropLegacyColumns, "utf8"));
      assert.deepEqual(await shape(), {
        columns: ["id", "owner_id", "title_id", "created_at"],
        constraints: shapeBefore.constraints.filter(
          (name) => name !== "conversation_exclusive_actions",
        ),
        indexes: shapeBefore.indexes,
      });
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        await rows(
          "SELECT id,item_id,title_id FROM visible_notification ORDER BY id",
        ),
        notifications,
      );
    }

    // Retained releases' anchor, entry, and reply writes still work.
    await client.query(`INSERT INTO conversation(id,owner_id,title_id) VALUES (gen_random_uuid(),'ben','movie:1')
        ON CONFLICT(owner_id,title_id) DO NOTHING;
      INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
        SELECT gen_random_uuid(),id,owner_id,title_id,'recommended',true FROM conversation WHERE owner_id='ben' AND title_id='movie:1';
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'alice','New reply' FROM feed_item WHERE owner_id='ben' AND title_id='movie:1'`);
    assert.deepEqual(
      await rows(`SELECT v.item_id=c.feed_item_id AS linked FROM visible_notification v
        JOIN comment c ON c.id=v.comment_id WHERE c.body='New reply'`),
      [{ linked: true }],
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

// Every retained release withdraws the progress entry itself when Want to
// watch turns on, so migration 023 drops the guard migration 018 added for
// the release before it.
const dropWatchStatusGuard = "db/023-drop-watch-status-guard.sql";

test("watch status guard migration drops only the trigger and its function", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA watch_status_guard_migration_test");
    await client.query(
      "SET LOCAL search_path=watch_status_guard_migration_test",
    );
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
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    // Alice has a progress status on one title and Want to watch on another,
    // each with a reply and a reaction.
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES ('alice','ben','ben',now());
      INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:1','movie',1,'Film'),('tv:2','tv',2,'Show');
      INSERT INTO conversation(id,owner_id,title_id) VALUES
        (gen_random_uuid(),'alice','movie:1'),(gen_random_uuid(),'alice','tv:2');
      INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status,finished_on)
        SELECT gen_random_uuid(),id,owner_id,title_id,'finished','2026-10-01' FROM conversation WHERE title_id='movie:1';
      INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
        SELECT gen_random_uuid(),id,owner_id,title_id,'want_to_watch',true FROM conversation WHERE title_id='tv:2';
      INSERT INTO comment(conversation_id,watch_progress_id,author_id,body)
        SELECT conversation_id,id,'ben','Progress reply' FROM watch_progress;
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'ben','Want to watch reply' FROM feed_item;
      INSERT INTO reaction(user_id,watch_progress_id,kind) SELECT 'ben',id,'love' FROM watch_progress;
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT 'ben',id,'wow' FROM feed_item`);

    const tables = [
      "conversation",
      "feed_item",
      "watch_progress",
      "comment",
      "reaction",
      "notification",
    ];
    const snapshot = async () => {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of tables)
        result[table] = await rows(`SELECT * FROM ${table} t ORDER BY t::text`);
      return result;
    };
    const guard = `SELECT proname FROM pg_proc
      WHERE pronamespace=current_schema()::text::regnamespace
      AND proname='screenr_withdraw_progress'`;
    const before = await snapshot();
    assert.deepEqual(
      (await rows(triggers)).map(({ name }) => name),
      ["comment_notify", "feed_item_withdraw_progress", "friendship_notify"],
    );
    assert.deepEqual(await rows(guard), [
      { proname: "screenr_withdraw_progress" },
    ]);
    assert.equal(before.comment.length, 2);
    assert.equal(before.reaction.length, 2);
    assert.equal(before.notification.length, 3);

    // It drops only the guard; running it again changes nothing.
    for (let run = 0; run < 2; run++) {
      await client.query(await readFile(dropWatchStatusGuard, "utf8"));
      assert.deepEqual(
        (await rows(triggers)).map(({ name }) => name),
        ["comment_notify", "friendship_notify"],
      );
      assert.deepEqual(await rows(guard), []);
      assert.deepEqual(await snapshot(), before);
    }

    // The database no longer withdraws a progress status; retained releases
    // do it in the same transaction as Want to watch.
    await client.query(`INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
      SELECT gen_random_uuid(),id,owner_id,title_id,'want_to_watch',true FROM conversation WHERE title_id='movie:1'`);
    assert.deepEqual(await rows("SELECT active FROM watch_progress"), [
      { active: true },
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

// Every retained release removes the top 10 entry itself when Recommend is
// withdrawn or switched to Want to watch, so migration 026 drops the guard
// migration 025 added for the release before it.
const dropTopTenGuard = "db/026-drop-top-ten-guard.sql";

test("top 10 guard migration drops only the trigger and its function", async () => {
  const pool = new Pool({ connectionString: testDatabaseURL });
  const client = await pool.connect();
  const rows = async (sql: string) => (await client.query(sql)).rows;
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA top_ten_guard_migration_test");
    await client.query("SET LOCAL search_path=top_ten_guard_migration_test");
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
      "024-discussion-posts",
      "025-profile-top-ten",
    ])
      await client.query(await readFile(`db/${name}.sql`, "utf8"));
    // Alice recommends and ranks four titles; Ben replies to and reacts to
    // her #1.
    await client.query(`INSERT INTO "user" VALUES ('alice'),('ben');
      INSERT INTO profile(user_id,username,display_name) SELECT id,id,id FROM "user";
      INSERT INTO friendship(low_id,high_id,requested_by,accepted_at) VALUES ('alice','ben','ben',now());
      INSERT INTO title(id,kind,tmdb_id,name) SELECT 'movie:'||n,'movie',n,'Pick '||n FROM generate_series(1,4) n;
      INSERT INTO conversation(id,owner_id,title_id) SELECT gen_random_uuid(),'alice',id FROM title;
      INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
        SELECT gen_random_uuid(),id,owner_id,title_id,'recommended',true FROM conversation;
      INSERT INTO top_ten(owner_id,title_id,rank) SELECT 'alice',id,tmdb_id FROM title;
      INSERT INTO comment(conversation_id,feed_item_id,author_id,body)
        SELECT conversation_id,id,'ben','Recommend reply' FROM feed_item WHERE title_id='movie:1';
      INSERT INTO reaction(user_id,feed_item_id,kind) SELECT 'ben',id,'love' FROM feed_item WHERE title_id='movie:1'`);

    const list = async () =>
      (
        await rows(
          "SELECT title_id,rank FROM top_ten WHERE owner_id='alice' ORDER BY rank",
        )
      ).map(({ title_id, rank }) => `${rank}:${title_id}`);
    // The pre-025 release withdraws Recommend by updating the feed item alone.
    const withdraw = (title: string) =>
      client.query(
        `UPDATE feed_item SET active=false
        WHERE owner_id='alice' AND title_id=$1 AND item_type='recommended'`,
        [title],
      );
    const tables = [
      "conversation",
      "feed_item",
      "top_ten",
      "comment",
      "reaction",
      "notification",
    ];
    const snapshot = async () => {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of tables)
        result[table] = await rows(`SELECT * FROM ${table} t ORDER BY t::text`);
      return result;
    };
    const guard = `SELECT proname FROM pg_proc
      WHERE pronamespace=current_schema()::text::regnamespace
      AND proname='screenr_leave_top_ten'`;

    // Before migration 026, the guard removes the entry and closes the gap.
    assert.deepEqual(
      (await rows(triggers)).map(({ name }) => name),
      ["comment_notify", "feed_item_leave_top_ten", "friendship_notify"],
    );
    assert.deepEqual(await rows(guard), [{ proname: "screenr_leave_top_ten" }]);
    await withdraw("movie:2");
    assert.deepEqual(await list(), ["1:movie:1", "2:movie:3", "3:movie:4"]);
    const before = await snapshot();
    assert.equal(before.comment.length, 1);
    assert.equal(before.reaction.length, 1);
    assert.equal(before.notification.length, 2);

    // It drops only the guard; running it again changes nothing.
    for (let run = 0; run < 2; run++) {
      await client.query(await readFile(dropTopTenGuard, "utf8"));
      assert.deepEqual(
        (await rows(triggers)).map(({ name }) => name),
        ["comment_notify", "friendship_notify"],
      );
      assert.deepEqual(await rows(guard), []);
      assert.deepEqual(await snapshot(), before);
    }

    // The database no longer changes the list; retained releases remove the
    // entry in the same transaction that withdraws Recommend.
    await withdraw("movie:3");
    assert.deepEqual(await list(), ["1:movie:1", "2:movie:3", "3:movie:4"]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

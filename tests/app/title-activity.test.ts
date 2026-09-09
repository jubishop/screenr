import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Use a dedicated test database.");
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const { db } = await import("../../src/server/db");
const { migrate } = await import("../../scripts/migrate");
const {
  updateTitleActivity,
  changeRelationship,
  addComment,
  thread,
  conversations,
  setReaction,
} = await import("../../src/server/social");

before(migrate);
beforeEach(async () => {
  await db.query('TRUNCATE "user", verification RESTART IDENTITY CASCADE');
  await db.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES ('owner','Owner','owner@example.test',true,now(),now()),
           ('friend','Friend','friend@example.test',true,now(),now());
    INSERT INTO profile(user_id,username,display_name)
    VALUES ('owner','owner','Owner'),('friend','friend','Friend');
    INSERT INTO title(id,kind,tmdb_id,name) VALUES ('movie:78','movie',78,'Switching')
    ON CONFLICT DO NOTHING`);
  await changeRelationship("owner", "friend", "request");
  await changeRelationship("friend", "owner", "accept");
});
after(() => db.end());

for (const first of ["recommended", "want_to_watch"] as const) {
  const second = first === "recommended" ? "want_to_watch" : "recommended";
  test(`switching from ${first} preserves both discussions and restores original entries`, async () => {
    const original = await updateTitleActivity(
      "owner",
      "movie:78",
      first,
      true,
    );
    const comment = await addComment(
      "friend",
      original,
      "Original comment",
      false,
    );
    await addComment("owner", original, "Nested reply", false, comment);
    await setReaction("friend", original, null, "love");
    const before = await thread("friend", original);
    const other = await updateTitleActivity("owner", "movie:78", second, true);
    assert.notEqual(original, other);
    const withdrawn = await thread("friend", original);
    assert.equal(withdrawn.conversation.active, false);
    assert.deepEqual(
      withdrawn.conversation.activity_at,
      before.conversation.activity_at,
    );
    assert.deepEqual(withdrawn.comments, before.comments);
    const otherComment = await addComment(
      "friend",
      other,
      "Other discussion",
      false,
    );

    assert.equal(
      await updateTitleActivity("owner", "movie:78", first, true),
      original,
    );
    const restored = await thread("friend", original);
    assert.equal(restored.conversation.active, true);
    assert.deepEqual(restored.comments, before.comments);
    assert.deepEqual(
      restored.conversation.reactions,
      before.conversation.reactions,
    );
    assert.ok(
      new Date(restored.conversation.activity_at).getTime() >
        new Date(before.conversation.activity_at).getTime(),
    );
    assert.equal((await thread("friend", other)).conversation.active, false);

    assert.equal(
      await updateTitleActivity("owner", "movie:78", second, true),
      other,
    );
    assert.equal((await thread("friend", other)).comments[0].id, otherComment);
    assert.equal((await thread("friend", original)).conversation.active, false);
    await updateTitleActivity("owner", "movie:78", second, false);
    const removed = await thread("friend", other);
    assert.equal(removed.conversation.active, false);
    assert.equal(
      (await conversations("owner")).some((item) => item.active),
      false,
    );
    assert.equal(
      await updateTitleActivity("owner", "movie:78", second, true),
      other,
    );
    assert.deepEqual(
      (await thread("friend", other)).comments,
      removed.comments,
    );

    for (const filter of [{}, { title: "movie:78" }, { owner: "owner" }]) {
      const entries = await conversations("owner", filter);
      assert.equal(entries.length, 2);
      for (const entry of entries) {
        assert.equal(entry.viewer_recommended, second === "recommended");
        assert.equal(entry.viewer_want_to_watch, second === "want_to_watch");
      }
    }
  });
}

test("concurrent and repeated action writes leave one active entry without duplicating or bumping it", async () => {
  const ids = await Promise.all(
    ["recommended", "want_to_watch", "recommended", "want_to_watch"].map(
      (field) => updateTitleActivity("owner", "movie:78", field, true),
    ),
  );
  assert.equal(ids[0], ids[2]);
  assert.equal(ids[1], ids[3]);
  const entries = await conversations("owner");
  assert.equal(entries.length, 1);
  const active = entries[0];
  await Promise.all(
    Array.from({ length: 4 }, () =>
      updateTitleActivity("owner", "movie:78", active.item_type, true),
    ),
  );
  assert.deepEqual(
    (await thread("owner", active.id)).conversation.activity_at,
    active.activity_at,
  );
  const flags = (
    await db.query(
      "SELECT recommended,want_to_watch FROM conversation WHERE owner_id='owner'",
    )
  ).rows[0];
  assert.notEqual(flags.recommended, flags.want_to_watch);
});

test("database rejects conflicting conversation flags and active feed items on inserts and updates", async () => {
  await assert.rejects(
    db.query(`INSERT INTO conversation(id,owner_id,title_id,recommended,want_to_watch)
    VALUES(gen_random_uuid(),'owner','movie:78',true,true)`),
    { code: "23514" },
  );
  const recommendation = await updateTitleActivity(
    "owner",
    "movie:78",
    "recommended",
    true,
  );
  await assert.rejects(
    db.query(
      "UPDATE conversation SET want_to_watch=true WHERE owner_id='owner'",
    ),
    { code: "23514" },
  );
  await assert.rejects(
    db.query(
      `INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
    SELECT gen_random_uuid(),conversation_id,owner_id,title_id,'want_to_watch',true
    FROM feed_item WHERE id=$1`,
      [recommendation],
    ),
    { code: "23505" },
  );
  await updateTitleActivity("owner", "movie:78", "want_to_watch", false);
  await assert.rejects(
    db.query(
      "UPDATE feed_item SET active=true WHERE owner_id='owner' AND item_type='want_to_watch'",
    ),
    { code: "23505" },
  );
  assert.equal(
    (await thread("owner", recommendation)).conversation.active,
    true,
  );
});

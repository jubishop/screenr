import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const {
  changeRelationship,
  updateTitleActivity,
  thread,
  addComment,
  createTitleComment,
  removeComment,
  conversations,
} = await import("../../src/server/social");

useDatabase();

test("standalone comments persist for movies and TV without changing structured activity", async () => {
  const { alice, ben, conversation: recommendation } = await setup();
  await friend(alice, ben);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('tv:8','tv',8,'Test Show') ON CONFLICT DO NOTHING",
  );
  const saved = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  const before = await conversations(alice);
  const state = (
    await db.query(
      "SELECT * FROM conversation WHERE owner_id=$1 ORDER BY title_id",
      [alice],
    )
  ).rows;
  const first = await createTitleComment(
    alice,
    "movie:1",
    "  First thought  ",
    false,
  );
  const second = await createTitleComment(
    alice,
    "movie:1",
    "Another thought",
    true,
  );
  const tv = await createTitleComment(
    alice,
    "tv:8",
    "A thought without any title action",
    false,
  );
  assert.notEqual(first, second);
  assert.deepEqual(
    (
      await db.query(
        "SELECT * FROM conversation WHERE owner_id=$1 AND title_id='movie:1'",
        [alice],
      )
    ).rows,
    state,
  );
  for (const item of before)
    assert.deepEqual(
      (await thread(alice, item.id)).conversation,
      (({ comments, ...c }) => c)(item),
    );
  assert.equal((await thread(alice, first)).conversation.body, "First thought");
  assert.equal((await thread(alice, second)).conversation.spoiler, true);
  assert.equal((await thread(alice, tv)).conversation.item_type, "comment");
  assert.equal((await thread(alice, tv)).conversation.recommended, false);
  assert.equal((await thread(alice, tv)).conversation.want_to_watch, false);
  const reply = await addComment(ben, first, "Only on the first", false);
  await assert.rejects(thread(alice, recommendation), /not found/);
  for (const id of [second, tv, saved])
    assert.deepEqual((await thread(alice, id)).comments, []);
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const screen = await loadScreen(ben, path);
    assert.ok("conversations" in screen && screen.conversations);
    const item = screen.conversations.find((c) => c.id === first)!;
    assert.equal(item.body, "First thought");
    assert.deepEqual(
      item.comments.map((c) => c.id),
      [reply],
    );
    assert.equal(screen.conversations.filter((c) => c.id === first).length, 1);
  }
  const profile = await loadScreen(ben, "/people/ben");
  assert.ok(profile.kind === "profile");
  assert.deepEqual(profile.conversations, []);
  for (const body of ["", " ", null, 8, "x".repeat(2001)])
    await assert.rejects(
      createTitleComment(alice, "movie:1", body, false),
      /Comment must/,
    );
  await assert.rejects(
    createTitleComment(alice, "movie:1", "Valid", "false"),
    /spoiler/,
  );
  await assert.rejects(
    createTitleComment(alice, "movie:999999", "Valid", false),
    /Title not found/,
  );
  assert.equal(
    (await conversations(alice)).filter((c) => c.item_type === "comment")
      .length,
    3,
  );
});

test("standalone discussions enforce current access, independent replies, removal, and visible ordering", async () => {
  const { alice, ben, cam, outsider } = await setup();
  const first = await createTitleComment(
    alice,
    "movie:1",
    "Independent discussion",
    true,
  );
  await changeRelationship(ben, alice, "request");
  for (const viewer of [ben, outsider]) {
    await assert.rejects(thread(viewer, first), /not found/);
    await assert.rejects(
      addComment(viewer, first, "No access", false),
      /not found/,
    );
    assert.deepEqual(await conversations(viewer), []);
  }
  await changeRelationship(alice, ben, "accept");
  await friend(alice, cam);
  await friend(ben, outsider);
  const second = await createTitleComment(
    alice,
    "movie:1",
    "Separate discussion",
    false,
  );
  const parent = await addComment(ben, first, "First reply", false);
  const child = await addComment(cam, first, "Reply to Ben", false, parent);
  const grandchild = await addComment(
    alice,
    first,
    "Reply to Cam",
    false,
    child,
  );
  const discussion = await thread(ben, first);
  assert.deepEqual(
    discussion.comments.map((c) => [c.id, c.root_id, c.addressed_username]),
    [
      [parent, null, null],
      [child, parent, "ben"],
      [grandchild, parent, "cam"],
    ],
  );
  assert.equal((await conversations(ben))[0].id, first);
  assert.deepEqual(await conversations(outsider), []);
  await assert.rejects(
    addComment(outsider, first, "No access through Ben", false),
    /not found/,
  );
  await assert.rejects(
    addComment(ben, second, "Wrong group", false, child),
    /not found/,
  );
  await assert.rejects(removeComment(ben, child), /not found/);
  await removeComment(alice, parent);
  assert.equal((await thread(ben, first)).comments[0].removed, true);
  assert.equal((await thread(ben, first)).comments.length, 3);
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, first), /not found/);
  await assert.rejects(addComment(ben, first, "Revoked", false), /not found/);
  assert.deepEqual(
    (await thread(cam, first)).comments.map((c) => c.id),
    [parent, child, grandchild],
  );
  await friend(alice, ben);
  assert.equal((await thread(ben, first)).comments.length, 3);
  await changeRelationship(ben, cam, "block");
  const beforeHiddenActivity = (await thread(ben, first)).conversation
    .visible_activity;
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 day' WHERE id::text=$1",
    [child],
  );
  assert.equal(
    new Date(
      (await thread(ben, first)).conversation.visible_activity,
    ).getTime(),
    new Date(beforeHiddenActivity).getTime(),
  );
  assert.deepEqual(
    (await thread(ben, first)).comments.map((c) => c.id),
    [parent, grandchild],
  );
  await assert.rejects(
    addComment(ben, first, "Hidden target", false, child),
    /not found/,
  );
  assert.equal((await thread(alice, first)).comments.length, 3);
  await changeRelationship(ben, alice, "block");
  await assert.rejects(thread(ben, first), /not found/);
  await assert.rejects(addComment(ben, first, "Blocked", false), /not found/);
});

test("standalone deletion erases only the author's starting text and preserves eligible replies in every feed", async () => {
  const { alice, ben, cam, outsider, conversation: action } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const id = await createTitleComment(
    alice,
    "movie:1",
    "Delete this spoiler",
    true,
  );
  const other = await createTitleComment(
    alice,
    "movie:1",
    "Keep this entry",
    false,
  );
  const parent = await addComment(ben, id, "Keep this reply", false);
  const child = await addComment(
    cam,
    id,
    "Keep this nested reply",
    true,
    parent,
  );
  const before = (await thread(alice, id)).conversation;
  for (const viewer of [ben, cam, outsider])
    await assert.rejects(removeComment(viewer, id), /not found/);
  await assert.rejects(removeComment(alice, action), /not found/);
  assert.equal(
    (await thread(alice, id)).conversation.body,
    "Delete this spoiler",
  );

  await removeComment(alice, id);
  await removeComment(alice, id);
  for (const viewer of [alice, ben, cam]) {
    for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
      const entries = await conversations(viewer, filter);
      const removed = entries.find((entry) => entry.id === id)!;
      assert.equal(removed.active, false);
      assert.equal(removed.body, "");
      assert.equal(removed.spoiler, true);
      assert.deepEqual(
        removed.comments.map((reply) => reply.id),
        [parent, child],
      );
      assert.equal(removed.comments[1].root_id, parent);
      assert.equal(removed.comments[1].addressed_username, "ben");
      assert.equal(removed.comments[0].body, "Keep this reply");
      assert.equal(removed.comments[1].body, "Keep this nested reply");
      assert.equal(
        new Date(removed.visible_activity).getTime(),
        new Date(before.visible_activity).getTime(),
      );
      assert.equal(
        entries.find((entry) => entry.id === other)?.body,
        "Keep this entry",
      );
      assert.equal(entries.find((entry) => entry.id === action)?.active, true);
    }
  }
  assert.equal(
    (await db.query("SELECT body FROM title_comment WHERE id::text=$1", [id]))
      .rows[0].body,
    "[removed]",
  );
  const linked = await loadScreen(
    ben,
    `/titles/movie/1?item=${id}&reply=${child}`,
  );
  assert.equal(linked.kind, "title");
  if (linked.kind !== "title") throw new Error("Expected title");
  assert.equal(linked.targetUnavailable, false);
  const continued = await addComment(
    ben,
    id,
    "Continue this discussion",
    false,
  );
  const nested = await addComment(
    cam,
    id,
    "Continue the reply group",
    false,
    parent,
  );
  const ongoing = await thread(alice, id);
  assert.ok(ongoing.comments.some((reply) => reply.id === continued));
  assert.equal(
    ongoing.comments.find((reply) => reply.id === nested)?.root_id,
    parent,
  );
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, id), /not found/);
  await assert.rejects(removeComment(ben, parent), /not found/);
  await friend(alice, ben);
  assert.equal((await thread(ben, id)).conversation.body, "");
  await changeRelationship(alice, ben, "block");
  await assert.rejects(thread(ben, id), /not found/);
});

test("deleted standalone entries disappear when no live reply is visible to the reader", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const empty = await createTitleComment(alice, "movie:1", "No replies", false);
  await removeComment(alice, empty);
  await removeComment(alice, empty);
  await assert.rejects(thread(alice, empty), /not found/);
  await assert.rejects(
    addComment(alice, empty, "Cannot revive an empty deleted entry", false),
    /not found/,
  );
  const linked = await loadScreen(alice, `/titles/movie/1?item=${empty}`);
  assert.equal(linked.kind, "title");
  if (linked.kind !== "title") throw new Error("Expected title");
  assert.equal(linked.targetUnavailable, true);

  const id = await createTitleComment(alice, "movie:1", "Starting text", false);
  const reply = await addComment(cam, id, "Only live reply", false);
  await removeComment(alice, id);
  await changeRelationship(ben, cam, "block");
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    assert.ok(
      !(await conversations(ben, filter)).some(
        (entry) => entry.id === empty || entry.id === id,
      ),
    );
    assert.ok(
      (await conversations(alice, filter)).some((entry) => entry.id === id),
    );
  }
  await assert.rejects(thread(ben, id), /not found/);
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await thread(ben, id)).conversation.body, "");
  await changeRelationship(alice, cam, "remove");
  await assert.rejects(thread(alice, id), /not found/);
  await friend(alice, cam);
  assert.equal((await thread(ben, id)).comments[0].id, reply);
  await removeComment(cam, reply);
  for (const viewer of [alice, ben, cam])
    await assert.rejects(thread(viewer, id), /not found/);
});

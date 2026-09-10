import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const {
  changeRelationship,
  thread,
  addComment,
  createTitleComment,
  removeComment,
  conversations,
} = await import("../../src/server/social");

useDatabase();

for (const kind of ["action", "standalone"] as const) {
  test(`comment authors can delete their own comments in a friend's ${kind} conversation and preserve replies`, async () => {
    const { alice, ben, cam, outsider, conversation: action } = await setup();
    const conversation =
      kind === "standalone"
        ? await createTitleComment(
            alice,
            "movie:1",
            "Standalone discussion",
            false,
          )
        : action;
    await friend(alice, ben);
    await friend(alice, cam);
    const parent = await addComment(ben, conversation, "My comment", true);
    const reply = await addComment(
      cam,
      conversation,
      "Keep this reply",
      false,
      parent,
    );
    for (const viewer of [cam, outsider])
      await assert.rejects(removeComment(viewer, parent), /not found/);
    assert.equal(
      (await thread(ben, conversation)).comments[0].body,
      "My comment",
    );

    await removeComment(ben, parent);
    await removeComment(ben, parent);
    for (const viewer of [alice, ben, cam]) {
      const comments = (await thread(viewer, conversation)).comments;
      assert.equal(comments[0].removed, true);
      assert.equal(comments[0].body, "");
      assert.equal(comments[1].id, reply);
      assert.equal(comments[1].root_id, parent);
      assert.equal(comments[1].addressed_username, "ben");
      assert.equal(comments[1].body, "Keep this reply");
    }
    assert.equal(
      (await db.query("SELECT body FROM comment WHERE id::text=$1", [parent]))
        .rows[0].body,
      "[removed]",
    );
    await removeComment(cam, reply);
    assert.deepEqual((await thread(alice, conversation)).comments, []);
    await assert.rejects(
      addComment(ben, conversation, "Reply to removed", false, parent),
      /not found/,
    );
  });

  test(`comment deletion rechecks current ${kind} conversation access`, async () => {
    const { alice, ben, conversation: action } = await setup();
    const conversation =
      kind === "standalone"
        ? await createTitleComment(
            alice,
            "movie:1",
            "Standalone discussion",
            false,
          )
        : action;
    await friend(alice, ben);
    const comment = await addComment(
      ben,
      conversation,
      "Existing comment",
      false,
    );
    await changeRelationship(alice, ben, "remove");
    await assert.rejects(removeComment(ben, comment), /not found/);
    await assert.rejects(removeComment(alice, comment), /not found/);
    await friend(alice, ben);
    await changeRelationship(alice, ben, "block");
    await assert.rejects(removeComment(ben, comment), /not found/);
    await changeRelationship(alice, ben, "unblock");
    await friend(alice, ben);
    assert.equal(
      (await thread(ben, conversation)).comments[0].body,
      "Existing comment",
    );
    await removeComment(ben, comment);
    const own = await addComment(
      alice,
      conversation,
      "Host's own comment",
      false,
    );
    await removeComment(alice, own);
    assert.deepEqual((await thread(alice, conversation)).comments, []);
  });
}

test("nested replies stay in one group; the host can remove others' comments and preserve replies", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(ben, conversation, "Original", true);
  const reply = await addComment(cam, conversation, "Reply", false, parent);
  await addComment(alice, conversation, "Reply to reply", false, reply);
  const before = await thread(alice, conversation);
  assert.deepEqual(
    before.comments.map((c) => c.root_id),
    [null, parent, parent],
  );
  assert.equal(before.comments[2].addressed_username, "cam");
  await assert.rejects(removeComment(cam, parent));
  await removeComment(alice, parent);
  const after = await thread(cam, conversation);
  assert.equal(after.comments[0].body, "");
  assert.equal(after.comments[0].removed, true);
  assert.equal(after.comments.length, 3);
});

test("nested groups retain only safe parent context through blocking, removal, and friendship changes", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(cam, conversation, "Private parent", true);
  const empty = await addComment(
    cam,
    conversation,
    "Empty hidden group",
    false,
  );
  const child = await addComment(
    ben,
    conversation,
    "Visible child",
    false,
    parent,
  );
  const removedChild = await addComment(
    alice,
    conversation,
    "Removed child",
    false,
    parent,
  );
  await removeComment(alice, removedChild);
  await changeRelationship(ben, cam, "block");
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    const comments = (await conversations(ben, filter))[0].comments;
    assert.deepEqual(
      comments.map((c) => c.id),
      [parent, child],
    );
    assert.deepEqual(comments[0], {
      id: parent,
      root_id: null,
      author_id: null,
      username: null,
      display_name: null,
      body: "",
      spoiler: false,
      addressed_username: null,
      removed: false,
      unavailable: true,
      reactions: [],
      created_at: comments[0].created_at,
    });
    assert.equal(comments[1].addressed_username, null);
  }
  await assert.rejects(
    addComment(ben, conversation, "No hidden targets", false, parent),
    /not found/,
  );
  await assert.rejects(
    addComment(ben, conversation, "No removed targets", false, removedChild),
    /not found/,
  );
  await assert.rejects(thread(outsider, conversation), /not found/);
  const sibling = await addComment(
    ben,
    conversation,
    "Reply to visible child",
    false,
    child,
  );
  assert.equal(
    (await thread(ben, conversation)).comments.at(-1)!.root_id,
    parent,
  );
  await changeRelationship(ben, cam, "unblock");
  assert.equal(
    (await thread(ben, conversation)).comments[0].body,
    "Private parent",
  );
  await changeRelationship(alice, cam, "remove");
  assert.equal((await thread(ben, conversation)).comments[0].unavailable, true);
  await friend(alice, cam);
  assert.equal(
    (await thread(ben, conversation)).comments[0].unavailable,
    false,
  );
  await removeComment(alice, parent);
  await removeComment(alice, empty);
  const after = (await thread(ben, conversation)).comments;
  assert.deepEqual(
    after.map((c) => c.id),
    [parent, child, sibling],
  );
  assert.equal(after[0].removed, true);
  assert.equal(after[0].body, "");
  await removeComment(alice, child);
  await removeComment(alice, sibling);
  assert.deepEqual((await thread(ben, conversation)).comments, []);
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, conversation), /not found/);
});

test("nested reply links reject unavailable parents and preserve stored groups on every feed", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await db.query(
    "INSERT INTO title_trailer(title_id,trailer,expires_at) VALUES('movie:1',NULL,now()+interval '1 day') ON CONFLICT(title_id) DO UPDATE SET expires_at=excluded.expires_at",
  );
  const parent = await addComment(cam, conversation, "Parent", false);
  const child = await addComment(
    alice,
    conversation,
    "Spoiler child",
    true,
    parent,
  );
  for (let i = 0; i < 5; i++)
    await addComment(alice, conversation, `Later ${i}`, false);
  await changeRelationship(ben, cam, "block");
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const screen = await loadScreen(ben, path);
    assert.ok("conversations" in screen && screen.conversations);
    assert.equal(screen.conversations[0].comments[0].id, parent);
    assert.equal(screen.conversations[0].comments[1].root_id, parent);
  }
  const hidden = await loadScreen(
    ben,
    `/titles/movie/1?item=${conversation}&reply=${parent}`,
  );
  assert.ok(hidden.kind === "title");
  assert.equal(hidden.targetUnavailable, true);
  assert.equal(hidden.target?.reply, undefined);
  const visible = await loadScreen(
    ben,
    `/titles/movie/1?item=${conversation}&reply=${child}`,
  );
  assert.ok(visible.kind === "title");
  assert.equal(visible.target?.reply, child);
  assert.equal(visible.conversations[0].comments[1].spoiler, true);
});

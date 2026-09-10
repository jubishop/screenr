import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, setup } from "./social-fixture";
const {
  changeRelationship,
  updateTitleActivity,
  thread,
  addComment,
  removeComment,
  conversations,
} = await import("../../src/server/social");

useDatabase();

test("feed action states belong to the viewer across circle, title, and profile reads", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "Keep this discussion", false);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  for (const [field, value, recommended, wantToWatch] of [
    ["recommended", true, true, false],
    ["want_to_watch", true, false, true],
    ["recommended", false, false, true],
    ["want_to_watch", false, false, false],
    ["want_to_watch", true, false, true],
    ["recommended", true, true, false],
  ] as const) {
    await updateTitleActivity(ben, "movie:1", field, value);
    for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
      const entries = (await conversations(ben, filter)).filter(
        (item) => item.owner_id === alice,
      );
      assert.equal(entries.length, 2);
      for (const item of entries) {
        assert.equal(item.viewer_recommended, recommended);
        assert.equal(item.viewer_want_to_watch, wantToWatch);
      }
    }
    const entry = (await thread(ben, conversation)).conversation;
    assert.equal(entry.viewer_recommended, recommended);
    assert.equal(entry.viewer_want_to_watch, wantToWatch);
  }
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  await updateTitleActivity(ben, "movie:1", "recommended", true);
  const withdrawn = (await thread(ben, conversation)).conversation;
  assert.equal(withdrawn.recommended, false);
  assert.equal(withdrawn.viewer_recommended, true);
});

test("action items persist independently, removal does not bump activity, and reactivation reuses replies", async () => {
  const { alice, ben, cam, conversation: recommendation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const reply = await addComment(
    ben,
    recommendation,
    "About the recommendation",
    false,
  );
  const saved = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  assert.notEqual(saved, recommendation);
  assert.equal((await thread(alice, saved)).comments.length, 0);
  const original = (await thread(ben, recommendation)).conversation.activity_at;
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  const removed = await thread(ben, recommendation);
  assert.equal(
    new Date(removed.conversation.activity_at).getTime(),
    new Date(original).getTime(),
  );
  assert.equal(removed.conversation.recommended, false);
  assert.equal(removed.comments[0].id, reply);
  assert.equal((await thread(ben, saved)).conversation.want_to_watch, true);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", false);
  assert.deepEqual(
    (await conversations(ben)).map((c) => c.id),
    [recommendation],
  );
  await changeRelationship(cam, ben, "block");
  assert.deepEqual(await conversations(cam), []);
  await assert.rejects(thread(cam, recommendation), /not found/);
  await assert.rejects(
    addComment(cam, recommendation, "Invisible item", false),
    /not found/,
  );
  assert.equal(
    await updateTitleActivity(alice, "movie:1", "recommended", true),
    recommendation,
  );
  const restored = await thread(ben, recommendation);
  assert.ok(new Date(restored.conversation.activity_at) > new Date(original));
  assert.equal(restored.comments[0].id, reply);
  const activation = restored.conversation.activity_at;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      updateTitleActivity(alice, "movie:1", "recommended", true),
    ),
  );
  assert.equal(
    new Date(
      (await thread(ben, recommendation)).conversation.activity_at,
    ).getTime(),
    new Date(activation).getTime(),
  );
  assert.equal((await conversations(ben)).length, 1);
});

test("all feeds share entries and order by only visible replies without promoting reply authors", async () => {
  const { alice, ben, cam, outsider, conversation: first } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, outsider);
  const reply = await addComment(cam, first, "Mutual friend's reply", true);
  const second = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 second' WHERE id::text=$1",
    [reply],
  );
  const ownCam = await updateTitleActivity(cam, "movie:1", "recommended", true);
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    const entries = await conversations(ben, filter);
    assert.deepEqual(
      entries.map((c) => c.id),
      [first, second],
    );
    assert.equal((await thread(ben, entries[0].id)).comments[0].id, reply);
    assert.ok(!entries.some((c) => c.id === ownCam));
  }
  await addComment(ben, first, "My reply does not expand access", false);
  assert.deepEqual(await conversations(outsider), []);
  await assert.rejects(
    addComment(outsider, first, "No access", false),
    /not found/,
  );
  await assert.rejects(
    addComment(ben, second, "Wrong item", false, reply),
    /not found/,
  );
  await changeRelationship(ben, cam, "block");
  await assert.rejects(
    addComment(ben, first, "Blocked target", false, reply),
    /not found/,
  );
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 day' WHERE id::text=$1",
    [reply],
  );
  const ordered = (await conversations(ben)).map((c) => [
    c.id,
    c.visible_activity,
  ]);
  await db.query(
    "UPDATE comment SET created_at=now()+interval '2 days' WHERE id::text=$1",
    [reply],
  );
  assert.deepEqual(
    (await conversations(ben)).map((c) => [c.id, c.visible_activity]),
    ordered,
  );
});

test("clearing activity hides empty items while preserving eligible discussions", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }])
    assert.deepEqual(await conversations(ben, filter), []);
  await assert.rejects(thread(alice, conversation), /not found/);
  const saved = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  assert.equal((await conversations(ben))[0].id, saved);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", false);
  await updateTitleActivity(alice, "movie:1", "recommended", true);
  const comment = await addComment(
    cam,
    conversation,
    "Keep this discussion",
    false,
  );
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  assert.equal((await conversations(ben))[0].id, conversation);
  await changeRelationship(ben, cam, "block");
  assert.deepEqual(await conversations(ben), []);
  assert.equal((await conversations(alice))[0].id, conversation);
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await conversations(ben))[0].id, conversation);
  await changeRelationship(alice, cam, "remove");
  assert.deepEqual(await conversations(ben), []);
  await friend(alice, cam);
  assert.equal((await conversations(ben))[0].id, conversation);
  await removeComment(alice, comment);
  assert.deepEqual(await conversations(ben), []);
  assert.equal(
    await updateTitleActivity(alice, "movie:1", "recommended", true),
    conversation,
  );
  assert.equal((await conversations(ben))[0].id, conversation);
});

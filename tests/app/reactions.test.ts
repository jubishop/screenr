import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useDatabase, db, friend, setup } from "./social-fixture";
const {
  changeRelationship,
  updateTitleActivity,
  thread,
  addComment,
  createTitleComment,
  removeComment,
  conversations,
  setReaction,
} = await import("../../src/server/social");

useDatabase();

test("reactions support all seven kinds and one replaceable response per person on every entry and reply", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const actionReply = await addComment(
    ben,
    conversation,
    "Action reply",
    false,
  );
  const watch = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  const comment = await createTitleComment(
    alice,
    "movie:1",
    "Standalone",
    false,
  );
  const direct = await addComment(ben, comment, "Direct", false);
  const nested = await addComment(alice, comment, "Nested", false, direct);
  for (const [item, reply] of [
    [conversation, undefined],
    [watch, undefined],
    [comment, undefined],
    [comment, direct],
    [comment, nested],
    [conversation, actionReply],
  ] as const) {
    const read = async (viewer = ben) => {
      const result = await thread(viewer, item);
      return reply
        ? result.comments.find((c) => c.id === reply)!.reactions
        : result.conversation.reactions;
    };
    assert.deepEqual(await read(), []);
    for (const kind of [
      "like",
      "love",
      "care",
      "haha",
      "wow",
      "sad",
      "angry",
    ]) {
      await setReaction(ben, item, reply, kind);
      await setReaction(ben, item, reply, kind);
      assert.deepEqual(await read(), [{ kind, count: 1, reacted: true }]);
      assert.deepEqual(await read(alice), [{ kind, count: 1, reacted: false }]);
    }
    await setReaction(alice, item, reply, "angry");
    assert.deepEqual(await read(), [
      { kind: "angry", count: 2, reacted: true },
    ]);
    await Promise.all([
      setReaction(ben, item, reply, "love"),
      setReaction(ben, item, reply, "love"),
    ]);
    assert.deepEqual(await read(), [
      { kind: "angry", count: 1, reacted: false },
      { kind: "love", count: 1, reacted: true },
    ]);
    await setReaction(ben, item, reply, null);
    await setReaction(ben, item, reply, null);
    assert.deepEqual(await read(), [
      { kind: "angry", count: 1, reacted: false },
    ]);
  }
});

test("reaction reads and writes enforce current friendship, blocks, target membership, and removal", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const reply = await addComment(cam, conversation, "Cam's reply", false);
  await addComment(
    alice,
    conversation,
    "Keep the removed parent",
    false,
    reply,
  );
  for (const target of [undefined, reply]) {
    await assert.rejects(
      setReaction(outsider, conversation, target, "like"),
      /not found/i,
    );
    await changeRelationship(outsider, alice, "request");
    await assert.rejects(
      setReaction(outsider, conversation, target, "like"),
      /not found/i,
    );
    await setReaction(ben, conversation, target, "love");
  }
  assert.deepEqual((await thread(cam, conversation)).conversation.reactions, [
    { kind: "love", count: 1, reacted: false },
  ]);
  assert.deepEqual((await thread(cam, conversation)).comments[0].reactions, [
    { kind: "love", count: 1, reacted: false },
  ]);
  await changeRelationship(cam, ben, "block");
  assert.deepEqual(
    (await thread(cam, conversation)).conversation.reactions,
    [],
  );
  assert.deepEqual((await thread(cam, conversation)).comments[0].reactions, []);
  assert.deepEqual((await thread(alice, conversation)).conversation.reactions, [
    { kind: "love", count: 1, reacted: false },
  ]);
  await assert.rejects(
    setReaction(ben, conversation, reply, "haha"),
    /not found/i,
  );
  await changeRelationship(cam, ben, "unblock");
  await changeRelationship(alice, ben, "remove");
  assert.deepEqual(
    (await thread(cam, conversation)).conversation.reactions,
    [],
  );
  assert.deepEqual((await thread(cam, conversation)).comments[0].reactions, []);
  await assert.rejects(
    setReaction(ben, conversation, undefined, null),
    /not found/i,
  );
  await friend(alice, ben);
  assert.equal(
    (await thread(cam, conversation)).conversation.reactions[0].count,
    1,
  );
  assert.equal(
    (await thread(cam, conversation)).comments[0].reactions[0].count,
    1,
  );
  const other = await createTitleComment(
    alice,
    "movie:1",
    "Different entry",
    false,
  );
  await assert.rejects(setReaction(ben, other, reply, "like"), /not found/i);
  await removeComment(alice, reply);
  assert.deepEqual((await thread(cam, conversation)).comments[0].reactions, []);
  await assert.rejects(
    setReaction(ben, conversation, reply, "like"),
    /not found/i,
  );
  await changeRelationship(alice, ben, "block");
  await assert.rejects(
    setReaction(ben, conversation, undefined, "like"),
    /not found/i,
  );
});

test("reactions exclude deleted standalone entries while preserving their live replies", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const item = await createTitleComment(
    alice,
    "movie:1",
    "Starting text",
    false,
  );
  const reply = await addComment(ben, item, "Surviving reply", false);
  await setReaction(ben, item, undefined, "love");
  await setReaction(alice, item, reply, "care");
  await removeComment(alice, item);
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    const entry = (await conversations(ben, filter)).find(
      (entry) => entry.id === item,
    )!;
    assert.equal(entry.active, false);
    assert.equal(entry.body, "");
    assert.deepEqual(entry.reactions, []);
    assert.deepEqual(entry.comments[0].reactions, [
      { kind: "care", count: 1, reacted: false },
    ]);
  }
  for (const viewer of [alice, ben]) {
    for (const kind of ["like", null]) {
      await assert.rejects(
        setReaction(viewer, item, undefined, kind),
        /not found/i,
      );
    }
  }
  await setReaction(ben, item, reply, "love");
  assert.deepEqual((await thread(ben, item)).comments[0].reactions, [
    { kind: "care", count: 1, reacted: false },
    { kind: "love", count: 1, reacted: true },
  ]);
});

test("reactions exclude unavailable parent placeholders while keeping eligible children reactable", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(cam, conversation, "Hidden parent", false);
  const child = await addComment(
    alice,
    conversation,
    "Visible child",
    false,
    parent,
  );
  await setReaction(alice, conversation, parent, "love");
  for (const hide of ["block", "unfriend"] as const) {
    if (hide === "block") await changeRelationship(ben, cam, "block");
    else await changeRelationship(alice, cam, "remove");
    for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
      const item = (await conversations(ben, filter)).find(
        (item) => item.id === conversation,
      )!;
      const placeholder = item.comments.find(
        (comment) => comment.id === parent,
      )!;
      assert.equal(placeholder.unavailable, true);
      assert.deepEqual(placeholder.reactions, []);
    }
    for (const kind of ["like", null])
      await assert.rejects(
        setReaction(ben, conversation, parent, kind),
        /not found/i,
      );
    await setReaction(ben, conversation, child, "care");
    assert.deepEqual(
      (await thread(ben, conversation)).comments.find(
        (comment) => comment.id === child,
      )!.reactions,
      [{ kind: "care", count: 1, reacted: true }],
    );
    if (hide === "block") await changeRelationship(ben, cam, "unblock");
    else await friend(alice, cam);
    assert.deepEqual(
      (await thread(ben, conversation)).comments.find(
        (comment) => comment.id === parent,
      )!.reactions,
      [{ kind: "love", count: 1, reacted: false }],
    );
  }
});

test("reactions share feed snapshots without changing activity, notifications, or withdrawn-action visibility", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const before = await conversations(ben);
  const jobsBefore = (
    await db.query("SELECT count(*)::int AS n FROM email_job")
  ).rows[0].n;
  await setReaction(ben, conversation, undefined, "care");
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }]) {
    const items = await conversations(ben, filter);
    assert.deepEqual(items[0].reactions, [
      { kind: "care", count: 1, reacted: true },
    ]);
    assert.deepEqual(
      items.map((c) => [c.id, c.visible_activity]),
      before.map((c) => [c.id, c.visible_activity]),
    );
  }
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM email_job")).rows[0].n,
    jobsBefore,
  );
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  assert.deepEqual(await conversations(ben), []);
  await assert.rejects(
    setReaction(ben, conversation, undefined, "like"),
    /not found/i,
  );
  await updateTitleActivity(alice, "movie:1", "recommended", true);
  assert.deepEqual((await thread(ben, conversation)).conversation.reactions, [
    { kind: "care", count: 1, reacted: true },
  ]);
});

test("reactions reject unsupported values and invalid or missing targets without changing the saved response", async () => {
  const { alice, conversation } = await setup();
  await setReaction(alice, conversation, undefined, "like");
  for (const kind of ["", "LIKE", "dislike", "👍", 1, {}, undefined])
    await assert.rejects(
      setReaction(alice, conversation, undefined, kind),
      /invalid reaction/i,
    );
  for (const reply of ["", "invalid", 1, {}])
    await assert.rejects(
      setReaction(alice, conversation, reply, "love"),
      /invalid reply/i,
    );
  await assert.rejects(
    setReaction(alice, randomUUID(), undefined, "like"),
    /not found/i,
  );
  await assert.rejects(
    setReaction(alice, conversation, "9999999999999999999999999", "like"),
    /not found/i,
  );
  assert.deepEqual((await thread(alice, conversation)).conversation.reactions, [
    { kind: "like", count: 1, reacted: true },
  ]);
});

test("earlier discussions and retained withdrawn actions support independent reactions", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const legacy = (
    await db.query(
      "SELECT id FROM conversation WHERE owner_id=$1 AND title_id='movie:1'",
      [alice],
    )
  ).rows[0].id;
  const reply = (
    await db.query(
      "INSERT INTO comment(conversation_id,author_id,body) VALUES($1,$2,'Earlier reply') RETURNING id::text",
      [legacy, ben],
    )
  ).rows[0].id;
  await setReaction(ben, legacy, undefined, "wow");
  await setReaction(alice, legacy, reply, "care");
  const result = await thread(ben, legacy);
  assert.equal(result.conversation.item_type, "earlier");
  assert.deepEqual(result.conversation.reactions, [
    { kind: "wow", count: 1, reacted: true },
  ]);
  assert.deepEqual(result.comments[0].reactions, [
    { kind: "care", count: 1, reacted: false },
  ]);
  await addComment(ben, conversation, "Keep this discussion", false);
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  await setReaction(ben, conversation, undefined, "sad");
  assert.equal(
    (await thread(ben, conversation)).conversation.reactions[0].kind,
    "sad",
  );
});

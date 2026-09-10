import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const {
  changeRelationship,
  updateTitleActivity,
  thread,
  addComment,
  conversations,
  profileFor,
} = await import("../../src/server/social");

useDatabase();

test("pending and nonfriends cannot read or write a thread; accepted friends use the same thread", async () => {
  const { alice, ben, outsider, conversation } = await setup();
  await changeRelationship(ben, alice, "request");
  for (const viewer of [ben, outsider]) {
    await assert.rejects(thread(viewer, conversation), /not found/);
    await assert.rejects(
      addComment(viewer, conversation, "No access", false),
      /not found/,
    );
    assert.deepEqual(await conversations(viewer), []);
  }
  await assert.rejects(changeRelationship(ben, alice, "accept"), /not found/);
  await changeRelationship(alice, ben, "accept");
  const comment = await addComment(ben, conversation, "Looks great", true);
  assert.equal((await thread(alice, conversation)).comments[0].id, comment);
  assert.equal(
    (await conversations(ben, { title: "movie:1" }))[0].id,
    conversation,
  );
  assert.equal((await conversations(ben))[0].id, conversation);
  const same = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  assert.notEqual(same, conversation, "Each action needs its own discussion");
});

test("unfriending revokes historical access, hides comments for remaining readers, and refriending restores them", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await addComment(ben, conversation, "Historical reply", false);
  assert.equal((await thread(cam, conversation)).comments.length, 1);
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, conversation));
  await assert.rejects(addComment(ben, conversation, "Forbidden", false));
  assert.equal((await thread(alice, conversation)).comments.length, 0);
  assert.equal((await thread(cam, conversation)).comments.length, 0);
  await friend(alice, ben);
  assert.equal(
    (await thread(cam, conversation)).comments[0].body,
    "Historical reply",
  );
});

test("blocking hides the pair on mutual threads, prevents requests, and excludes hidden activity from ordering", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await addComment(ben, conversation, "Ben comment", false);
  await addComment(cam, conversation, "Cam comment", false);
  await db.query(
    "UPDATE comment SET created_at=now()+interval '1 hour' WHERE author_id=$1",
    [cam],
  );
  const visible = (await conversations(ben, { title: "movie:1" }))[0]
    .visible_activity;
  await changeRelationship(ben, cam, "block");
  assert.deepEqual(
    (await thread(ben, conversation)).comments.map((c) => c.body),
    ["Ben comment"],
  );
  assert.deepEqual(
    (await thread(cam, conversation)).comments.map((c) => c.body),
    ["Cam comment"],
  );
  assert.equal((await thread(alice, conversation)).comments.length, 2);
  assert.ok(
    new Date(
      (await conversations(ben, { title: "movie:1" }))[0].visible_activity,
    ) < new Date(visible),
  );
  await assert.rejects(changeRelationship(cam, ben, "request"));
  await assert.rejects(profileFor(ben, "cam"));
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await thread(ben, conversation)).comments.length, 2);
});

test("screen reads and legacy links preserve item identity and filter reply targets before navigation", async () => {
  const { alice, ben, cam, outsider, conversation: id } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await db.query(
    "INSERT INTO title_trailer(title_id,trailer,expires_at) VALUES('movie:1',NULL,now()+interval '1 day') ON CONFLICT(title_id) DO UPDATE SET expires_at=excluded.expires_at",
  );
  const replies: string[] = [];
  for (let index = 0; index < 5; index++)
    replies.push(await addComment(alice, id, `Eligible ${index}`, index === 0));
  const hidden = await addComment(cam, id, "Blocked reply", false, replies[0]);
  await changeRelationship(ben, cam, "block");
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const data = await loadScreen(ben, path);
    assert.ok("conversations" in data && data.conversations);
    assert.deepEqual(
      data.conversations.map((c) => c.id),
      [id],
    );
    assert.deepEqual(
      data.conversations[0].comments.map((c) => c.id),
      replies,
    );
    assert.deepEqual(
      data.conversations[0].comments.slice(-3).map((c) => c.body),
      ["Eligible 2", "Eligible 3", "Eligible 4"],
    );
  }
  const targeted = await loadScreen(
    ben,
    `/titles/movie/1?item=${id}&reply=${replies[0]}`,
  );
  assert.ok(targeted.kind === "title");
  assert.deepEqual(targeted.target, { item: id, reply: replies[0] });
  assert.equal(targeted.conversations[0].comments[0].spoiler, true);
  const blocked = await loadScreen(
    ben,
    `/titles/movie/1?item=${id}&reply=${hidden}`,
  );
  assert.ok(blocked.kind === "title");
  assert.equal(blocked.targetUnavailable, true);
  assert.equal(blocked.target?.reply, undefined);
  const outside = await loadScreen(
    outsider,
    `/titles/movie/1?item=${id}&reply=${replies[0]}`,
  );
  assert.ok(outside.kind === "title");
  assert.equal(outside.target, null);
  assert.equal(outside.targetUnavailable, true);
  assert.deepEqual(outside.conversations, []);
  const legacy = (
    await db.query("SELECT conversation_id FROM feed_item WHERE id=$1", [id])
  ).rows[0].conversation_id;
  assert.deepEqual(await loadScreen(ben, `/conversations/${legacy}`), {
    kind: "redirect",
    url: `/titles/movie/1?item=${id}`,
  });
  const oldReply = (
    await db.query(
      "INSERT INTO comment(conversation_id,author_id,body,spoiler) VALUES($1,$2,'An earlier discussion',true) RETURNING id::text",
      [legacy, alice],
    )
  ).rows[0].id;
  assert.deepEqual(
    await loadScreen(ben, `/conversations/${legacy}?reply=${oldReply}`),
    {
      kind: "redirect",
      url: `/titles/movie/1?item=${legacy}&reply=${oldReply}`,
    },
  );
  await assert.rejects(
    loadScreen(outsider, `/conversations/${legacy}`),
    /not found/,
  );
  await changeRelationship(alice, ben, "remove");
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const data = await loadScreen(ben, path);
    assert.ok("conversations" in data);
    assert.deepEqual(data.conversations, []);
  }
  await friend(alice, ben);
  assert.equal((await conversations(ben)).length, 2);
});

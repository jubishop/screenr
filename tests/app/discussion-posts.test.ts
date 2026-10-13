import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  cookieFor,
  denied,
  friend,
  setup,
} from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { thread, conversations } = await import("../../src/server/feed");
const { addComment, createDiscussionPost, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");
const { notifications, readNotification } =
  await import("../../src/server/notifications");
const { usageReport } = await import("../../src/server/usage");
const { POST } = await import("../../src/app/api/screenr/[action]/route");

useDatabase();

test("posts without a title reach the author and current friends on the friends feed and profile, never a title page", async () => {
  const {
    alice,
    ben,
    cam,
    outsider,
    conversation: recommendation,
  } = await setup();
  await friend(alice, ben);
  const post = await createDiscussionPost(
    alice,
    "  Any good comedies for tonight?  ",
    false,
  );
  for (const path of ["/", "/people/alice"]) {
    const screen = await loadScreen(ben, path);
    assert.ok("conversations" in screen && screen.conversations);
    const item = screen.conversations.find((c) => c.id === post)!;
    assert.equal(item.item_type, "post");
    assert.equal(item.body, "Any good comedies for tonight?");
    assert.equal(item.active, true);
    assert.equal(item.spoiler, false);
    assert.equal(item.title_id, null);
    assert.equal(item.title_name, null);
    assert.equal(item.kind, null);
    assert.equal(item.season, null);
    assert.equal(item.episode, null);
    assert.equal(item.recommended, false);
    assert.equal(item.viewer_want_to_watch, false);
    assert.equal(item.viewer_status, null);
    assert.ok(screen.conversations.some((c) => c.id === recommendation));
  }
  const title = await loadScreen(ben, "/titles/movie/1");
  assert.ok(title.kind === "title");
  assert.deepEqual(
    title.conversations.map((c) => c.id),
    [recommendation],
  );
  assert.deepEqual(await conversations(ben, { owner: ben }), []);
  // A pending request or no relationship grants no access.
  await changeRelationship(cam, alice, "request");
  for (const viewer of [cam, outsider]) {
    assert.ok(!(await conversations(viewer)).some((c) => c.id === post));
    await assert.rejects(thread(viewer, post), denied.conversation);
    await assert.rejects(
      addComment(viewer, post, "No access", false),
      denied.conversation,
    );
    await assert.rejects(
      setReaction(viewer, post, null, "like"),
      denied.conversation,
    );
  }
  for (const body of ["", " ", null, 8, "x".repeat(2001)])
    await assert.rejects(createDiscussionPost(alice, body, false), /Post must/);
  await assert.rejects(
    createDiscussionPost(alice, "Valid", "false"),
    /spoiler/,
  );
  // The action saves posts through the API route with a member session.
  const response = await POST(
    new Request("http://localhost:3000/api/screenr/discussion-post", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Cookie: await cookieFor(alice),
      },
      body: JSON.stringify({ body: "From the route", spoiler: true }),
    }),
    { params: Promise.resolve({ action: "discussion-post" }) },
  );
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const routed = (await thread(ben, id)).conversation;
  assert.equal(routed.body, "From the route");
  assert.equal(routed.spoiler, true);
  assert.equal(routed.item_type, "post");
});

test("post replies, reactions, ordering, removal, and access changes follow the shared entry rules", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, outsider);
  const post = await createDiscussionPost(alice, "Weekend picks?", true);
  const later = await createTitleComment(alice, "movie:1", "Later", false);
  assert.equal((await conversations(ben))[0].id, later);
  const parent = await addComment(ben, post, "Try a classic", false);
  const child = await addComment(cam, post, "Seconded", true, parent);
  assert.deepEqual(
    (await thread(alice, post)).comments.map((c) => [
      c.id,
      c.root_id,
      c.addressed_username,
      c.spoiler,
    ]),
    [
      [parent, null, null, false],
      [child, parent, "ben", true],
    ],
  );
  // A visible reply moves the post up in every feed that shows it.
  for (const filter of [{}, { owner: alice }])
    assert.equal((await conversations(ben, filter))[0].id, post);
  // Friends of a replier are not in the post's audience.
  await assert.rejects(thread(outsider, post), denied.conversation);
  await assert.rejects(
    addComment(outsider, post, "Through Ben", false, parent),
    denied.conversation,
  );
  await setReaction(ben, post, null, "haha");
  await setReaction(cam, post, null, "haha");
  await setReaction(alice, post, parent, "like");
  const reacted = await thread(ben, post);
  assert.deepEqual(reacted.conversation.reactions, [
    { kind: "haha", count: 2, reacted: true },
  ]);
  assert.deepEqual(reacted.comments[0].reactions, [
    { kind: "like", count: 1, reacted: false },
  ]);
  await assert.rejects(
    setReaction(ben, post, "999999", "like"),
    denied.replyTarget,
  );
  // Blocking hides a commenter and their reactions from the blocker.
  await changeRelationship(ben, cam, "block");
  const blocked = await thread(ben, post);
  assert.deepEqual(
    blocked.comments.map((c) => c.id),
    [parent],
  );
  assert.deepEqual(blocked.conversation.reactions, [
    { kind: "haha", count: 1, reacted: true },
  ]);
  await assert.rejects(
    addComment(ben, post, "Hidden target", false, child),
    denied.replyTarget,
  );
  await changeRelationship(ben, cam, "unblock");

  // Only the author removes the post; the host removes others' replies.
  for (const viewer of [ben, cam, outsider])
    await assert.rejects(removeComment(viewer, post), denied.comment);
  await assert.rejects(removeComment(ben, child), denied.comment);
  await removeComment(alice, child);
  assert.equal((await thread(ben, post)).comments.length, 1);
  await removeComment(alice, post);
  await removeComment(alice, post);
  const removed = await thread(ben, post);
  assert.equal(removed.conversation.active, false);
  assert.equal(removed.conversation.body, "");
  assert.equal(removed.conversation.spoiler, true);
  assert.deepEqual(removed.conversation.reactions, []);
  assert.deepEqual(
    removed.comments.map((c) => c.body),
    ["Try a classic"],
  );
  assert.equal(
    (
      await db.query("SELECT body FROM discussion_post WHERE id::text=$1", [
        post,
      ])
    ).rows[0].body,
    "[removed]",
  );
  await assert.rejects(
    setReaction(ben, post, null, "love"),
    denied.conversation,
  );
  const continued = await addComment(cam, post, "Still talking", false);
  assert.ok(
    (await thread(alice, post)).comments.some((c) => c.id === continued),
  );

  // Unfriending revokes access; a new friendship restores it.
  await changeRelationship(alice, ben, "remove");
  await assert.rejects(thread(ben, post), denied.conversation);
  await assert.rejects(
    addComment(ben, post, "Revoked", false),
    denied.conversation,
  );
  assert.ok(!(await conversations(ben)).some((c) => c.id === post));
  await friend(alice, ben);
  assert.equal((await thread(ben, post)).comments[0].id, parent);
  await changeRelationship(ben, alice, "block");
  await assert.rejects(thread(ben, post), denied.conversation);
  assert.ok(!(await conversations(ben)).some((c) => c.id === post));

  // A removed post with no visible reply disappears and stays closed.
  const empty = await createDiscussionPost(alice, "No replies", false);
  await removeComment(alice, empty);
  for (const viewer of [alice, cam])
    await assert.rejects(thread(viewer, empty), denied.conversation);
  await assert.rejects(
    addComment(cam, empty, "Cannot revive", false),
    denied.conversation,
  );
});

test("post notifications and permalinks open the friends feed at the post", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const post = await createDiscussionPost(alice, "Secret finale?", true);
  const reply = await addComment(ben, post, "The secret finale", true);
  const nested = await addComment(cam, post, "Agreed", false, reply);
  const [owner] = (await notifications(alice)).items;
  assert.equal(owner.message, "cam commented on your post.");
  assert.equal(owner.href, `/?item=${post}&reply=${nested}`);
  const ownerPage = await notifications(alice);
  assert.equal(ownerPage.items[1].href, `/?item=${post}&reply=${reply}`);
  assert.ok(!JSON.stringify(ownerPage).toLowerCase().includes("secret"));
  const [addressed] = (await notifications(ben)).items;
  assert.equal(addressed.message, "cam replied to your comment.");
  assert.equal(addressed.href, `/?item=${post}&reply=${nested}`);
  assert.equal(
    (await readNotification(ben, addressed.id)).href,
    addressed.href,
  );

  const linked = await loadScreen(ben, `/?item=${post}&reply=${nested}`);
  assert.ok(linked.kind === "feed");
  assert.deepEqual(linked.target, { item: post, reply: nested });
  assert.equal(linked.targetUnavailable, false);
  assert.ok(linked.conversations.some((c) => c.id === post));
  const missingReply = await loadScreen(ben, `/?item=${post}&reply=999999`);
  assert.ok(missingReply.kind === "feed");
  assert.deepEqual(missingReply.target, { item: post, reply: undefined });
  assert.equal(missingReply.targetUnavailable, true);
  const plain = await loadScreen(ben, "/");
  assert.ok(plain.kind === "feed");
  assert.equal(plain.target, null);
  assert.equal(plain.targetUnavailable, false);
  const hidden = await loadScreen(outsider, `/?item=${post}`);
  assert.ok(hidden.kind === "feed");
  assert.equal(hidden.target, null);
  assert.equal(hidden.targetUnavailable, true);
  // Old conversation links that name a post open the friends feed.
  assert.deepEqual(
    await loadScreen(ben, `/conversations/${post}?reply=${nested}`),
    { kind: "redirect", url: `/?item=${post}&reply=${nested}` },
  );

  // Notifications follow current access to the post.
  const comments = async (viewer: string) =>
    (await notifications(viewer)).items
      .filter((n) => n.kind !== "friend_accepted")
      .map((n) => n.href);
  await changeRelationship(alice, cam, "remove");
  assert.deepEqual(await comments(alice), [`/?item=${post}&reply=${reply}`]);
  assert.deepEqual(await comments(ben), []);
  await friend(alice, cam);
  await changeRelationship(alice, ben, "block");
  assert.deepEqual(await comments(alice), [`/?item=${post}&reply=${nested}`]);
});

test("the usage report counts conversations on posts without a title", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const post = await createDiscussionPost(alice, "Any suggestions?", false);
  await addComment(ben, post, "One idea", false);
  await addComment(alice, post, "Thanks", false);
  const [week] = await usageReport({ weeks: 1 });
  assert.equal(week.conversations, 1);
  assert.equal(week.backAndForth, 1);
});

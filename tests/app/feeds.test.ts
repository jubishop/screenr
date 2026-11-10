import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, denied, friend, setup } from "./social-fixture";
import type { Comment, FeedItem } from "../../src/shared";
const { changeRelationship } = await import("../../src/server/relationships");
const { thread, conversations, feedPage } =
  await import("../../src/server/feed");
const { updateTitleActivity, updateWatchStatus, setFinishedDate } =
  await import("../../src/server/title-actions");
const { saveReview, removeReview } = await import("../../src/server/reviews");
const { addComment, removeComment, createTitleComment, createDiscussionPost } =
  await import("../../src/server/comments");

useDatabase();

// An entry's status menu and review editor start from the reader's own
// last-finished date and review for its title (issue #572).
test("feed entries carry the reader's own last-finished date and review for their title", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  // The discussion keeps the Recommend holding Alice's card once her status
  // and review join it.
  await addComment(ben, conversation, "Worth it?", false);
  const post = await createDiscussionPost(alice, "A post", false);
  // Every read of an entry, by `viewer`: the friends feed, title and profile
  // feeds, a page of history, and the entry itself.
  const reads = async (viewer: string, id: string) => {
    const { conversation: entry } = await thread(viewer, id);
    return [
      ...(await conversations(viewer)),
      ...(await conversations(viewer, { title: "movie:1" })),
      ...(await conversations(viewer, { owner: alice })),
      ...(await feedPage(viewer, { before: Infinity })).conversations,
      entry,
    ].filter((item) => item.id === id);
  };
  const expectViewer = async (
    viewer: string,
    finishedOn: string | null,
    review: FeedItem["viewer_review"],
  ) => {
    const entries = await reads(viewer, conversation);
    assert.equal(entries.length, 5);
    for (const entry of entries) {
      assert.equal(entry.viewer_finished_on, finishedOn);
      assert.deepEqual(entry.viewer_review, review);
    }
  };
  await expectViewer(ben, null, null);
  // A post without a title has neither.
  for (const item of await reads(ben, post)) {
    assert.equal(item.viewer_finished_on, null);
    assert.equal(item.viewer_review, null);
  }

  // The date stays through later statuses and a cleared status, as the title
  // page's menu shows it, until the reader clears it.
  await updateWatchStatus(ben, "movie:1", "finished", "2026-10-01");
  await expectViewer(ben, "2026-10-01", null);
  await updateWatchStatus(ben, "movie:1", "watching");
  await updateWatchStatus(ben, "movie:1", null);
  await expectViewer(ben, "2026-10-01", null);
  await setFinishedDate(ben, "movie:1", null);
  await expectViewer(ben, null, null);

  // A rating alone has no text; a removed review is none.
  await saveReview(ben, "movie:1", 4, null, false);
  await expectViewer(ben, null, { rating: 4, body: null, spoiler: false });
  await saveReview(ben, "movie:1", null, "Moving.", true);
  await expectViewer(ben, null, {
    rating: null,
    body: "Moving.",
    spoiler: true,
  });
  // Each reader sees only their own, on their own entry too.
  await updateWatchStatus(alice, "movie:1", "finished", "2026-09-30");
  await saveReview(alice, "movie:1", 2, "Not for me.", false);
  await expectViewer(alice, "2026-09-30", {
    rating: 2,
    body: "Not for me.",
    spoiler: false,
  });
  await removeReview(ben, "movie:1");
  await expectViewer(ben, null, null);
});

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
  await assert.rejects(thread(cam, recommendation), denied.conversation);
  await assert.rejects(
    addComment(cam, recommendation, "Invisible item", false),
    denied.conversation,
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
    denied.conversation,
  );
  await assert.rejects(
    addComment(ben, second, "Wrong item", false, reply),
    denied.replyTarget,
  );
  await changeRelationship(ben, cam, "block");
  await assert.rejects(
    addComment(ben, first, "Blocked target", false, reply),
    denied.replyTarget,
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

// Every field that src/shared.ts declares for a feed entry and a reply. The
// type checker keeps these lists complete, and the test below compares them
// with what the feed queries send.
const field = true;
const entryFields = Object.keys({
  id: field,
  owner_id: field,
  title_id: field,
  item_type: field,
  body: field,
  spoiler: field,
  active: field,
  recommended: field,
  want_to_watch: field,
  status: field,
  finished_on: field,
  rating: field,
  edited: field,
  season: field,
  episode: field,
  viewer_want_to_watch: field,
  viewer_recommended: field,
  viewer_status: field,
  viewer_top_ten_rank: field,
  viewer_finished_on: field,
  viewer_review: field,
  username: field,
  display_name: field,
  photo: field,
  title_name: field,
  poster_path: field,
  kind: field,
  release_date: field,
  activity_at: field,
  visible_activity: field,
  reactions: field,
  combined: field,
  comments: field,
} satisfies Record<keyof FeedItem, true>).sort();
const commentFields = Object.keys({
  id: field,
  author_id: field,
  username: field,
  display_name: field,
  photo: field,
  body: field,
  spoiler: field,
  root_id: field,
  addressed_username: field,
  removed: field,
  unavailable: field,
  created_at: field,
  reactions: field,
} satisfies Record<keyof Comment, true>).sort();

test("feed reads send only the declared entry and reply fields", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "A reply", false);
  await createDiscussionPost(alice, "A post", false);
  const paged = await feedPage(ben, { before: Infinity });
  const { conversation: entry, comments } = await thread(ben, conversation);
  const entries = [
    ...(await conversations(ben)),
    ...paged.conversations,
    { ...entry, comments },
  ];
  assert.equal(entries.length, 5);
  for (const item of entries) {
    assert.deepEqual(Object.keys(item).sort(), entryFields);
    for (const comment of item.comments)
      assert.deepEqual(Object.keys(comment).sort(), commentFields);
  }
});

test("feed entries carry their title's release date for the year beside its kind", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name,release_date) VALUES('tv:2022','tv',2022,'Dated Show','2022-03-04')
    ON CONFLICT(id) DO UPDATE SET release_date=excluded.release_date`,
  );
  const dated = await updateTitleActivity(
    alice,
    "tv:2022",
    "want_to_watch",
    true,
  );
  const comment = await createTitleComment(
    alice,
    "tv:2022",
    "Standalone",
    false,
  );
  const releases = async (filter = {}) =>
    Object.fromEntries(
      (await conversations(ben, filter)).map((c) => [c.id, c.release_date]),
    );
  const all = {
    [conversation]: "",
    [dated]: "2022-03-04",
    [comment]: "2022-03-04",
  };
  assert.deepEqual(await releases(), all);
  assert.deepEqual(await releases({ owner: alice }), all);
  assert.deepEqual(await releases({ title: "tv:2022" }), {
    [dated]: "2022-03-04",
    [comment]: "2022-03-04",
  });
  assert.equal(
    (await thread(ben, dated)).conversation.release_date,
    "2022-03-04",
  );
  assert.equal((await thread(ben, conversation)).conversation.release_date, "");
});

test("clearing activity hides empty items while preserving eligible discussions", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  for (const filter of [{}, { title: "movie:1" }, { owner: alice }])
    assert.deepEqual(await conversations(ben, filter), []);
  await assert.rejects(thread(alice, conversation), denied.conversation);
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

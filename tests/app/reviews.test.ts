import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  useDatabase,
  db,
  cookieFor,
  friend,
  setup,
  denied,
} from "./social-fixture";
const { changeRelationship } = await import("../../src/server/relationships");
const { thread, conversations } = await import("../../src/server/feed");
const { saveReview, removeReview } = await import("../../src/server/reviews");
const { addComment, removeComment } = await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");
const { POST } = await import("../../src/app/api/screenr/[action]/route");

useDatabase();

const time = (value: string) => new Date(value).getTime();
// Saves a review and returns its entry ID.
async function review(...args: Parameters<typeof saveReview>) {
  const id = await saveReview(...args);
  assert.ok(id);
  return id;
}
const reviewOf = async (viewer: string, id: string) =>
  (await thread(viewer, id)).conversation;

test("members add a rating, text, or both, and the action route validates them", async () => {
  const { alice } = await setup();
  const cookie = await cookieFor(alice);
  const post = (action: string, data: unknown) =>
    POST(
      new Request(`http://localhost:3000/api/screenr/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify(data),
      }),
      { params: Promise.resolve({ action }) },
    );
  const rejects = async (data: unknown, error: string) => {
    const response = await post("review", data);
    assert.equal(response.status, 400, JSON.stringify(data));
    assert.deepEqual(await response.json(), { error });
  };
  for (const rating of [0, 6, 2.5, "4", true])
    await rejects(
      { title: "movie:1", rating, body: "", spoiler: false },
      "Choose a rating from 1 to 5 stars.",
    );
  await rejects(
    { title: "movie:1", rating: null, body: "   ", spoiler: false },
    "Add a star rating or review text.",
  );
  await rejects(
    { title: "movie:1", rating: 3, body: "x".repeat(2001), spoiler: false },
    "Review must contain 1–2000 characters.",
  );
  await rejects(
    { title: "movie:1", rating: 3, body: 5, spoiler: false },
    "Invalid review text.",
  );
  await rejects(
    { title: "movie:1", rating: 3, body: "", spoiler: "yes" },
    "Invalid spoiler flag.",
  );
  assert.deepEqual(
    (await conversations(alice, { owner: alice })).map((c) => c.item_type),
    ["recommended"],
  );

  // A rating alone, text alone, or both make one review entry.
  const saved = await post("review", {
    title: "movie:1",
    rating: 4,
    body: "",
    spoiler: false,
  });
  assert.equal(saved.status, 200);
  const { id } = await saved.json();
  let entry = await reviewOf(alice, id);
  assert.equal(entry.item_type, "review");
  assert.equal(entry.rating, 4);
  assert.equal(entry.body, null);
  assert.equal(entry.spoiler, false);
  assert.equal(entry.active, true);
  assert.equal(entry.edited, false);
  assert.equal(
    await saveReview(alice, "movie:1", null, "  Loved it.  ", true),
    id,
  );
  entry = await reviewOf(alice, id);
  assert.equal(entry.rating, null);
  assert.equal(entry.body, "Loved it.");
  assert.equal(entry.spoiler, true);
  assert.equal(
    await saveReview(alice, "movie:1", 5, "Even better again.", false),
    id,
  );
  entry = await reviewOf(alice, id);
  assert.deepEqual(
    [entry.rating, entry.body, entry.spoiler],
    [5, "Even better again.", false],
  );
  assert.equal(
    (await conversations(alice, { owner: alice })).filter(
      (c) => c.item_type === "review",
    ).length,
    1,
  );

  // Removing erases the rating and text; removing again finds nothing.
  assert.equal((await post("remove-review", { title: "movie:1" })).status, 200);
  assert.ok(
    !(await conversations(alice, { owner: alice })).some((c) => c.id === id),
  );
  const removed = await post("remove-review", { title: "movie:1" });
  assert.equal(removed.status, 404);
  assert.deepEqual(await removed.json(), { error: "Review not found." });
  assert.deepEqual(
    (await db.query("SELECT rating,body,active FROM review WHERE id=$1", [id]))
      .rows,
    [{ rating: null, body: null, active: false }],
  );
});

test("one review per title updates in place with an Edited label, keeps its discussion, and follows the removal rule", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const id = await review(alice, "movie:1", 3, "Pretty good.", false);
  const reply = await addComment(ben, id, "Agreed!", false);
  await setReaction(ben, id, null, "love");
  const discussion = await thread(ben, id);
  assert.equal(discussion.conversation.edited, false);

  // Saving the same review changes nothing and does not move it up.
  assert.equal(
    await saveReview(alice, "movie:1", 3, "Pretty good.", false),
    id,
  );
  assert.deepEqual(await thread(ben, id), discussion);

  // Each edit updates the same entry, marks it Edited, and moves it up.
  let previous = discussion.conversation.activity_at;
  for (const [rating, body, spoiler] of [
    [4, "Pretty good.", false],
    [4, "Better on a second watch.", false],
    [4, "Better on a second watch.", true],
    [null, "Better on a second watch.", true],
  ] as const) {
    assert.equal(await saveReview(alice, "movie:1", rating, body, spoiler), id);
    const after = await thread(ben, id);
    assert.deepEqual(
      [
        after.conversation.rating,
        after.conversation.body,
        after.conversation.spoiler,
      ],
      [rating, body, spoiler],
    );
    assert.equal(after.conversation.edited, true);
    assert.ok(time(after.conversation.activity_at) > time(previous));
    assert.deepEqual(after.comments, discussion.comments);
    assert.deepEqual(
      after.conversation.reactions,
      discussion.conversation.reactions,
    );
    previous = after.conversation.activity_at;
  }

  // Removal keeps an entry with visible replies, erased and inactive, without
  // moving it. Its reactions are hidden and closed, but replies stay open.
  await removeReview(alice, "movie:1");
  const removed = await thread(ben, id);
  assert.equal(removed.conversation.active, false);
  assert.equal(removed.conversation.rating, null);
  assert.equal(removed.conversation.body, null);
  assert.equal(removed.conversation.edited, false);
  assert.equal(removed.conversation.spoiler, true);
  assert.deepEqual(removed.conversation.activity_at, previous);
  assert.deepEqual(removed.comments, discussion.comments);
  assert.deepEqual(removed.conversation.reactions, []);
  await assert.rejects(setReaction(ben, id, null, "wow"), denied.conversation);
  await setReaction(ben, id, reply, "like");
  const later = await addComment(alice, id, "I changed my mind.", false);
  await removeComment(alice, later);
  // Without visible replies it is hidden, but kept for reuse.
  await removeComment(ben, reply);
  await assert.rejects(thread(ben, id), denied.conversation);
  for (const viewer of [alice, ben])
    assert.ok(!(await conversations(viewer)).some((item) => item.id === id));
  await assert.rejects(
    addComment(ben, id, "Hello?", false),
    denied.conversation,
  );

  // Reviewing again reuses the entry, restores its reactions, and moves it up.
  assert.equal(await saveReview(alice, "movie:1", 2, null, false), id);
  const restored = await thread(ben, id);
  assert.equal(restored.conversation.active, true);
  assert.equal(restored.conversation.rating, 2);
  assert.equal(restored.conversation.edited, true);
  assert.ok(time(restored.conversation.activity_at) > time(previous));
  assert.deepEqual(
    restored.conversation.reactions,
    discussion.conversation.reactions,
  );
  // Reviews are separate from Recommend and other entries.
  assert.deepEqual(
    (await conversations(alice, { owner: alice }))
      .map((c) => c.item_type)
      .sort(),
    ["recommended", "review"],
  );
});

test("reviews follow the audience and blocking rules in every feed; comments notify the author, reviews notify no one", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, cam);
  await db.query("UPDATE profile SET activity_email=true");
  const notifications = async () =>
    (await db.query("SELECT count(*)::int AS count FROM notification")).rows[0]
      .count as number;
  const before = await notifications();
  const id = await review(alice, "movie:1", 5, "A favorite.", false);
  await saveReview(alice, "movie:1", 4, "A favorite, mostly.", false);
  assert.equal(await notifications(), before);
  const filters = [{}, { title: "movie:1" }, { owner: alice }];
  const sees = async (viewer: string) => {
    const found = await Promise.all(
      filters.map(async (filter) =>
        (await conversations(viewer, filter)).some((item) => item.id === id),
      ),
    );
    assert.ok(found.every((value) => value === found[0]));
    return found[0];
  };
  for (const viewer of [alice, ben, cam])
    assert.equal(await sees(viewer), true);
  assert.equal(await sees(outsider), false);
  await assert.rejects(thread(outsider, id), denied.conversation);
  await assert.rejects(
    addComment(outsider, id, "Not my circle", false),
    denied.conversation,
  );
  await assert.rejects(
    setReaction(outsider, id, null, "like"),
    denied.conversation,
  );

  // A comment on the review notifies its author, linking to the review; a
  // reply also notifies the addressed commenter.
  const comment = await addComment(ben, id, "Which scene?", false);
  await addComment(cam, id, "The ending.", false, comment);
  const alerts = async (recipient: string) =>
    (
      await db.query(
        "SELECT kind,item_id::text FROM visible_notification WHERE recipient_id=$1 AND comment_id IS NOT NULL ORDER BY id",
        [recipient],
      )
    ).rows;
  assert.deepEqual(await alerts(alice), [
    { kind: "comment", item_id: id },
    { kind: "comment", item_id: id },
  ]);
  assert.deepEqual(await alerts(ben), [{ kind: "reply", item_id: id }]);

  // Blocking hides each person's review from the other, but not from a
  // mutual friend.
  const camReview = await review(cam, "movie:1", 1, null, false);
  await changeRelationship(cam, alice, "block");
  assert.equal(await sees(cam), false);
  await assert.rejects(thread(alice, camReview), denied.conversation);
  assert.ok(
    (await conversations(ben, { title: "movie:1" })).some(
      (item) => item.id === camReview,
    ),
  );
  await changeRelationship(ben, alice, "remove");
  assert.equal(await sees(ben), false);
  await friend(alice, ben);
  assert.equal(await sees(ben), true);
});

test("a review's discussion counts toward the conversation measure", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const { usageReport } = await import("../../src/server/usage");
  const id = await review(alice, "movie:1", 4, null, false);
  const [before] = await usageReport({ weeks: 1 });
  await addComment(ben, id, `Thoughts ${randomUUID()}`, false);
  const [after] = await usageReport({ weeks: 1 });
  assert.equal(after.conversations, before.conversations + 1);
});

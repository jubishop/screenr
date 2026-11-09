import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, denied, friend, setup } from "./social-fixture";
import type { FeedItem } from "../../src/shared";
const { loadScreen } = await import("../../src/server/screens");
const { conversations, conversationURL, thread } =
  await import("../../src/server/feed");
const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");
const { saveReview } = await import("../../src/server/reviews");
const { addComment, createDiscussionPost, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");

// One person's active status, review, and Recommend or Want to watch for a
// title show as one card when their actions fall within 24 hours
// (docs/title-feed.md#combine-one-persons-close-together-title-actions--2026-11-08).
useDatabase();

const tables = {
  progress: "watch_progress",
  review: "review",
  action: "feed_item",
} as const;
// Moves an entry's action back by `interval`, as though it happened then.
// Its creation moves too, so a review stays unedited.
async function back(table: keyof typeof tables, id: string, interval: string) {
  await db.query(
    `UPDATE ${tables[table]} SET activity_at=activity_at-$2::interval,
      created_at=created_at-$2::interval WHERE id=$1`,
    [id, interval],
  );
}
// Sets an entry's action to `interval` before the action of `anchor`, an
// entry in `table`, to the microsecond.
async function before(
  table: keyof typeof tables,
  id: string,
  interval: string,
  anchor: readonly [keyof typeof tables, string],
) {
  await db.query(
    `UPDATE ${tables[table]} SET activity_at=a.at-$2::interval,created_at=a.at-$2::interval
    FROM (SELECT activity_at AS at FROM ${tables[anchor[0]]} WHERE id=$3) a WHERE id=$1`,
    [id, interval, anchor[1]],
  );
}
const activity = async (table: keyof typeof tables, id: string) =>
  (await db.query(`SELECT activity_at FROM ${tables[table]} WHERE id=$1`, [id]))
    .rows[0].activity_at as Date;

type Screen = {
  conversations: FeedItem[];
  target?: { item: string; reply?: string } | null;
  targetUnavailable?: boolean;
};
async function read(viewer: string, path: string) {
  const screen = (await loadScreen(viewer, path)) as unknown as Screen;
  return JSON.parse(JSON.stringify(screen)) as Screen;
}
// Each entry by ID with the entries combined into it, in the order sent.
const cards = (entries: FeedItem[]) =>
  entries.map((entry) => [
    entry.id,
    ...entry.combined.map((member) => member.id),
  ]);

test("close-together entries show as one card in the title, friends, and profile feeds", async () => {
  const { alice, ben, conversation: recommend } = await setup();
  await friend(alice, ben);
  const progress = await updateWatchStatus(alice, "movie:1", "finished");
  const review = await saveReview(alice, "movie:1", 4, "Loved it.", false);
  assert.ok(progress);
  for (const path of [
    "/titles/movie/1",
    "/?before=now",
    "/people/alice?before=now",
  ]) {
    const screen = await read(ben, path);
    // Without discussion, the review holds the card. The others follow in
    // the author line's order: status, then Recommend or Want to watch.
    assert.deepEqual(cards(screen.conversations), [
      [review, progress, recommend],
    ]);
  }
  const [card] = (await read(ben, "/titles/movie/1")).conversations;
  assert.equal(card.item_type, "review");
  assert.equal(card.rating, 4);
  assert.equal(card.body, "Loved it.");
  const newest = (await activity("review", review)).toISOString();
  assert.equal(card.activity_at, newest);
  assert.equal(card.visible_activity, newest);
  assert.deepEqual(card.combined, [
    {
      id: progress,
      item_type: "progress",
      status: "finished",
      rating: null,
      body: null,
      spoiler: false,
      edited: false,
    },
    {
      id: recommend,
      item_type: "recommended",
      status: null,
      rating: null,
      body: null,
      spoiler: false,
      edited: false,
    },
  ]);
  // A single entry combines nothing.
  await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  const own = (await conversations(ben, { owner: ben }))[0];
  assert.deepEqual(own.combined, []);
});

test("an entry joins the card of the person's newest entry only within 24 hours before it", async () => {
  const { alice, ben, conversation: recommend } = await setup();
  await friend(alice, ben);
  const review = await saveReview(alice, "movie:1", 3, null, false);
  const newest = ["review", review] as const;
  const shown = async () => cards(await conversations(ben, { owner: alice }));

  await before("action", recommend, "23 hours 59 minutes 59 seconds", newest);
  assert.deepEqual(await shown(), [[review, recommend]]);
  await before("action", recommend, "24 hours", newest);
  assert.deepEqual(await shown(), [[review, recommend]]);
  await before("action", recommend, "24 hours 1 second", newest);
  assert.deepEqual(await shown(), [[review], [recommend]]);

  // The newest entry anchors the card: an entry within 24 hours of a joined
  // entry, but not of the newest, stays out of it.
  const progress = await updateWatchStatus(alice, "movie:1", "watching");
  assert.ok(progress);
  const latest = ["progress", progress] as const;
  await before("review", review, "20 hours", latest);
  await before("action", recommend, "30 hours", latest);
  assert.deepEqual(await shown(), [[review, progress], [recommend]]);

  // Entries the newest card leaves out combine with each other.
  await before("review", review, "25 hours", latest);
  await before("action", recommend, "30 hours", latest);
  assert.deepEqual(await shown(), [[progress], [review, recommend]]);
});

test("one entry holds the card's discussion, and two discussions stay separate", async () => {
  const { alice, ben, cam, conversation: recommend } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const shown = async () => cards(await conversations(ben, { owner: alice }));

  // Without discussion, the status holds the card over Recommend, and a
  // review over both.
  const progress = await updateWatchStatus(alice, "movie:1", "watching");
  assert.ok(progress);
  assert.deepEqual(await shown(), [[progress, recommend]]);
  const review = await saveReview(alice, "movie:1", 5, null, false);
  assert.deepEqual(await shown(), [[review, progress, recommend]]);

  // A reply or reaction written to another entry in the card goes to the
  // holder, so the card keeps one discussion.
  const reply = await addComment(ben, progress, "How far in?", false);
  await setReaction(cam, recommend, null, "love");
  let [card] = await conversations(ben, { owner: alice });
  assert.equal(card.id, review);
  assert.deepEqual(
    card.comments.map((comment) => comment.id),
    [reply],
  );
  assert.deepEqual(card.reactions, [
    { kind: "love", count: 1, reacted: false },
  ]);
  for (const id of [progress, recommend])
    assert.equal(
      (
        await db.query(
          `SELECT (SELECT count(*) FROM comment WHERE watch_progress_id=$1 OR feed_item_id=$1)
            + (SELECT count(*) FROM reaction WHERE watch_progress_id=$1 OR feed_item_id=$1) AS n`,
          [id],
        )
      ).rows[0].n.toString(),
      "0",
    );
  // Replies to a reply in the card name it through any of its entries.
  await addComment(cam, recommend, "Same here.", false, reply);

  // An entry that already has discussion holds the card instead of the
  // review, and a removed reply still counts as discussion.
  await db.query("DELETE FROM reaction");
  await db.query("DELETE FROM comment");
  const earlier = await addComment(ben, review, "Removed later.", false);
  await db.query("UPDATE comment SET review_id=NULL,watch_progress_id=$1", [
    progress,
  ]);
  await removeComment(ben, earlier);
  assert.deepEqual(await shown(), [[progress, review, recommend]]);
  // Reactions alone count as discussion too.
  await db.query("DELETE FROM comment");
  await setReaction(cam, review, null, "like");
  await db.query("UPDATE reaction SET review_id=NULL,feed_item_id=$1", [
    recommend,
  ]);
  assert.deepEqual(await shown(), [[recommend, progress, review]]);
  // When two entries already have discussion, they show separately. The
  // entry without discussion joins the newest one's card.
  await db.query(
    "INSERT INTO reaction(review_id,user_id,kind) VALUES($1,$2,'wow')",
    [review, ben],
  );
  assert.deepEqual(await shown(), [[review, progress], [recommend]]);
  [card] = await conversations(ben, { owner: alice });
  assert.equal(card.reactions[0].kind, "wow");
});

test("withdrawn entries, standalone comments, and other people's entries stay separate", async () => {
  const { alice, ben, conversation: recommend } = await setup();
  await friend(alice, ben);
  await addComment(ben, recommend, "Why?", false);
  // Switching to Want to watch withdraws Recommend, which stays for its
  // reply on its own.
  const want = await updateTitleActivity(
    alice,
    "movie:1",
    "want_to_watch",
    true,
  );
  const comment = await createTitleComment(alice, "movie:1", "Hmm.", false);
  const review = await saveReview(alice, "movie:1", 2, null, false);
  const benProgress = await updateWatchStatus(ben, "movie:1", "watching");
  // Entries can share a millisecond, so their order is left out.
  const ids = cards(await conversations(ben, { title: "movie:1" }));
  assert.deepEqual(
    ids.sort(),
    [[benProgress], [review, want], [comment], [recommend]].sort(),
  );
});

test("links to any entry in a card open the card, and its own fields come from its entries", async () => {
  const { alice, ben, outsider, conversation: recommend } = await setup();
  await friend(alice, ben);
  const progress = await updateWatchStatus(alice, "movie:1", "finished");
  assert.ok(progress);
  const review = await saveReview(alice, "movie:1", 4, "Twist!", true);
  const reply = await addComment(ben, review, "No way.", false);

  const title = await read(ben, `/titles/movie/1?item=${recommend}`);
  assert.deepEqual(title.target, { item: review });
  assert.equal(title.targetUnavailable, false);
  const replied = await read(
    ben,
    `/titles/movie/1?item=${progress}&reply=${reply}`,
  );
  assert.deepEqual(replied.target, { item: review, reply });
  // A thread or old conversation link to an entry in a card opens the card.
  assert.equal((await thread(ben, progress)).conversation.id, review);
  assert.equal(
    await conversationURL(ben, recommend, reply),
    `/titles/movie/1?item=${review}&reply=${reply}`,
  );

  // The friends feed sends a linked card even when it is older than the
  // page. The newer comments are a minute apart, since entries tied with a
  // page's last one join it.
  const notes: string[] = [];
  for (let n = 0; n < 55; n++)
    notes.push(await createTitleComment(alice, "movie:1", `Note ${n}`, false));
  await db.query(
    `UPDATE title_comment c SET created_at=now()-interval '1 hour'+t.n*interval '1 minute'
    FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n) WHERE c.id=t.id`,
    [notes],
  );
  for (const [table, id] of [
    ["progress", progress],
    ["review", review],
    ["action", recommend],
  ] as const)
    await back(table, id, "2 days");
  await db.query(
    "UPDATE comment SET created_at=created_at-interval '2 days' WHERE id::text=$1",
    [reply],
  );
  const page = await read(ben, `/?before=now&item=${progress}`);
  assert.equal(page.conversations.length, 51);
  assert.deepEqual(cards(page.conversations.slice(-1)), [
    [review, progress, recommend],
  ]);
  assert.deepEqual(page.target, { item: review });

  // A spoiler-flagged review covers the whole card, even when another entry
  // holds its discussion.
  await db.query("UPDATE comment SET review_id=NULL,watch_progress_id=$1", [
    progress,
  ]);
  const card = (await conversations(ben, { owner: alice })).find((entry) =>
    [progress, review].includes(entry.id),
  );
  assert.equal(card?.id, progress);
  assert.equal(card.spoiler, true);
  assert.deepEqual(
    card.combined.map((member) => [member.id, member.spoiler, member.body]),
    [
      [review, true, "Twist!"],
      [recommend, false, null],
    ],
  );
  // Entries outside the reader's access stay unavailable through any of them.
  for (const id of [progress, review, recommend]) {
    await assert.rejects(thread(outsider, id), denied.conversation);
    await assert.rejects(
      addComment(outsider, id, "Hi", false),
      denied.conversation,
    );
  }
});

test("paging places and counts each card once, by its latest activity across its entries", async () => {
  const { alice, ben, conversation: recommend } = await setup();
  await friend(alice, ben);
  const review = await saveReview(alice, "movie:1", 4, null, false);
  await back("review", review, "2 hours");
  await back("action", recommend, "2 hours");
  // With 49 newer posts, the card is the page's 50th entry and nothing older
  // remains: its two entries count once. The posts are a minute apart, since
  // entries tied with a page's last one join it.
  const posts: string[] = [];
  for (let n = 0; n < 49; n++)
    posts.push(await createDiscussionPost(ben, `Post ${n}`, false));
  await db.query(
    `UPDATE discussion_post p SET created_at=now()-interval '1 hour'+t.n*interval '1 minute'
    FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n) WHERE p.id=t.id`,
    [posts],
  );
  const first = (await loadScreen(ben, "/?before=now")) as unknown as {
    conversations: FeedItem[];
    older: boolean;
  };
  assert.equal(first.conversations.length, 50);
  assert.deepEqual(cards(first.conversations.slice(-1)), [[review, recommend]]);
  assert.equal(first.older, false);
  // One more post fills the page, a minute before the reply below.
  await db.query(
    "UPDATE discussion_post SET created_at=now()-interval '1 minute' WHERE id=$1",
    [await createDiscussionPost(ben, "One more", false)],
  );
  // A reply on the card moves it, held by its review, to the top.
  await addComment(ben, recommend, "Glad you liked it.", false);
  const moved = await read(ben, "/?before=now");
  assert.equal(moved.conversations.length, 50);
  assert.deepEqual(cards(moved.conversations.slice(0, 1)), [
    [review, recommend],
  ]);
});

test("a review edited days later shows on its own again", async () => {
  const { alice, ben, conversation: recommend } = await setup();
  await friend(alice, ben);
  const progress = await updateWatchStatus(alice, "movie:1", "finished");
  assert.ok(progress);
  const review = await saveReview(alice, "movie:1", 3, "Fine.", false);
  assert.deepEqual(cards(await conversations(ben, { owner: alice })), [
    [review, progress, recommend],
  ]);
  for (const [table, id] of [
    ["progress", progress],
    ["review", review],
    ["action", recommend],
  ] as const)
    await back(table, id, "3 days");
  await saveReview(alice, "movie:1", 4, "Better than fine.", false);
  const shown = await conversations(ben, { owner: alice });
  assert.deepEqual(cards(shown), [[review], [progress, recommend]]);
  assert.equal(shown[0].edited, true);
});

test("the title page friend line names a friend's action inside a card by the card", async () => {
  const { alice, ben, conversation: recommend } = await setup();
  await friend(alice, ben);
  const review = await saveReview(alice, "movie:1", 5, null, false);
  const screen = await loadScreen(ben, "/titles/movie/1");
  assert.ok(screen.kind === "title");
  assert.deepEqual(screen.friends.recommended, [
    { item: review, user_id: alice, display_name: "alice", rank: null },
  ]);
  assert.ok(!screen.conversations.some((entry) => entry.id === recommend));
});

test("a card's author line names its actions in a fixed order, joined like a sentence", async () => {
  const { cardPhrase } = await import("../../src/components/feed");
  const entry = (
    item_type: FeedItem["item_type"],
    fields: Partial<FeedItem> = {},
  ) =>
    ({
      id: item_type,
      item_type,
      status: null,
      rating: 4,
      body: null,
      spoiler: false,
      edited: false,
      combined: [],
      ...fields,
    }) as unknown as FeedItem;
  const card = (holder: FeedItem, ...others: FeedItem[]) => ({
    ...holder,
    combined: others,
  });
  const finished = entry("progress", { status: "finished" });
  const reviewed = entry("review", { body: "Loved it." });
  const rated = entry("review");
  const recommends = entry("recommended");
  for (const [shown, phrase] of [
    [card(reviewed, finished), "finished and reviewed"],
    [
      card(reviewed, recommends, finished),
      "finished, reviewed, and recommends",
    ],
    [
      card(recommends, entry("progress", { status: "watching" })),
      "is watching and recommends",
    ],
    [card(rated, entry("want_to_watch")), "rated and wants to watch"],
    [
      card(entry("progress", { status: "caught_up" }), rated),
      "is caught up and rated",
    ],
    [
      card(rated, entry("progress", { status: "stopped" })),
      "stopped watching and rated",
    ],
  ] as const)
    assert.equal(cardPhrase(shown), phrase);
});

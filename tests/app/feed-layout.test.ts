import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Comment, FeedItem } from "../../src/shared";
const { acceptActivity, feedLayout, withOlder } =
  await import("../../src/feed-layout");

// The New activity cases that the iPhone app's FeedLayout runs too, so the
// two clients lay out the same feed the same way.
type Entry = Partial<Omit<FeedItem, "comments">> & {
  comments?: Partial<Comment>[];
};
const cases: {
  viewer: string;
  entry: FeedItem;
  comment: Comment;
  cases: {
    name: string;
    accepted: Entry[] | null;
    older_than?: string;
    snapshot: Entry[];
    entries: { id: string; comments: string[]; visible_activity: string }[];
    incoming: number;
  }[];
} = JSON.parse(
  readFileSync(
    new URL(
      "../../ios/ScreenrKit/SharedCases/feed-layout.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const entry = ({ comments = [], ...fields }: Entry): FeedItem => ({
  ...cases.entry,
  ...fields,
  comments: comments.map((comment) => ({ ...cases.comment, ...comment })),
});

// The visible activity the server sends for an entry, with every reply it
// sends visible (src/server/feed.ts).
function sentActivity(item: FeedItem) {
  const live = item.comments
    .filter((comment) => !comment.removed && !comment.unavailable)
    .map((comment) => Date.parse(comment.created_at));
  const replies = item.comments.map((comment) =>
    Date.parse(comment.created_at),
  );
  const activity = Date.parse(item.activity_at);
  return new Date(
    item.item_type === "earlier"
      ? Math.max(
          ...(live.length ? live : replies.length ? replies : [activity]),
        )
      : Math.max(activity, ...live),
  ).toISOString();
}

for (const example of cases.cases)
  test(`feed layout: ${example.name}`, () => {
    const snapshot = example.snapshot.map(entry);
    // The layout keeps the server's visible activity where nothing waits.
    for (const item of [...snapshot, ...(example.accepted ?? []).map(entry)])
      assert.equal(item.visible_activity, sentActivity(item), item.id);
    let accepted =
      example.accepted && acceptActivity(example.accepted.map(entry));
    if (example.older_than)
      accepted = withOlder(
        accepted ?? acceptActivity(snapshot),
        snapshot,
        example.older_than,
      );
    const layout = feedLayout(snapshot, accepted, cases.viewer);
    assert.deepEqual(
      {
        entries: layout.entries.map((item) => ({
          id: item.id,
          comments: item.comments.map((comment) => comment.id),
          visible_activity: item.visible_activity,
        })),
        incoming: layout.incoming,
      },
      { entries: example.entries, incoming: example.incoming },
    );
  });

// Content always comes from the latest snapshot, even while its activity
// waits, and an entry with nothing waiting is the one the server sent.
test("feed layout shows the latest content and keeps unchanged entries", () => {
  const [moved] = cases.cases.filter(({ name }) =>
    name.startsWith("A moved entry"),
  );
  const snapshot = moved.snapshot.map(entry);
  const layout = feedLayout(
    snapshot,
    acceptActivity(moved.accepted!.map(entry)),
    cases.viewer,
  );
  const review = layout.entries.find((item) => item.id === "ben-review")!;
  assert.equal(review.body, "Edited.");
  assert.equal(review.edited, true);
  assert.equal(
    layout.entries.find((item) => item.id === "ben-recommend"),
    snapshot.find((item) => item.id === "ben-recommend"),
  );
});

test("Show older adds nothing when every older entry was accepted", () => {
  const snapshot = [entry({ id: "ben-recommend" })];
  const accepted = acceptActivity(snapshot);
  assert.equal(
    withOlder(accepted, snapshot, snapshot[0].visible_activity),
    accepted,
  );
});

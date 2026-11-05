import type { Comment, FeedItem } from "./shared";

// The New activity layout of an interactive feed (docs/title-feed.md#new-activity):
// which entries and replies the reader sees, in what order, and what waits
// behind New activity. The iPhone app's FeedLayout makes the same decisions,
// and both run the cases in ios/ScreenrKit/SharedCases/feed-layout.json.

// The activity a reader has accepted: each entry's activity time and reply
// IDs when they last took in the feed. The first snapshot is accepted as a
// whole; later, other people's new entries, moved entries, and new replies
// wait behind New activity.
type AcceptedEntry = { activity: string; comments: ReadonlySet<string> };
export type AcceptedActivity = ReadonlyMap<string, AcceptedEntry>;

export function acceptActivity(snapshot: FeedItem[]): AcceptedActivity {
  return new Map(
    snapshot.map((item) => [
      item.id,
      {
        activity: item.activity_at,
        comments: new Set(item.comments.map((comment) => comment.id)),
      },
    ]),
  );
}

// `accepted` with every entry of `snapshot` placed no later than `through`
// that it lacks, as Show older brings them: every newer entry was already in
// the window that read extended. It is `accepted` itself when none are added.
export function withOlder(
  accepted: AcceptedActivity,
  snapshot: FeedItem[],
  through: string,
): AcceptedActivity {
  const time = Date.parse(through);
  const older = snapshot.filter(
    (item) =>
      !accepted.has(item.id) && Date.parse(item.visible_activity) <= time,
  );
  return older.length
    ? new Map([...accepted, ...acceptActivity(older)])
    : accepted;
}

export type FeedLayout = {
  // The entries the reader sees, newest visible activity first, then by ID.
  // Each has only the replies the reader has accepted and the parents those
  // replies need, and the visible activity those replies and its accepted
  // activity give it. Content always comes from the snapshot, so access
  // changes, removals, withdrawn actions, and spoiler flags apply at once.
  entries: FeedItem[];
  // Entries with other people's new or moved activity, or new replies, that
  // the reader has not accepted. New activity shows the count.
  incoming: number;
};

type Placed = { item: FeedItem; time: number };

const live = (comment: Comment) => !comment.removed && !comment.unavailable;

// The feed `viewer`, the reader's user ID, sees in `snapshot`. Without
// accepted activity, the snapshot is accepted as a whole.
export function feedLayout(
  snapshot: FeedItem[],
  accepted: AcceptedActivity | null,
  viewer: string,
): FeedLayout {
  const known = accepted ?? acceptActivity(snapshot);
  let incoming = 0;
  const placed: Placed[] = [];
  for (const item of snapshot) {
    const previous = known.get(item.id);
    const own = item.owner_id === viewer;
    const moved = !own && previous?.activity !== item.activity_at;
    const replied = item.comments.some(
      (comment) =>
        live(comment) &&
        comment.author_id !== viewer &&
        !previous?.comments.has(comment.id),
    );
    if (moved || replied) incoming++;
    if (!previous && !own) continue;
    const entry =
      moved || replied ? heldBack(item, previous, own, viewer) : current(item);
    if (entry) placed.push(entry);
  }
  placed.sort(
    (a, b) =>
      b.time - a.time ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return { entries: placed.map(({ item }) => item), incoming };
}

// The replies the reader sees: the live ones they accepted, and the parents
// those replies need, including the reader's own posted in another tab.
// Unrelated incoming groups stay behind New activity.
function shownComments(
  comments: Comment[],
  accepted: (comment: Comment) => boolean,
) {
  const roots = new Set(
    comments
      .filter((comment) => live(comment) && accepted(comment))
      .map((comment) => comment.root_id),
  );
  return comments.filter(
    (comment) => roots.has(comment.id) || (live(comment) && accepted(comment)),
  );
}

// Whether an entry shows with these replies: while it is active, for a live
// reply, or, for an earlier discussion, for any reply it keeps.
const shows = (item: FeedItem, comments: Comment[]) =>
  item.active ||
  comments.some(live) ||
  (item.item_type === "earlier" && comments.length > 0);

// An entry with nothing waiting, as the server sent it. The server's visible
// activity is this layout's with every reply accepted, so the entry keeps it
// and large feeds rebuild nothing. Only replies that are neither live nor a
// live reply's parent, which the server never sends, drop out.
function current(item: FeedItem): Placed | null {
  const comments = item.comments.every(live)
    ? item.comments
    : shownComments(item.comments, () => true);
  if (!shows(item, comments)) return null;
  return {
    item: comments === item.comments ? item : { ...item, comments },
    time: Date.parse(item.visible_activity),
  };
}

// An entry with activity waiting behind New activity, placed by the activity
// the reader accepted, or null when nothing of it shows yet.
function heldBack(
  item: FeedItem,
  previous: AcceptedEntry | undefined,
  own: boolean,
  viewer: string,
): Placed | null {
  const comments = shownComments(
    item.comments,
    (comment) =>
      !!previous?.comments.has(comment.id) || comment.author_id === viewer,
  );
  if (!shows(item, comments)) return null;
  const times = comments
    .filter(live)
    .map((comment) => Date.parse(comment.created_at));
  let time: number;
  if (item.item_type === "earlier") {
    const placed = times.length
      ? times
      : comments.map((comment) => Date.parse(comment.created_at));
    time = placed.length ? Math.max(...placed) : Date.parse(item.activity_at);
  } else {
    const activation = own ? item.activity_at : previous!.activity;
    time = Math.max(Date.parse(activation), ...times);
  }
  return {
    item: { ...item, comments, visible_activity: new Date(time).toISOString() },
    time,
  };
}

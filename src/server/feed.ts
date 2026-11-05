import { AppError, db, isUuid } from "./db";
import type { FeedItem, FriendActivity, Thread } from "../shared";
import { entryPath, memberPath } from "../member-routes";

// Access, replies, counts, and activity are read in one PostgreSQL snapshot.
// All surfaces use this query; reply authors never expand the parent audience.
// A review is edited once a later save changes it; removal erases it.
// Posts without a title have no conversation or title.
export const feedEntries = `(SELECT id,conversation_id,owner_id,title_id,item_type,active,created_at,activity_at,
    NULL::text AS body,false AS spoiler,NULL::text AS status,NULL::text AS finished_on,
    NULL::smallint AS rating,false AS edited,NULL::int AS season,NULL::int AS episode FROM feed_item
  UNION ALL
  SELECT id,conversation_id,owner_id,title_id,'comment',removed_at IS NULL,created_at,created_at,
    CASE WHEN removed_at IS NULL THEN body ELSE '' END,spoiler,NULL,NULL,NULL,false,
    season_number,episode_number FROM title_comment
  UNION ALL
  SELECT id,conversation_id,owner_id,title_id,'progress',active,created_at,activity_at,
    NULL,false,status,finished_on::text,NULL,false,NULL,NULL FROM watch_progress
  UNION ALL
  SELECT id,conversation_id,owner_id,title_id,'review',active,created_at,activity_at,
    body,spoiler,NULL,NULL,rating,active AND activity_at>created_at,NULL,NULL FROM review
  UNION ALL
  SELECT id,NULL,owner_id,NULL,'post',removed_at IS NULL,created_at,created_at,
    CASE WHEN removed_at IS NULL THEN body ELSE '' END,spoiler,NULL,NULL,NULL,false,NULL,NULL
    FROM discussion_post)`;
// Replies and reactions name their entry in the column for its type.
export const entryColumn = (itemType: string) =>
  itemType === "comment"
    ? "title_comment_id"
    : itemType === "progress"
      ? "watch_progress_id"
      : itemType === "review"
        ? "review_id"
        : itemType === "post"
          ? "discussion_post_id"
          : "feed_item_id";
// The columns of a reply or reaction that name its entry, one per entry type.
const entryColumns = [
  "feed_item_id",
  "title_comment_id",
  "watch_progress_id",
  "review_id",
  "discussion_post_id",
];
// Whether reply or reaction `row` belongs to the entry with ID `entry`.
export const belongsTo = (row: string, entry: string) =>
  `(${entryColumns.map((column) => `${row}.${column}=${entry}`).join(" OR ")})`;
// The ID of the entry that reply `row` belongs to.
export const entryOf = (row: string) =>
  `coalesce(${entryColumns.map((column) => `${row}.${column}`).join(",")})`;
// Deleted standalone comments and posts and removed reviews keep their
// replies but have no content, so they show and take no reactions.
export const erasable = (itemType: string) =>
  itemType === "comment" || itemType === "review" || itemType === "post";
// The reader's ($1) access, read once per statement instead of calling
// screenr_can_read and screenr_blocked for each row (issue #373). `audience`
// has a row for each owner whose entries the reader can read, the reader and
// their friends, with `readers`, everyone who can read that owner's entries.
// `hidden` lists everyone the reader has blocked or been blocked by.
const access = `audience AS MATERIALIZED (
    SELECT r.owner_id,ARRAY(SELECT user_id FROM screenr_friends(r.owner_id)) || r.owner_id AS readers
    FROM (SELECT $1::text AS owner_id UNION ALL SELECT user_id FROM screenr_friends($1)) r
  ), hidden AS MATERIALIZED (
    SELECT ARRAY(SELECT CASE WHEN blocker_id=$1 THEN blocked_id ELSE blocker_id END
      FROM block WHERE $1 IN (blocker_id,blocked_id)) AS users
  )`;
// The reader's entries, each joined with its owner's audience as `a` and the
// reader's hidden people as `h`. The lateral join, which its LIMIT keeps
// PostgreSQL from flattening, reads entries first, so a lookup of one entry,
// or of one title's, still starts from that index.
const readableEntries = `${feedEntries} c
  JOIN LATERAL (SELECT readers FROM audience WHERE audience.owner_id=c.owner_id LIMIT 1) a ON true
  CROSS JOIN hidden h`;
// Whether `person` takes part in entry c's discussion for this reader: they
// can read its owner's entries, and neither they nor the reader blocked the
// other.
const takesPart = (person: string) =>
  `(${person}=ANY(a.readers) AND NOT ${person}=ANY(h.users))`;
// Counts include only current participants visible to this reader. A reaction
// to a reply also requires that its author can still see the reply's author.
// Deleted standalone comments and removed reviews have no content, so they
// show no reactions.
const reactionSummary = (
  reply: boolean,
) => `(SELECT coalesce(jsonb_agg(summary ORDER BY kind),'[]') FROM (
  SELECT r.kind,count(*)::int AS count,bool_or(r.user_id=$1) AS reacted FROM reaction r
  WHERE ${
    reply
      ? `r.comment_id=cm.id AND cm.accessible AND cm.removed_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM block b WHERE (b.blocker_id=r.user_id AND b.blocked_id=cm.author_id)
      OR (b.blocker_id=cm.author_id AND b.blocked_id=r.user_id))`
      : `${belongsTo("r", "c.id")} AND (c.item_type NOT IN ('comment','review','post') OR c.active)`
  }
    AND ${takesPart("r.user_id")}
  GROUP BY r.kind
) summary)`;
// The reader's ($1) current status for a title: a progress status, Want to
// watch, or none. One status is current at a time.
export const viewerStatus = (title: string) => `coalesce(
    (SELECT own.status FROM watch_progress own WHERE own.owner_id=$1 AND own.title_id=${title} AND own.active),
    (SELECT 'want_to_watch' FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=${title}
      AND own.item_type='want_to_watch' AND own.active))`;
// Each entry of `entries`, a FROM list that names entry c with its owner's
// audience a and the reader's hidden people h, as the reader sees it, with
// its replies and reactions, if the reader can see it at all. It selects only
// the fields that FeedItem declares.
const items = (
  entries: string,
) => `SELECT c.id,c.owner_id,c.title_id,c.item_type,c.active,c.activity_at,c.body,c.spoiler,
  c.status,c.finished_on,c.rating,c.edited,c.season,c.episode,
  p.username,p.display_name,screenr_photo(p.user_id) AS photo,t.name AS title_name,t.poster_path,t.kind,t.release_date,
  (c.item_type='recommended' AND c.active) AS recommended,
  (c.item_type='want_to_watch' AND c.active) AS want_to_watch,
  EXISTS (SELECT 1 FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=c.title_id
    AND own.item_type='want_to_watch' AND own.active) AS viewer_want_to_watch,
  EXISTS (SELECT 1 FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=c.title_id
    AND own.item_type='recommended' AND own.active) AS viewer_recommended,
  ${viewerStatus("c.title_id")} AS viewer_status,
  (SELECT own.rank FROM top_ten own WHERE own.owner_id=$1 AND own.title_id=c.title_id) AS viewer_top_ten_rank,
  date_trunc('milliseconds', CASE WHEN c.item_type='earlier' THEN coalesce(replies.activity,replies.placeholder_activity,c.created_at)
    ELSE greatest(c.activity_at,coalesce(replies.activity,c.activity_at)) END) AS visible_activity,
  coalesce(replies.comments,'[]') AS comments,
  ${reactionSummary(false)} AS reactions
  FROM ${entries} JOIN profile p ON p.user_id=c.owner_id LEFT JOIN title t ON t.id=c.title_id
  LEFT JOIN LATERAL (
    WITH candidates AS (
      -- A removed comment whose author deleted their account has no author;
      -- it shows as removed, without one, while its replies remain.
      SELECT cm.*,cm.author_id IS NULL OR ${takesPart("cm.author_id")} AS accessible
      FROM comment cm WHERE ${belongsTo("cm", "c.id")}
    ), retained AS (
      SELECT cm.* FROM candidates cm
      WHERE (cm.accessible AND cm.removed_at IS NULL)
        OR (cm.root_id IS NULL AND EXISTS (
          SELECT 1 FROM candidates child WHERE child.root_id=cm.id
            AND child.accessible AND child.removed_at IS NULL))
    )
    SELECT jsonb_agg(jsonb_build_object(
      'id',cm.id::text,'author_id',CASE WHEN cm.accessible THEN cm.author_id ELSE NULL END,
      'username',CASE WHEN cm.accessible THEN author.username ELSE NULL END,
      'display_name',CASE WHEN cm.accessible THEN author.display_name ELSE NULL END,
      'photo',CASE WHEN cm.accessible THEN screenr_photo(author.user_id) ELSE NULL END,
      'body',CASE WHEN cm.accessible AND cm.removed_at IS NULL THEN cm.body ELSE '' END,
      'spoiler',cm.accessible AND cm.spoiler,
      'root_id',cm.root_id::text,'addressed_username',CASE WHEN cm.accessible
        AND ${takesPart("cm.addressed_id")} THEN addressed.username ELSE NULL END,
      'removed',cm.removed_at IS NOT NULL,'unavailable',NOT cm.accessible,
      'created_at',cm.created_at,
      'reactions',${reactionSummary(true)}) ORDER BY cm.created_at,cm.id) AS comments,
      max(cm.created_at) FILTER (WHERE cm.accessible AND cm.removed_at IS NULL) AS activity,
      max(cm.created_at) AS placeholder_activity
    FROM retained cm LEFT JOIN profile author ON author.user_id=cm.author_id
    LEFT JOIN profile addressed ON addressed.user_id=cm.addressed_id
  ) replies ON true
  WHERE (c.active OR replies.activity IS NOT NULL
      OR (c.item_type='earlier' AND replies.placeholder_activity IS NOT NULL))`;
// Every entry the reader ($1) can see. Callers add conditions on c, such as
// `AND c.id=$2::uuid`.
export const itemQuery = `WITH ${access} ${items(readableEntries)}`;

export async function conversations(
  viewer: string,
  filter: { title?: string; owner?: string } = {},
): Promise<FeedItem[]> {
  return (
    await db.query(
      `${itemQuery}
    AND ($2::text IS NULL OR c.title_id=$2) AND ($3::text IS NULL OR c.owner_id=$3)
    ORDER BY visible_activity DESC,c.id`,
      [viewer, filter.title ?? null, filter.owner ?? null],
    )
  ).rows;
}

// The friends feed and profiles send a page of history at a time
// (docs/title-feed.md#paged-histories).
export const pageSize = 50;

// Which entries a paged read sends: every entry placed at or after `since`,
// or the page of `pageSize` entries placed before `before` with every newer
// entry, where `Infinity` reads the newest page. Entries tied with the page's
// last one come too.
export type FeedWindow = { since: Date } | { before: Date | typeof Infinity };

// A paged read of the reader's ($1) entries, or only `owner`'s. It first
// places every entry, which reads only entry times and reply authors, and
// then builds discussions for only the entries it sends: the window, and
// `item`, an entry a link names, wherever it falls. An entry's place is its
// latest visible activity counting removed replies too, so removing a reply
// never moves an entry out of a window that held it; the feed still orders
// by visible activity, which a place is never older than. `since` names the
// window it sent, which later reads of the same window send back, or is null
// when there are no entries; `older` says whether older entries remain. All
// of it comes from one snapshot.
export async function feedPage(
  viewer: string,
  window: FeedWindow,
  { owner, item }: { owner?: string; item?: string } = {},
): Promise<{
  conversations: FeedItem[];
  since: string | null;
  older: boolean;
}> {
  const before = "before" in window ? window.before : null;
  const { rows } = await db.query(
    `WITH ${access}, entries AS MATERIALIZED (
      SELECT c.id,c.item_type,c.active,c.created_at,c.activity_at,a.readers
      FROM ${feedEntries} c JOIN audience a ON a.owner_id=c.owner_id
      WHERE $2::text IS NULL OR c.owner_id=$2
    ), replied AS (
      SELECT e.id,max(cm.created_at) FILTER (WHERE cm.removed_at IS NULL) AS at,max(cm.created_at) AS placed
      FROM hidden h,comment cm JOIN entries e ON ${entryOf("cm")}=e.id
      WHERE cm.author_id=ANY(e.readers) AND NOT cm.author_id=ANY(h.users)
      GROUP BY e.id
    ), placed AS MATERIALIZED (
      SELECT e.id,date_trunc('milliseconds',CASE WHEN e.item_type='earlier' THEN coalesce(r.placed,e.created_at)
        ELSE greatest(e.activity_at,coalesce(r.placed,e.activity_at)) END) AS placed_at
      FROM entries e LEFT JOIN replied r ON r.id=e.id
      WHERE e.active OR r.at IS NOT NULL
    ), bound AS MATERIALIZED (
      SELECT coalesce($3::timestamptz,
        (SELECT placed_at FROM placed WHERE placed_at<$4::timestamptz
          ORDER BY placed_at DESC LIMIT 1 OFFSET ${pageSize - 1}),
        (SELECT min(placed_at) FROM placed WHERE placed_at<$4::timestamptz),
        nullif($4::timestamptz,'infinity')) AS since
    ), shown AS (
      SELECT p.id FROM placed p,bound b WHERE p.placed_at>=b.since OR p.id=$5::uuid
    )
    SELECT b.since AS page_since,
      EXISTS (SELECT 1 FROM placed p WHERE p.placed_at<b.since) AS page_older,i.*
    FROM bound b LEFT JOIN (${items(
      `shown s JOIN ${feedEntries} c ON c.id=s.id JOIN audience a ON a.owner_id=c.owner_id CROSS JOIN hidden h`,
    )}) i ON true
    ORDER BY i.visible_activity DESC,i.id`,
    [
      viewer,
      owner ?? null,
      "since" in window ? window.since : null,
      before === Infinity ? "infinity" : before,
      isUuid(item) ? item : null,
    ],
  );
  return {
    conversations: rows.flatMap(({ page_since, page_older, ...entry }) =>
      entry.id === null ? [] : [entry as FeedItem],
    ),
    since: (rows[0].page_since as Date | null)?.toISOString() ?? null,
    older: rows[0].page_older,
  };
}

// The title page friend line comes from the viewer's title feed, so it lists
// only current friends under the same audience and blocking checks. The
// header already shows the viewer's own choice. Recommenders with the title
// in their top 10 (`ranks`, by user ID) come first, best rank first; then
// newest action first.
export function friendActivity(
  viewer: string,
  items: FeedItem[],
  ranks: Map<string, number>,
): FriendActivity {
  const time = (c: FeedItem) => new Date(c.activity_at).getTime();
  const group = (type: "recommended" | "want_to_watch") => {
    const rank = (c: FeedItem) =>
      (type === "recommended" && ranks.get(c.owner_id)) || null;
    return items
      .filter((c) => c.item_type === type && c.active && c.owner_id !== viewer)
      .sort(
        (a, b) =>
          (rank(a) ?? Infinity) - (rank(b) ?? Infinity) ||
          time(b) - time(a) ||
          a.id.localeCompare(b.id),
      )
      .map((c) => ({
        item: c.id,
        user_id: c.owner_id,
        display_name: c.display_name,
        rank: rank(c),
      }));
  };
  return {
    recommended: group("recommended"),
    want_to_watch: group("want_to_watch"),
  };
}

export async function thread(viewer: string, id: string): Promise<Thread> {
  if (!isUuid(id)) throw new AppError("Conversation not found.", 404);
  const { rows } = await db.query(`${itemQuery} AND c.id=$2::uuid`, [
    viewer,
    id,
  ]);
  if (!rows[0]) throw new AppError("Conversation not found.", 404);
  const { comments, ...conversation } = rows[0];
  return { conversation, comments };
}

// Old /conversations/<id> links open the eligible entry on its title page,
// or on the friends feed for a post without a title.
export async function conversationURL(
  viewer: string,
  id: string,
  reply?: string,
) {
  // `thread` below reports an ID that is not a uuid as not found.
  const legacy = isUuid(id)
    ? (
        await db.query(
          `SELECT title_id,owner_id FROM conversation
    WHERE id=$2::uuid AND screenr_can_read($1,owner_id)`,
          [viewer, id],
        )
      ).rows[0]
    : undefined;
  let item: FeedItem | undefined;
  if (legacy) {
    const eligible = await conversations(viewer, {
      title: legacy.title_id,
      owner: legacy.owner_id,
    });
    item = eligible.find((c) => c.id === id) ?? eligible[0];
  } else {
    const result = await thread(viewer, id);
    item = { ...result.conversation, comments: result.comments };
  }
  if (!item) return memberPath({ kind: "title", id: legacy.title_id });
  return entryPath(
    item,
    item.comments.find((c) => c.id === reply && !c.unavailable)?.id,
  );
}

// The item a feed or title page link names, if the reader can see it. A
// missing item or reply makes the target unavailable.
export function linkTarget(
  items: FeedItem[],
  { item, reply }: { item?: string; reply?: string },
) {
  const targeted = items.find((c) => c.id === item);
  const targetReply = targeted?.comments.find(
    (c) => c.id === reply && !c.unavailable,
  );
  return {
    target: targeted ? { item: targeted.id, reply: targetReply?.id } : null,
    targetUnavailable: !!item && (!targeted || (!!reply && !targetReply)),
  };
}

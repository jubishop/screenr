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
// Whether reply or reaction `row` belongs to the entry with ID `entry`.
export const belongsTo = (row: string, entry: string) =>
  `(${row}.feed_item_id=${entry} OR ${row}.title_comment_id=${entry} OR ${row}.watch_progress_id=${entry}
    OR ${row}.review_id=${entry} OR ${row}.discussion_post_id=${entry})`;
// Deleted standalone comments and posts and removed reviews keep their
// replies but have no content, so they show and take no reactions.
export const erasable = (itemType: string) =>
  itemType === "comment" || itemType === "review" || itemType === "post";
// Counts include only current participants visible to this reader. A reaction
// to a reply also requires that its author can still see the reply's author.
// Deleted standalone comments and removed reviews have no content, so they
// show no reactions.
const reactionSummary = (
  reply: boolean,
) => `(SELECT coalesce(jsonb_agg(summary ORDER BY kind),'[]') FROM (
  SELECT r.kind,count(*)::int AS count,bool_or(r.user_id=$1) AS reacted FROM reaction r
  WHERE ${reply ? "r.comment_id=cm.id AND cm.accessible AND cm.removed_at IS NULL AND NOT screenr_blocked(r.user_id,cm.author_id)" : `${belongsTo("r", "c.id")} AND (c.item_type NOT IN ('comment','review','post') OR c.active)`}
    AND screenr_can_read(r.user_id,c.owner_id) AND NOT screenr_blocked($1,r.user_id)
  GROUP BY r.kind
) summary)`;
// The reader's ($1) current status for a title: a progress status, Want to
// watch, or none. One status is current at a time.
export const viewerStatus = (title: string) => `coalesce(
    (SELECT own.status FROM watch_progress own WHERE own.owner_id=$1 AND own.title_id=${title} AND own.active),
    (SELECT 'want_to_watch' FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=${title}
      AND own.item_type='want_to_watch' AND own.active))`;
export const itemQuery = `SELECT c.*,p.username,p.display_name,screenr_photo(p.user_id) AS photo,t.name AS title_name,t.poster_path,t.kind,t.release_date,
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
  FROM ${feedEntries} c JOIN profile p ON p.user_id=c.owner_id LEFT JOIN title t ON t.id=c.title_id
  LEFT JOIN LATERAL (
    WITH candidates AS (
      SELECT cm.*,screenr_can_read(cm.author_id,c.owner_id)
        AND NOT screenr_blocked($1,cm.author_id) AS accessible
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
        AND screenr_can_read(cm.addressed_id,c.owner_id)
        AND NOT screenr_blocked($1,cm.addressed_id) THEN addressed.username ELSE NULL END,
      'removed',cm.removed_at IS NOT NULL,'unavailable',NOT cm.accessible,
      'created_at',cm.created_at,
      'reactions',${reactionSummary(true)}) ORDER BY cm.created_at,cm.id) AS comments,
      max(cm.created_at) FILTER (WHERE cm.accessible AND cm.removed_at IS NULL) AS activity,
      max(cm.created_at) AS placeholder_activity
    FROM retained cm JOIN profile author ON author.user_id=cm.author_id
    LEFT JOIN profile addressed ON addressed.user_id=cm.addressed_id
  ) replies ON true
  WHERE screenr_can_read($1,c.owner_id)
    AND (c.active OR replies.activity IS NOT NULL
      OR (c.item_type='earlier' AND replies.placeholder_activity IS NOT NULL))`;

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

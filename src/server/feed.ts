import { AppError, db } from "./db";
import type { FeedItem, Thread } from "../shared";

// Access, replies, counts, and activity are read in one PostgreSQL snapshot.
// All surfaces use this query; reply authors never expand the parent audience.
export const feedEntries = `(SELECT id,conversation_id,owner_id,title_id,item_type,active,created_at,activity_at,
    NULL::text AS body,false AS spoiler FROM feed_item
  UNION ALL
  SELECT id,conversation_id,owner_id,title_id,'comment',removed_at IS NULL,created_at,created_at,
    CASE WHEN removed_at IS NULL THEN body ELSE '' END,spoiler
    FROM title_comment)`;
// Counts include only current participants visible to this reader. A reaction
// to a reply also requires that its author can still see the reply's author.
const reactionSummary = (
  reply: boolean,
) => `(SELECT coalesce(jsonb_agg(summary ORDER BY kind),'[]') FROM (
  SELECT r.kind,count(*)::int AS count,bool_or(r.user_id=$1) AS reacted FROM reaction r
  WHERE ${reply ? "r.comment_id=cm.id AND cm.accessible AND cm.removed_at IS NULL AND NOT screenr_blocked(r.user_id,cm.author_id)" : "(r.feed_item_id=c.id OR r.title_comment_id=c.id) AND (c.item_type<>'comment' OR c.active)"}
    AND screenr_can_read(r.user_id,c.owner_id) AND NOT screenr_blocked($1,r.user_id)
  GROUP BY r.kind
) summary)`;
export const itemQuery = `SELECT c.*,p.username,p.display_name,t.name AS title_name,t.poster_path,t.kind,
  (c.item_type='recommended' AND c.active) AS recommended,
  (c.item_type='want_to_watch' AND c.active) AS want_to_watch,
  EXISTS (SELECT 1 FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=c.title_id
    AND own.item_type='want_to_watch' AND own.active) AS viewer_want_to_watch,
  EXISTS (SELECT 1 FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=c.title_id
    AND own.item_type='recommended' AND own.active) AS viewer_recommended,
  date_trunc('milliseconds', CASE WHEN c.item_type='earlier' THEN coalesce(replies.activity,replies.placeholder_activity,c.created_at)
    ELSE greatest(c.activity_at,coalesce(replies.activity,c.activity_at)) END) AS visible_activity,
  coalesce(replies.comments,'[]') AS comments,
  ${reactionSummary(false)} AS reactions
  FROM ${feedEntries} c JOIN profile p ON p.user_id=c.owner_id JOIN title t ON t.id=c.title_id
  LEFT JOIN LATERAL (
    WITH candidates AS (
      SELECT cm.*,screenr_can_read(cm.author_id,c.owner_id)
        AND NOT screenr_blocked($1,cm.author_id) AS accessible
      FROM comment cm WHERE cm.feed_item_id=c.id OR cm.title_comment_id=c.id
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

export async function thread(viewer: string, id: string): Promise<Thread> {
  const { rows } = await db.query(`${itemQuery} AND c.id::text=$2`, [
    viewer,
    id,
  ]);
  if (!rows[0]) throw new AppError("Conversation not found.", 404);
  const { comments, ...conversation } = rows[0];
  return { conversation, comments };
}

export async function conversationURL(
  viewer: string,
  id: string,
  reply?: string,
) {
  const legacy = (
    await db.query(
      `SELECT title_id,owner_id FROM conversation
    WHERE id::text=$2 AND screenr_can_read($1,owner_id)`,
      [viewer, id],
    )
  ).rows[0];
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
  const titleId = item?.title_id ?? legacy.title_id;
  const target = item
    ? `?item=${item.id}${reply && item.comments.some((c) => c.id === reply && !c.unavailable) ? `&reply=${reply}` : ""}`
    : "";
  return `/titles/${titleId.replace(":", "/")}${target}`;
}

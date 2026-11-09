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
// One person's active status, review, and Recommend or Want to watch for a
// title combine into one card when their actions fall within 24 hours
// (docs/title-feed.md#combined-title-actions). Their action times alone
// decide it, never replies, so every reader sees the same cards.
const combinable = (entry: string) =>
  `${entry}.active AND ${entry}.item_type IN ('progress','review','recommended','want_to_watch')`;
// Whether combinable entry `entry` has any stored reply or reaction, removed
// or not, whoever wrote it, so every reader sees the same holder.
const discussed = (entry: string) => {
  const has = (column: string) =>
    `(EXISTS (SELECT 1 FROM comment WHERE ${column}=${entry}.id) OR EXISTS (SELECT 1 FROM reaction WHERE ${column}=${entry}.id))`;
  return `CASE ${entry}.item_type WHEN 'progress' THEN ${has("watch_progress_id")}
    WHEN 'review' THEN ${has("review_id")} ELSE ${has("feed_item_id")} END`;
};
// Every entry of `source`, a query of entries with id, owner_id, title_id,
// item_type, active, created_at, and activity_at, with those columns but the
// owner and title, `holder`, and `newest`: for an entry in a card of two or
// more, the entry whose discussion and reactions the card shows and the
// card's newest action, and otherwise null and its own action.
//
// A person has at most three combinable entries for a title, one of each
// kind, since Recommend and Want to watch are exclusive; newest first, they
// are a, b, and c. Each joins the first card whose newest entry it falls
// within 24 hours before, where at most one entry has discussion, or starts
// its own: b joins a's card or starts one, and c joins a's, then b's, or
// starts one. The entry with discussion holds a card, or else the review,
// then the status. One sorted pass of window functions decides it, without
// joins, so a misestimated row count never multiplies the work, and byte
// order sorts the owners and titles it groups. Each OFFSET keeps PostgreSQL
// from copying a step's expressions into every later use of their results.
const cardsOf = (source: string) => {
  // One person's entries for a title, newest first, apart from the others.
  const person = (entry: string, joins: string) =>
    `PARTITION BY ${entry}.owner_id COLLATE "C",${entry}.title_id COLLATE "C",${joins}
      ORDER BY ${entry}.activity_at DESC,${entry}.id`;
  const nth = (column: string, n: number) =>
    `nth_value(d.${column},${n}) OVER (${person("d", "d.joins")}
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)`;
  const near = (later: string, earlier: string) =>
    `coalesce(${earlier}>=${later}-interval '24 hours',false)`;
  // An entry's rank holds whether it has discussion, below 3, and its kind.
  const has = (entry: string) => `${entry}_rank<3`;
  return `WITH ranked AS (
    SELECT s.id,s.owner_id,s.title_id,s.item_type,s.active,s.created_at,s.activity_at,
      ${combinable("s")} AS joins,
      ${near("lag(s.activity_at) OVER w", "s.activity_at")} OR ${near("s.activity_at", "lead(s.activity_at) OVER w")} AS near
    FROM (${source}) s
    WINDOW w AS (${person("s", combinable("s"))})
  ), discussed AS (
    -- Which entry holds a card: lowest rank first, by discussion, then the
    -- review, the status, and Recommend or Want to watch. An entry with no
    -- other within 24 hours is alone whatever its discussion.
    SELECT r.*,CASE WHEN r.joins AND r.near AND ${discussed("r")} THEN 0 ELSE 3 END
      +CASE r.item_type WHEN 'review' THEN 0 WHEN 'progress' THEN 1 ELSE 2 END AS rank
    FROM ranked r OFFSET 0
  ), spread AS (
    SELECT d.id,d.item_type,d.active,d.created_at,d.activity_at,d.joins,
      ${["a", "b", "c"]
        .map(
          (entry, index) =>
            `${nth("id", index + 1)} AS ${entry},${nth("activity_at", index + 1)} AS ${entry}_at,
      ${nth("rank", index + 1)} AS ${entry}_rank`,
        )
        .join(",\n      ")}
    FROM discussed d OFFSET 0
  ), joined AS (
    -- Card A starts with a. b joins it, or starts card B, which c joins
    -- when it is not in A.
    SELECT x.*,${near("x.a_at", "x.b_at")} AND NOT (${has("x.a")} AND ${has("x.b")}) AS b_in_a,
      ${near("x.a_at", "x.c_at")} AND NOT ((${has("x.a")} OR (${near("x.a_at", "x.b_at")}
        AND NOT ${has("x.a")} AND ${has("x.b")})) AND ${has("x.c")}) AS c_in_a
    FROM spread x OFFSET 0
  ), cards AS (
    SELECT y.*,NOT y.b_in_a AND NOT y.c_in_a AND ${near("y.b_at", "y.c_at")} AND NOT (${has("y.b")} AND ${has("y.c")}) AS c_in_b
    FROM joined y OFFSET 0
  )
  SELECT k.id,k.item_type,k.active,k.created_at,k.activity_at,
    CASE WHEN NOT k.joins THEN NULL
      WHEN (k.id=k.a OR (k.id=k.b AND k.b_in_a) OR (k.id=k.c AND k.c_in_a)) AND (k.b_in_a OR k.c_in_a)
        THEN CASE WHEN k.a_rank<=CASE WHEN k.b_in_a THEN k.b_rank ELSE 9 END
            AND k.a_rank<=CASE WHEN k.c_in_a THEN k.c_rank ELSE 9 END THEN k.a
          WHEN k.b_in_a AND k.b_rank<=CASE WHEN k.c_in_a THEN k.c_rank ELSE 9 END THEN k.b ELSE k.c END
      WHEN (k.id=k.b OR k.id=k.c) AND k.c_in_b THEN CASE WHEN k.b_rank<=k.c_rank THEN k.b ELSE k.c END
    END AS holder,
    CASE WHEN NOT k.joins THEN k.activity_at
      WHEN (k.id=k.a OR (k.id=k.b AND k.b_in_a) OR (k.id=k.c AND k.c_in_a)) AND (k.b_in_a OR k.c_in_a) THEN k.a_at
      WHEN (k.id=k.b OR k.id=k.c) AND k.c_in_b THEN k.b_at ELSE k.activity_at END AS newest
  FROM cards k`;
};
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
// the fields that FeedItem declares. `cards`, a CTE from cardsOf, names the
// cards among them: a card's holder stands for it with the card's newest
// action time, the other entries in `combined`, and the spoiler flag of a
// review in it, while those other entries are left out.
const items = (
  entries: string,
) => `SELECT c.id,c.owner_id,c.title_id,c.item_type,c.active,greatest(c.activity_at,card.activity) AS activity_at,
  c.body,c.spoiler OR coalesce(card.spoiler,false) AS spoiler,
  c.status,c.finished_on,c.rating,c.edited,c.season,c.episode,coalesce(card.entries,'[]') AS combined,
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
    ELSE greatest(c.activity_at,card.activity,replies.activity) END) AS visible_activity,
  coalesce(replies.comments,'[]') AS comments,
  ${reactionSummary(false)} AS reactions
  FROM ${entries} JOIN profile p ON p.user_id=c.owner_id LEFT JOIN title t ON t.id=c.title_id
  LEFT JOIN LATERAL (
    -- The card's other entries in the author line's order: status, review,
    -- then Recommend or Want to watch.
    SELECT jsonb_agg(jsonb_build_object('id',m.id::text,'item_type',m.item_type,'status',m.status,
        'rating',m.rating,'body',m.body,'spoiler',m.spoiler,'edited',m.edited)
        ORDER BY CASE m.item_type WHEN 'progress' THEN 0 WHEN 'review' THEN 1 ELSE 2 END) AS entries,
      bool_or(m.spoiler) AS spoiler,max(m.activity_at) AS activity
    FROM cards k JOIN ${feedEntries} m ON m.id=k.id WHERE k.holder=c.id AND k.id<>c.id
  ) card ON true
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
      OR (c.item_type='earlier' AND replies.placeholder_activity IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM cards k WHERE k.id=c.id AND k.holder<>c.id)`;
// The cards of every entry the reader ($1) can see that meets `scope`, a
// condition on c such as `c.id=$2::uuid`. An entry in a card reads as the
// card, so a link, reply, or reaction to any of its entries reaches the
// holder. The lateral join, which its OFFSET keeps PostgreSQL from
// flattening, reads each person's entries for a title through their owner
// and title indexes, and the holders through their ID indexes.
export const itemQuery = (
  scope: string,
) => `WITH ${access}, scoped AS MATERIALIZED (
    SELECT DISTINCT c.owner_id,c.title_id FROM ${readableEntries} WHERE ${scope}
  ), cards AS MATERIALIZED (
    SELECT id,holder FROM (${cardsOf(
      `SELECT c.* FROM scoped s CROSS JOIN LATERAL (SELECT * FROM ${feedEntries} c
        WHERE c.owner_id=s.owner_id AND c.title_id=s.title_id AND ${combinable("c")} OFFSET 0) c`,
    )}) k WHERE holder IS NOT NULL
  )
  ${items(readableEntries)} AND (${scope} OR c.id=ANY(ARRAY(SELECT holder FROM cards)))`;

export async function conversations(
  viewer: string,
  filter: { title?: string; owner?: string } = {},
): Promise<FeedItem[]> {
  return (
    await db.query(
      `${itemQuery("($2::text IS NULL OR c.title_id=$2) AND ($3::text IS NULL OR c.owner_id=$3)")}
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
// places every entry, with a card placed once through its holder, which
// reads only entry times, reply authors, and whether close-together entries
// have discussion, and then builds discussions for only the entries it
// sends: the window, and `item`, an entry a link names, wherever it falls,
// or that entry's card. An entry's place is its
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
      SELECT c.id,c.owner_id,c.title_id,c.item_type,c.active,c.created_at,c.activity_at,a.readers
      FROM ${feedEntries} c JOIN audience a ON a.owner_id=c.owner_id
      WHERE $2::text IS NULL OR c.owner_id=$2
    ), carded AS MATERIALIZED (${cardsOf(
      "SELECT id,owner_id,title_id,item_type,active,created_at,activity_at FROM entries",
    )}
    ), replied AS (
      SELECT e.id,max(cm.created_at) FILTER (WHERE cm.removed_at IS NULL) AS at,max(cm.created_at) AS placed
      FROM hidden h,comment cm JOIN entries e ON ${entryOf("cm")}=e.id
      WHERE cm.author_id=ANY(e.readers) AND NOT cm.author_id=ANY(h.users)
      GROUP BY e.id
    ), placed AS MATERIALIZED (
      -- A card is placed once, through its holder, by its newest action or
      -- the holder's replies; its other entries have none.
      SELECT e.id,date_trunc('milliseconds',CASE WHEN e.item_type='earlier' THEN coalesce(r.placed,e.created_at)
        ELSE greatest(e.newest,r.placed) END) AS placed_at
      FROM carded e LEFT JOIN replied r ON r.id=e.id
      WHERE (e.active OR r.at IS NOT NULL) AND (e.holder IS NULL OR e.holder=e.id)
    ), bound AS MATERIALIZED (
      SELECT coalesce($3::timestamptz,
        (SELECT placed_at FROM placed WHERE placed_at<$4::timestamptz
          ORDER BY placed_at DESC LIMIT 1 OFFSET ${pageSize - 1}),
        (SELECT min(placed_at) FROM placed WHERE placed_at<$4::timestamptz),
        nullif($4::timestamptz,'infinity')) AS since
    ), shown AS (
      SELECT p.id FROM placed p,bound b WHERE p.placed_at>=b.since
        OR p.id=coalesce((SELECT holder FROM carded WHERE id=$5::uuid),$5::uuid)
    ), cards AS MATERIALIZED (
      -- The cards among the entries it sends.
      SELECT k.id,k.holder FROM carded k JOIN shown s ON s.id=k.holder
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
// newest action first. An action inside a card names the card, and its time
// is the card's.
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
      .filter(
        (c) =>
          c.active &&
          c.owner_id !== viewer &&
          (c.item_type === type ||
            c.combined.some((entry) => entry.item_type === type)),
      )
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
  const { rows } = await db.query(itemQuery("c.id=$2::uuid"), [viewer, id]);
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

// The item a feed or title page link names, if the reader can see it: the
// card of any entry in one. A missing item or reply makes the target
// unavailable.
export function linkTarget(
  items: FeedItem[],
  { item, reply }: { item?: string; reply?: string },
) {
  const targeted = items.find(
    (c) => c.id === item || c.combined.some((entry) => entry.id === item),
  );
  const targetReply = targeted?.comments.find(
    (c) => c.id === reply && !c.unavailable,
  );
  return {
    target: targeted ? { item: targeted.id, reply: targetReply?.id } : null,
    targetUnavailable: !!item && (!targeted || (!!reply && !targetReply)),
  };
}

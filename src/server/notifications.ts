import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, db, isBigintId, transaction } from "./db";
import { queueBadgePush, trackRelationshipBadges } from "./push";
import { entryPath } from "../member-routes";

type NotificationRow = {
  id: string;
  kind: "friend_request" | "friend_accepted" | "comment" | "reply";
  actor_id: string;
  display_name: string;
  username: string;
  photo: string | null;
  title_id: string | null;
  title_name: string | null;
  item_id: string | null;
  comment_id: string | null;
  created_at: string;
  read_at: string | null;
};

const columns = `id::text,kind,actor_id,display_name,username,
  screenr_photo(actor_id) AS photo,title_id,title_name,
  item_id::text,comment_id::text,created_at,read_at`;

function present(row: NotificationRow) {
  const action =
    row.kind === "friend_request"
      ? "sent you a friend request"
      : row.kind === "friend_accepted"
        ? "became your friend"
        : row.kind === "reply"
          ? "replied to your comment"
          : "commented on your post";
  return {
    id: row.id,
    kind: row.kind,
    actor: row.display_name,
    actorId: row.actor_id,
    actorPhoto: row.photo,
    message: `${row.display_name} ${action}${row.title_name ? ` about ${row.title_name}` : ""}.`,
    // Comments open their reply in the entry's feed; friendships open the
    // person's profile.
    href: row.item_id
      ? entryPath(
          { id: row.item_id, title_id: row.title_id },
          row.comment_id ?? undefined,
        )
      : `/people/${row.username}`,
    createdAt: row.created_at,
    read: row.read_at !== null,
  };
}

function identifier(value: unknown): string {
  if (!isBigintId(value)) throw new AppError("Invalid notification.");
  return value;
}

export async function unreadNotifications(viewer: string) {
  return (
    await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM visible_notification WHERE recipient_id=$1 AND read_at IS NULL",
      [viewer],
    )
  ).rows[0].count;
}

export async function notifications(
  viewer: string,
  before?: string | null,
  unread = false,
  through?: string | null,
) {
  const cursor = before ? identifier(before) : null;
  // Older pages retain the latest displayed page's bulk-read boundary. A bare
  // pagination cursor also must not include newer, undisplayed arrivals.
  const boundary = through ? identifier(through) : cursor;
  // The page and current unread count come from the same database snapshot.
  const result = (
    await db.query<{
      items: NotificationRow[];
      through: string | null;
      unread: number;
    }>(
      `WITH visible AS (SELECT * FROM visible_notification WHERE recipient_id=$1)
       SELECT coalesce($4::bigint,(SELECT max(id) FROM visible))::text AS through,
       (SELECT count(*)::int FROM visible WHERE read_at IS NULL) AS unread,
       coalesce((SELECT jsonb_agg(page ORDER BY id::bigint DESC) FROM (
         SELECT ${columns} FROM visible
         WHERE ($2::bigint IS NULL OR id<$2) AND (NOT $3::boolean OR read_at IS NULL)
         AND ($4::bigint IS NULL OR id<=$4)
         ORDER BY visible.id DESC LIMIT 31
       ) page),'[]') AS items`,
      [viewer, cursor, unread, boundary],
    )
  ).rows[0];
  const hasMore = result.items.length > 30;
  const items = result.items.slice(0, 30).map(present);
  return {
    items,
    through: result.through,
    unread: result.unread,
    next: hasMore ? items.at(-1)!.id : null,
  };
}
export type NotificationPage = Awaited<ReturnType<typeof notifications>>;

export async function readNotification(viewer: string, id: unknown) {
  const notificationId = identifier(id);
  return transaction(async (client) => {
    const row = (
      await client.query<NotificationRow>(
        `SELECT ${columns} FROM visible_notification WHERE recipient_id=$1 AND id=$2`,
        [viewer, notificationId],
      )
    ).rows[0];
    if (!row) throw new AppError("Notification is no longer available.", 404);
    await client.query(
      "UPDATE notification SET read_at=coalesce(read_at,now()),email_pending=false WHERE id=$1",
      [notificationId],
    );
    // Selecting a notification read earlier leaves the badge as it is.
    if (row.read_at === null) await queueBadgePush(viewer, client);
    return { href: present(row).href };
  });
}

// The push alert's excerpt is one line of at most this many characters.
const excerptLength = 160;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Runs of whitespace become one space. Longer text ends at a word with an
// ellipsis, and a cut never splits a character.
function excerpt(body: string) {
  const parts = Array.from(
    graphemes.segment(body.replace(/\s+/g, " ").trim()),
    ({ segment }) => segment,
  );
  if (parts.length <= excerptLength) return parts.join("");
  let end = excerptLength - 1;
  const space = parts.lastIndexOf(" ", end);
  if (parts[end] !== " " && space > end / 2) end = space;
  return `${parts.slice(0, end).join("").trimEnd()}…`;
}

// One notification for the iPhone Notification Service Extension
// (docs/data-and-access.md#single-notification-read). It is the bell's item
// under the same visibility rules, with the comment's excerpt and what a reply
// needs. A spoiler flag on the comment or on its entry omits the excerpt.
// Every notification the viewer cannot see, for any reason, gets the same
// answer. Reading it marks nothing read.
export async function notification(viewer: string, id: unknown) {
  const notificationId = identifier(id);
  const row = (
    await db.query<{
      content:
        | (NotificationRow & { body: string | null; spoiler: boolean | null })
        | null;
    }>(
      `SELECT to_jsonb(content) AS content FROM (
         SELECT n.*,cm.body,cm.spoiler OR coalesce(tc.spoiler,r.spoiler,dp.spoiler,false) AS spoiler
         FROM (SELECT ${columns} FROM visible_notification
           WHERE recipient_id=$1 AND id=$2) n
         LEFT JOIN comment cm ON cm.id=n.comment_id::bigint
         LEFT JOIN title_comment tc ON tc.id=cm.title_comment_id
         LEFT JOIN review r ON r.id=cm.review_id
         LEFT JOIN discussion_post dp ON dp.id=cm.discussion_post_id
       ) content`,
      [viewer, notificationId],
    )
  ).rows[0]?.content;
  if (!row) return { visible: false } as const;
  const spoiler = row.spoiler ?? false;
  return {
    visible: true,
    notification: {
      ...present(row),
      title: row.title_name,
      excerpt: row.body === null || spoiler ? null : excerpt(row.body),
      spoiler,
      // The entry, which groups its notifications and is the `conversation`
      // of a reply; the comment is its `replyTo`.
      thread: row.item_id,
      comment: row.comment_id,
    },
  } as const;
}

// The visible view lists a friend request only while it is pending, so a stale
// Decline cannot end the friendship that an earlier Accept created.
export async function respondToFriendRequest(
  viewer: string,
  id: unknown,
  action: unknown,
) {
  const notificationId = identifier(id);
  if (action !== "accept" && action !== "decline")
    throw new AppError("Unknown friend request action.");
  await transaction(async (client) => {
    const row = (
      await client.query<NotificationRow>(
        `SELECT ${columns} FROM visible_notification
         WHERE recipient_id=$1 AND id=$2 AND kind='friend_request'`,
        [viewer, notificationId],
      )
    ).rows[0];
    if (!row)
      throw new AppError("This friend request is no longer pending.", 404);
    // Answering hides the request, and accepting can restore comments and
    // replies (docs/notifications.md#badge-only-updates).
    const queueBadges = await trackRelationshipBadges(
      client,
      viewer,
      row.actor_id,
    );
    await client.query(
      "UPDATE notification SET read_at=coalesce(read_at,now()),email_pending=false WHERE id=$1",
      [notificationId],
    );
    const pair = `low_id=least($1,$2) AND high_id=greatest($1,$2)
      AND requested_by=$2 AND accepted_at IS NULL`;
    await client.query(
      action === "accept"
        ? `UPDATE friendship SET accepted_at=now() WHERE ${pair}`
        : `DELETE FROM friendship WHERE ${pair}`,
      [viewer, row.actor_id],
    );
    await queueBadges();
  });
}

export async function readAllNotifications(viewer: string, through: unknown) {
  const boundary = identifier(through);
  await transaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE notification SET read_at=now(),email_pending=false
       WHERE recipient_id=$1 AND id<=$2 AND read_at IS NULL
       AND id IN (SELECT id FROM visible_notification WHERE recipient_id=$1)`,
      [viewer, boundary],
    );
    if (rowCount) await queueBadgePush(viewer, client);
  });
}

export async function activityEmail(viewer: string) {
  return (
    await db.query<{ activity_email: boolean }>(
      "SELECT activity_email FROM profile WHERE user_id=$1",
      [viewer],
    )
  ).rows[0].activity_email;
}

export async function saveActivityEmail(viewer: string, enabled: unknown) {
  if (typeof enabled !== "boolean")
    throw new AppError("Choose whether to receive activity emails.");
  await transaction(async (client) => {
    await client.query(
      "UPDATE profile SET activity_email=$2 WHERE user_id=$1",
      [viewer, enabled],
    );
    if (!enabled) {
      await client.query(
        "UPDATE notification SET email_pending=false,email_job_id=NULL WHERE recipient_id=$1",
        [viewer],
      );
      await client.query(
        "UPDATE email_job SET sent_at=now(),payload='' WHERE notification_recipient=$1 AND sent_at IS NULL",
        [viewer],
      );
    }
  });
  return { activityEmail: enabled };
}

// Called only by the existing worker. Notifications themselves are the durable
// pending queue; each due window becomes one retryable job with fixed membership.
export async function queueNotificationEmails(client: PoolClient) {
  const recipient = (
    await client.query<{ recipient_id: string }>(
      `SELECT n.recipient_id FROM notification n JOIN profile p ON p.user_id=n.recipient_id
       WHERE n.email_pending AND p.activity_email
       GROUP BY n.recipient_id HAVING min(n.created_at)<=now()-interval '10 minutes'
       ORDER BY min(n.created_at) LIMIT 1`,
    )
  ).rows[0]?.recipient_id;
  if (!recipient) return;
  const id = randomUUID();
  await client.query(
    `INSERT INTO email_job(id,payload,expires_at,notification_recipient)
     VALUES($1,'',now()+interval '24 hours',$2)`,
    [id, recipient],
  );
  await client.query(
    "UPDATE notification SET email_pending=false,email_job_id=$2 WHERE recipient_id=$1 AND email_pending",
    [recipient, id],
  );
}

export async function notificationEmail(
  client: PoolClient,
  id: string,
  viewer: string,
) {
  const user = (
    await client.query<{ email: string }>(
      `SELECT u.email FROM profile p JOIN "user" u ON u.id=p.user_id
       WHERE p.user_id=$1 AND p.activity_email AND u."emailVerified"`,
      [viewer],
    )
  ).rows[0];
  if (!user) return null;
  const rows = (
    await client.query<NotificationRow>(
      `SELECT ${columns} FROM visible_notification
       WHERE recipient_id=$1 AND email_job_id=$2 AND read_at IS NULL ORDER BY visible_notification.id DESC`,
      [viewer, id],
    )
  ).rows;
  if (!rows.length) return null;
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  const entries = rows.map(present);
  return {
    to: user.email,
    subject: `${entries.length} unread ${entries.length === 1 ? "notification" : "notifications"} on Screenr`,
    text: `${entries.map((entry) => `${entry.message}\n${origin}${entry.href}`).join("\n\n")}\n\nManage activity emails: ${origin}/account`,
  };
}

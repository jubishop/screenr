import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, db, transaction } from "./db";

type NotificationRow = {
  id: string;
  kind: "friend_request" | "friend_accepted" | "comment" | "reply";
  actor_id: string;
  display_name: string;
  username: string;
  title_id: string | null;
  title_name: string | null;
  item_id: string | null;
  comment_id: string | null;
  created_at: string;
  read_at: string | null;
};

const columns = `id::text,kind,actor_id,display_name,username,title_id,title_name,
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
    actor: row.display_name,
    message: `${row.display_name} ${action}${row.title_name ? ` about ${row.title_name}` : ""}.`,
    href: row.title_id
      ? `/titles/${row.title_id.replace(":", "/")}?item=${row.item_id}&reply=${row.comment_id}`
      : `/people/${row.username}`,
    createdAt: row.created_at,
    read: row.read_at !== null,
  };
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AppError("Invalid notification.");
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
) {
  const cursor = before ? identifier(before) : null;
  // The page and its bulk-read boundary come from the same database snapshot.
  const result = (
    await db.query<{
      items: NotificationRow[];
      through: string | null;
      unread: number;
    }>(
      `WITH visible AS (SELECT * FROM visible_notification WHERE recipient_id=$1)
       SELECT (SELECT max(id)::text FROM visible) AS through,
       (SELECT count(*)::int FROM visible WHERE read_at IS NULL) AS unread,
       coalesce((SELECT jsonb_agg(page ORDER BY id::bigint DESC) FROM (
         SELECT ${columns} FROM visible
         WHERE ($2::bigint IS NULL OR id<$2) AND (NOT $3::boolean OR read_at IS NULL)
         ORDER BY visible.id DESC LIMIT 31
       ) page),'[]') AS items`,
      [viewer, cursor, unread],
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
    return { href: present(row).href };
  });
}

export async function readAllNotifications(viewer: string, through: unknown) {
  const boundary = identifier(through);
  await transaction(async (client) => {
    await client.query(
      `UPDATE notification SET read_at=now(),email_pending=false
       WHERE recipient_id=$1 AND id<=$2 AND read_at IS NULL
       AND id IN (SELECT id FROM visible_notification WHERE recipient_id=$1)`,
      [viewer, boundary],
    );
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

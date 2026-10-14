import type { PoolClient } from "pg";
import type { Apns } from "./apns";
import { AppError, db } from "./db";
import { logFailure } from "./log";

// iPhone push devices and per-kind push settings
// (docs/data-and-access.md#push-devices-and-settings), and the worker's
// delivery of push jobs (docs/notifications.md#push-delivery).

type Queryable = Pick<PoolClient, "query">;

// The bundle IDs of the app's Dev and Release builds, which APNs requests
// name as their topic.
export const pushTopics = [
  "com.artisanalsoftware.Screenr",
  "com.artisanalsoftware.Screenr.dev",
] as const;
export type PushTopic = (typeof pushTopics)[number];
export type PushEnvironment = "sandbox" | "production";
export type PushDevice = {
  token: string;
  environment: PushEnvironment;
  topic: PushTopic;
  build: number;
};

// Each notification kind's setting: its key in the account payload and the
// push-settings action, and its profile column.
const settings = {
  friend_request: ["friendRequest", "push_friend_request"],
  friend_accepted: ["friendAccepted", "push_friend_accepted"],
  comment: ["comment", "push_comment"],
  reply: ["reply", "push_reply"],
} as const;
export type PushKind = keyof typeof settings;
type SettingKey = (typeof settings)[PushKind][0];
export type PushSettings = Record<SettingKey, boolean>;

const selectSettings = Object.values(settings)
  .map(([key, column]) => `${column} AS "${key}"`)
  .join(",");
// Whether profile `p` allows pushes of notification `n`'s kind.
const kindAllowed = `CASE n.kind ${Object.entries(settings)
  .map(([kind, [, column]]) => `WHEN '${kind}' THEN p.${column}`)
  .join(" ")} END`;
// Devices `d` whose session `s` is live. Signing out deletes the device; an
// expired session that remains stored receives nothing.
const liveSession = `JOIN session s ON s.id=d.session_id AND s."expiresAt">now()`;

// APNs tokens are 32 bytes today; Apple allows them to grow.
function deviceToken(value: unknown) {
  if (typeof value !== "string" || !/^([0-9a-f]{2}){32,100}$/i.test(value))
    throw new AppError("Invalid push device token.");
  return value.toLowerCase();
}

// Registers the app on the member's current session, or refreshes its build
// and last-seen time. A token belongs to one app on one phone, so it moves to
// the session that registers it last. The session's earlier token for the
// same app, which APNs replaced, is deleted.
async function registerPushDevice(
  userId: string,
  sessionId: string,
  fields: Record<string, unknown>,
) {
  const token = deviceToken(fields.token);
  const { environment, topic, build } = fields;
  if (environment !== "sandbox" && environment !== "production")
    throw new AppError("Unknown push environment.");
  if (!pushTopics.includes(topic as PushTopic))
    throw new AppError("Unknown app bundle ID.");
  if (
    typeof build !== "number" ||
    !Number.isInteger(build) ||
    build < 1 ||
    build >= 2 ** 31
  )
    throw new AppError("Invalid app build.");
  await db.query(
    `WITH replaced AS (
      DELETE FROM push_device WHERE session_id=$3 AND topic=$5 AND token<>$1
    )
    INSERT INTO push_device(token,user_id,session_id,environment,topic,build)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT (token) DO UPDATE SET user_id=excluded.user_id,
      session_id=excluded.session_id,environment=excluded.environment,
      topic=excluded.topic,build=excluded.build,last_seen_at=now()`,
    [token, userId, sessionId, environment, topic, build],
  );
}

// The push-device action: `register` or `remove` the app's token. Removing
// affects only the member's own devices.
export async function changePushDevice(
  userId: string,
  sessionId: string,
  fields: Record<string, unknown>,
) {
  if (fields.action === "register")
    return registerPushDevice(userId, sessionId, fields);
  if (fields.action !== "remove")
    throw new AppError("Unknown push device action.");
  await db.query("DELETE FROM push_device WHERE token=$1 AND user_id=$2", [
    deviceToken(fields.token),
    userId,
  ]);
}

// The member's devices on live sessions. With a kind, only when the member
// allows pushes of that kind.
export async function pushDevices(
  userId: string,
  kind?: PushKind,
  client: Queryable = db,
) {
  const allowed = kind ? `AND p.${settings[kind][1]}` : "";
  return (
    await client.query<PushDevice>(
      `SELECT d.token,d.environment,d.topic,d.build FROM push_device d
      ${liveSession} JOIN profile p ON p.user_id=d.user_id
      WHERE d.user_id=$1 ${allowed} ORDER BY d.token`,
      [userId],
    )
  ).rows;
}

// Deletes a token that APNs reports no longer reaches the app, with status
// 410 or a 400 that rejects the token itself. Its pending jobs go with it.
export async function removePushDevice(token: string, client: Queryable = db) {
  await client.query("DELETE FROM push_device WHERE token=$1", [token]);
}

export async function pushSettings(userId: string) {
  return (
    await db.query<PushSettings>(
      `SELECT ${selectSettings} FROM profile WHERE user_id=$1`,
      [userId],
    )
  ).rows[0];
}

// Saves the kinds the request names; the others keep their values.
export async function savePushSettings(
  userId: string,
  fields: Partial<Record<SettingKey, unknown>>,
) {
  const changes = Object.values(settings).filter(
    ([key]) => fields[key] !== undefined,
  );
  if (
    !changes.length ||
    changes.some(([key]) => typeof fields[key] !== "boolean")
  )
    throw new AppError(
      "Choose whether to receive each kind of push notification.",
    );
  const saved = await db.query<PushSettings>(
    `UPDATE profile SET ${changes
      .map(([, column], index) => `${column}=$${index + 2}`)
      .join(",")} WHERE user_id=$1 RETURNING ${selectSettings}`,
    [userId, ...changes.map(([key]) => fields[key])],
  );
  return { pushSettings: saved.rows[0] };
}

// Queues a badge-only push with the member's current unread count to each of
// their devices. Call it in the transaction that changes read state, so the
// worker counts after it commits. A device that already has an update waiting
// for its first attempt needs no second one.
export async function queueBadgePush(userId: string, client: Queryable = db) {
  await client.query(
    `INSERT INTO push_job(token)
    SELECT d.token FROM push_device d WHERE d.user_id=$1 AND NOT EXISTS (
      SELECT 1 FROM push_job j
      WHERE j.token=d.token AND j.notification_id IS NULL AND j.attempts=0)`,
    [userId],
  );
}

type PushJob = {
  id: string;
  attempts: number;
  expires: number;
  token: string;
  environment: PushEnvironment;
  topic: PushTopic;
  notification: string | null;
  kind: PushKind | null;
  thread: string | null;
  // The device member's unread count, or null when the push must not be sent.
  badge: number | null;
};

const alert = { body: "New activity on Screenr" };
// The app registers these categories with the notification actions: Accept
// and Decline for friend requests, and Reply for comments and replies.
const categories: Partial<Record<PushKind, string>> = {
  friend_request: "FRIEND_REQUEST",
  comment: "COMMENT",
  reply: "COMMENT",
};

// An alert carries only the notification ID and plays the default sound; the
// app's extension fetches what it shows. A badge-only update carries only the
// count, silently.
function payload(job: PushJob) {
  if (!job.notification) return { aps: { badge: job.badge } };
  const category = categories[job.kind!];
  return {
    aps: {
      alert,
      badge: job.badge,
      sound: "default",
      "mutable-content": 1,
      ...(category && { category }),
      ...(job.thread && { "thread-id": job.thread }),
    },
    notificationId: job.notification,
  };
}

const finish = (id: string) =>
  db.query("DELETE FROM push_job WHERE id=$1", [id]);

async function deliver(apns: Apns, job: PushJob) {
  if (job.badge === null) return finish(job.id);
  const { result, status, reason, error } = await apns.send({
    token: job.token,
    environment: job.environment,
    topic: job.topic,
    payload: payload(job),
    // Badge updates defer to the phone's power use.
    priority: job.notification ? 10 : 5,
    expiration: job.expires,
    collapseId: job.notification ?? undefined,
  });
  if (result === "sent") return finish(job.id);
  if (result === "unregistered") return removePushDevice(job.token);
  const final = result === "rejected";
  logFailure(
    "push delivery failed",
    {
      job: job.id,
      kind: job.notification ? "alert" : "badge",
      environment: job.environment,
      attempt: job.attempts,
      status,
      reason,
      final,
    },
    error,
  );
  if (final) return finish(job.id);
  await db.query(
    `UPDATE push_job SET last_error=$2,
    available_at=now()+least(60,power(2,least(attempts,6))) * interval '1 second'
    WHERE id=$1`,
    [
      job.id,
      status
        ? `APNs ${status}${reason ? ` ${reason}` : ""}`
        : ((error as { code?: string } | undefined)?.code ??
          (error instanceof Error ? error.name : "Delivery failed")),
    ],
  );
}

// Sends up to `limit` due pushes at once and returns how many it claimed.
// Claiming leases each job for a minute, so a worker that stops mid-send
// retries it later; the collapse ID keeps a repeated alert from showing
// twice. An alert goes only while its notification is visible to and unread
// by the device's current member, and that member allows its kind.
export async function deliverPushes(apns: Apns, limit = 50) {
  const jobs = (
    await db.query<PushJob>(
      `WITH claimed AS (
        UPDATE push_job SET attempts=attempts+1,available_at=now()+interval '1 minute'
        WHERE id IN (SELECT id FROM push_job
          WHERE available_at<=now() AND expires_at>now()
          ORDER BY available_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id,token,notification_id,attempts,expires_at
      )
      SELECT c.id::text,c.attempts,extract(epoch FROM c.expires_at)::bigint AS expires,
        d.token,d.environment,d.topic,c.notification_id::text AS notification,
        n.kind,n.item_id::text AS thread,
        CASE WHEN s.id IS NOT NULL AND (c.notification_id IS NULL
          OR (n.id IS NOT NULL AND n.read_at IS NULL AND ${kindAllowed}))
        THEN (SELECT count(*)::int FROM visible_notification v
          WHERE v.recipient_id=d.user_id AND v.read_at IS NULL) END AS badge
      FROM claimed c JOIN push_device d ON d.token=c.token
      JOIN profile p ON p.user_id=d.user_id
      LEFT ${liveSession}
      LEFT JOIN visible_notification n
        ON n.id=c.notification_id AND n.recipient_id=d.user_id`,
      [limit],
    )
  ).rows;
  await Promise.all(jobs.map((job) => deliver(apns, job)));
  return jobs.length;
}

// One pass of the worker's push loop, which sends only with APNs settings.
// The first pass and every 60th also delete expired jobs.
export async function runPushPass(apns: Apns | null, pass: number) {
  try {
    if (pass % 60 === 0)
      await db.query("DELETE FROM push_job WHERE expires_at<=now()");
    if (apns) await deliverPushes(apns);
  } catch (error) {
    logFailure("worker failed", {}, error);
  }
}

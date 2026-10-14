import type { PoolClient } from "pg";
import { AppError, db } from "./db";

// iPhone push devices and per-kind push settings
// (docs/data-and-access.md#push-devices-and-settings).

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
      JOIN session s ON s.id=d.session_id AND s."expiresAt">now()
      JOIN profile p ON p.user_id=d.user_id
      WHERE d.user_id=$1 ${allowed} ORDER BY d.token`,
      [userId],
    )
  ).rows;
}

// Deletes a token that APNs reports is no longer valid (status 410).
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

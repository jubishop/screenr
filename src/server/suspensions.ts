import type { PoolClient } from "pg";
import { AppError, db } from "./db";
import { trackErasureBadges } from "./push";

// The owner's suspension of a member (docs/data-and-access.md#member-suspension).
// A suspended member's sessions end and sign-in refuses them, and the shared
// access rule, screenr_blocked, hides them and everything they wrote from
// everyone. Their data stays, so lifting the suspension restores all of it.
// The owner's review page reaches these through src/server/reports.ts.

export async function isSuspended(userId: string) {
  return !!(
    await db.query("SELECT 1 FROM member_suspension WHERE user_id=$1", [userId])
  ).rowCount;
}

// Suspends `userId` in the caller's domain write transaction and ends every
// session they have, on the web and in the iPhone app, with the push devices
// those sessions registered. It holds the account's row until it commits,
// which a new session waits for (db/043-member-suspension.sql), so a sign-in
// already past its check can't keep a session. Suspending again changes
// nothing more.
export async function suspend(client: PoolClient, userId: string) {
  await client.query('SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
  // Other members' unread notifications from them, or about replies on their
  // entries, leave their badges.
  const queueBadges = await trackErasureBadges(client, [userId]);
  await client.query(
    "INSERT INTO member_suspension(user_id) VALUES($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  await client.query('DELETE FROM session WHERE "userId"=$1', [userId]);
  // Like a block, suspension hides notifications from other members'
  // activity email, so an email being sent now becomes stale
  // (docs/notifications.md#activity-email-sends-without-the-write-lock--2026-11-01).
  await client.query(
    "UPDATE email_job SET generation=generation+1 WHERE notification_recipient IS NOT NULL AND sent_at IS NULL",
  );
  await queueBadges();
}

// Lifts the suspension of `userId` in the caller's domain write transaction,
// which shows them and their content again. They sign in again themselves.
export async function lift(client: PoolClient, userId: string) {
  const queueBadges = await trackErasureBadges(client, [userId]);
  const { rowCount } = await client.query(
    "DELETE FROM member_suspension WHERE user_id=$1",
    [userId],
  );
  if (!rowCount) throw new AppError("Suspension not found.", 404);
  await queueBadges();
}

export type SuspendedMember = {
  user_id: string;
  username: string;
  display_name: string;
  suspended_at: string;
};

// Suspended members, most recently suspended first.
export async function suspendedMembers(): Promise<SuspendedMember[]> {
  const { rows } = await db.query<
    Omit<SuspendedMember, "suspended_at"> & { suspended_at: Date }
  >(
    `SELECT p.user_id,p.username,p.display_name,s.created_at AS suspended_at
    FROM member_suspension s JOIN profile p ON p.user_id=s.user_id
    ORDER BY s.created_at DESC,p.username`,
  );
  return rows.map((row) => ({
    ...row,
    suspended_at: row.suspended_at.toISOString(),
  }));
}

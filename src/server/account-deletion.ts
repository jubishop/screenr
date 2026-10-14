import type { PoolClient } from "pg";
import { revokeAppleTokens } from "./apple";
import { AppError, db, transaction } from "./db";
import { codeRecipientHash, codeTypes } from "./email";
import { logFailure } from "./log";

// Members delete their own account from Account on the web and from the
// iPhone app (docs/data-and-access.md#account-deletion), under the account
// deletion decision in docs/product-brief.md.

// Deletion needs a session created in the last ten minutes: the web signs in
// again with an email code on Account, and the app with any sign-in method.
// Better Auth's freshAge uses the same window.
export const freshSignInSeconds = 10 * 60;

export async function deleteAccount(userId: string, sessionId: string) {
  const fresh = await db.query(
    `SELECT 1 FROM session WHERE id=$1 AND "userId"=$2
    AND "createdAt">now()-make_interval(secs=>$3)`,
    [sessionId, userId, freshSignInSeconds],
  );
  if (!fresh.rowCount)
    throw new AppError(
      "To delete your account, confirm it’s you again with a new sign-in.",
      403,
    );
  // Apple requires revoking Sign in with Apple when an account is deleted.
  // The tokens live in the account rows that deletion erases, so when Apple
  // does not confirm, nothing is erased and the member can try again.
  try {
    await revokeAppleTokens(userId);
  } catch (error) {
    logFailure("apple revoke failed", {}, error);
    throw new AppError(
      "Sign in with Apple could not be disconnected, so your account was not deleted. Please try again later.",
      503,
    );
  }
  await transaction((client) => eraseAccounts(client, [userId]));
  journalDeletion(userId);
}

// Each deletion prints one line, naming only the user ID, to the journal.
// After a restore from a backup taken earlier, the restore runbook finds
// these lines and erases the accounts again with redeleteAccounts
// (docs/restore-and-patching.md#repeat-account-deletions).
function journalDeletion(userId: string) {
  console.log(JSON.stringify({ event: "account deleted", userId }));
}

// Erases again the accounts that a restore brought back. Apple revocation
// already succeeded before each original deletion. Returns how many of the
// accounts existed.
export async function redeleteAccounts(ids: string[]) {
  return transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE id=ANY($1)',
      [ids],
    );
    await eraseAccounts(
      client,
      rows.map((row) => row.id),
    );
    return rows.length;
  });
}

// Erases these people and every row that refers to them, in the caller's
// transaction. Their entries go with whole conversations. A comment of
// theirs that has someone else's remaining reply becomes an authorless
// "Comment removed" placeholder, so the replies stay. Demo circle seeding
// also uses this to remove the previous circle.
export async function eraseAccounts(client: PoolClient, ids: string[]) {
  const emails = (
    await client.query<{ email: string }>(
      'SELECT email FROM "user" WHERE id=ANY($1)',
      [ids],
    )
  ).rows.map((row) => row.email);
  for (const statement of [
    `DELETE FROM comment
      WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_id=ANY($1))
      OR discussion_post_id IN (SELECT id FROM discussion_post WHERE owner_id=ANY($1))`,
    `UPDATE comment cm SET author_id=NULL,body='[removed]',removed_at=coalesce(removed_at,now())
      WHERE author_id=ANY($1) AND root_id IS NULL AND EXISTS (
        SELECT 1 FROM comment reply WHERE reply.root_id=cm.id
          AND reply.author_id<>ALL($1) AND reply.removed_at IS NULL)`,
    // Their other comments, with any removed replies beneath them.
    `DELETE FROM comment WHERE author_id=ANY($1)
      OR root_id IN (SELECT id FROM comment WHERE author_id=ANY($1))`,
    "UPDATE comment SET addressed_id=NULL WHERE addressed_id=ANY($1)",
    "DELETE FROM feed_item WHERE owner_id=ANY($1)",
    "DELETE FROM review WHERE owner_id=ANY($1)",
    "DELETE FROM watch_progress WHERE owner_id=ANY($1)",
    "DELETE FROM title_comment WHERE owner_id=ANY($1)",
    "DELETE FROM discussion_post WHERE owner_id=ANY($1)",
    "DELETE FROM top_ten WHERE owner_id=ANY($1)",
    "DELETE FROM conversation WHERE owner_id=ANY($1)",
    "DELETE FROM friendship WHERE low_id=ANY($1) OR high_id=ANY($1)",
    "DELETE FROM block WHERE blocker_id=ANY($1) OR blocked_id=ANY($1)",
    // Their invitations, with the signup records of people who joined
    // through them; those members keep their accounts.
    `DELETE FROM invitation_signup WHERE user_id=ANY($1)
      OR invitation_id IN (SELECT id FROM invitation WHERE creator_id=ANY($1))`,
    "DELETE FROM invitation WHERE creator_id=ANY($1)",
    // Better Auth's pending codes and sign-in states name the address or ID.
    `DELETE FROM verification v USING "user" u WHERE u.id=ANY($1)
      AND (strpos(lower(v.identifier),lower(u.email))>0
        OR strpos(lower(v.value),lower(u.email))>0 OR strpos(v.value,u.id)>0)`,
    // The profile, photo, sessions, push devices, sign-in accounts, saved
    // services, notifications, reactions, usage rows, and activity emails
    // cascade.
    'DELETE FROM "user" WHERE id=ANY($1)',
  ])
    await client.query(statement, [ids]);
  // Queued code emails name their recipient only by a hash of the address.
  await client.query("DELETE FROM email_job WHERE recipient_hash=ANY($1)", [
    emails.flatMap((email) =>
      codeTypes.map((type) => codeRecipientHash(type, email)),
    ),
  ]);
}

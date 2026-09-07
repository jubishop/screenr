import { createHash, createHmac, randomUUID } from "node:crypto";
import { db, transaction, AppError, text } from "./db";

export const invitationHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function shareToken(id: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Set BETTER_AUTH_SECRET to at least 32 random characters.");
  // Reproduce the creator's link without storing a bearer token in the database.
  return createHmac("sha256", secret)
    .update(`screenr-invitation:${id}`)
    .digest("base64url");
}

export async function activeInvitation(hash: string) {
  const { rows } = await db.query(
    `SELECT id FROM invitation WHERE (token_hash = $1 OR share_token_hash = $1) AND revoked_at IS NULL
     AND expires_at > now() AND uses < max_uses`,
    [hash],
  );
  return rows[0] as { id: string } | undefined;
}

export async function createInvitation(
  creator: string | null,
  limit: unknown = 1,
) {
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 12) {
    throw new AppError("Choose between 1 and 12 signups.");
  }
  const id = randomUUID();
  const token = shareToken(id);
  await transaction(async (client) => {
    if (
      creator &&
      !(await client.query("SELECT 1 FROM profile WHERE user_id=$1", [creator]))
        .rowCount
    ) {
      throw new AppError("Complete your profile first.", 403);
    }
    await client.query(
      "INSERT INTO invitation(id,token_hash,creator_id,max_uses) VALUES($1,$2,$3,$4)",
      [id, invitationHash(token), creator, limit],
    );
  });
  return { id, token };
}

export async function completeSignup(
  userId: string,
  name: unknown,
  username: unknown,
  currentToken?: string,
) {
  const displayName = text(name, "Display name", 60);
  const handle = text(username, "Username", 24).toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(handle))
    throw new AppError(
      "Use 3–24 letters, numbers, or underscores for your username.",
    );
  return transaction(async (client) => {
    if (
      (await client.query("SELECT 1 FROM profile WHERE user_id=$1", [userId]))
        .rowCount
    )
      return;
    const user = (
      await client.query(
        'SELECT "emailVerified", "invitationHash" FROM "user" WHERE id=$1 FOR UPDATE',
        [userId],
      )
    ).rows[0];
    if (!user?.emailVerified)
      throw new AppError("Verify your email before joining.", 403);
    const hash = currentToken
      ? invitationHash(currentToken)
      : user.invitationHash;
    const invite = (
      await client.query(
        `UPDATE invitation SET uses=uses+1 WHERE (token_hash=$1 OR share_token_hash=$1) AND revoked_at IS NULL
       AND expires_at>now() AND uses<max_uses RETURNING id`,
        [hash],
      )
    ).rows[0];
    if (!invite)
      throw new AppError(
        "This invitation is no longer available. Ask for a new link.",
        403,
      );
    try {
      await client.query(
        "INSERT INTO profile(user_id,username,display_name) VALUES($1,$2,$3)",
        [userId, handle, displayName],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new AppError("That username is already taken.");
      throw error;
    }
    await client.query(
      "INSERT INTO invitation_signup(invitation_id,user_id) VALUES($1,$2)",
      [invite.id, userId],
    );
    await client.query('UPDATE "user" SET "invitationHash"=$1 WHERE id=$2', [
      hash,
      userId,
    ]);
  });
}

export async function listInvitations(userId: string) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.id,i.max_uses,i.uses,i.expires_at,i.token_hash,i.share_token_hash,
      coalesce((SELECT jsonb_agg(jsonb_build_object('username',p.username,'display_name',p.display_name))
        FROM invitation_signup s JOIN profile p ON p.user_id=s.user_id
        WHERE s.invitation_id=i.id AND NOT screenr_blocked($1,p.user_id)), '[]') AS joined
     FROM invitation i WHERE creator_id=$1 AND revoked_at IS NULL
     AND expires_at>now() AND uses<max_uses ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    const invitations = [];
    for (const { token_hash, share_token_hash, ...invitation } of rows) {
      const token = shareToken(invitation.id);
      const hash = invitationHash(token);
      // Legacy tokens cannot be recovered. Add a second URL for the same row,
      // preserving the original URL, pending signups, usage, and expiry.
      if (hash !== token_hash && hash !== share_token_hash)
        await client.query(
          "UPDATE invitation SET share_token_hash=$1 WHERE id=$2",
          [hash, invitation.id],
        );
      invitations.push({
        ...invitation,
        url: new URL(`/join/${token}`, process.env.BETTER_AUTH_URL!).href,
      });
    }
    return invitations;
  });
}

export async function revokeInvitation(userId: string, id: string) {
  await transaction(async (client) => {
    const result = await client.query(
      "UPDATE invitation SET revoked_at=coalesce(revoked_at,now()) WHERE id::text=$1 AND creator_id=$2",
      [id, userId],
    );
    if (!result.rowCount) throw new AppError("Invitation not found.", 404);
  });
}

import { AppError, db, displayNameText, transaction, usernameText } from "./db";
import type { Person } from "../shared";

export async function member(userId: string): Promise<Person> {
  const profile = (
    await db.query(
      "SELECT user_id,username,display_name,screenr_photo(user_id) AS photo FROM profile WHERE user_id=$1",
      [userId],
    )
  ).rows[0];
  if (!profile) throw new AppError("Complete your profile first.", 403);
  return profile;
}
export async function updateDisplayName(
  userId: string,
  name: unknown,
): Promise<Person> {
  const displayName = displayNameText(name);
  return transaction(async (client) => {
    const { rows } = await client.query<Person>(
      "UPDATE profile SET display_name=$2 WHERE user_id=$1 RETURNING user_id,username,display_name,screenr_photo(user_id) AS photo",
      [userId, displayName],
    );
    if (!rows[0]) throw new AppError("Complete your profile first.", 403);
    return rows[0];
  });
}
export async function updateProfile(
  userId: string,
  name: unknown,
  username: unknown,
): Promise<Person> {
  const displayName = displayNameText(name);
  const handle = usernameText(username);
  return transaction(async (client) => {
    try {
      const { rows } = await client.query<Person>(
        "UPDATE profile SET display_name=$2,username=$3 WHERE user_id=$1 RETURNING user_id,username,display_name,screenr_photo(user_id) AS photo",
        [userId, displayName, handle],
      );
      if (!rows[0]) throw new AppError("Complete your profile first.", 403);
      return rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new AppError("That username is already taken.");
      throw error;
    }
  });
}
export async function profileFor(viewer: string, username: string) {
  const profile = (
    await db.query<
      Person & {
        can_read: boolean;
        requested_by: string | null;
        accepted_at: Date | null;
        friends: Person[];
      }
    >(
      `SELECT p.user_id,p.username,p.display_name,screenr_photo(p.user_id) AS photo,
    screenr_can_read($1,p.user_id) AS can_read,
    f.requested_by,f.accepted_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'user_id',friend.user_id,'username',friend.username,'display_name',friend.display_name,
      'photo',screenr_photo(friend.user_id)
    ) ORDER BY friend.username)
      FROM friendship accepted JOIN profile friend
        ON friend.user_id=CASE WHEN accepted.low_id=p.user_id THEN accepted.high_id ELSE accepted.low_id END
      WHERE p.user_id IN (accepted.low_id,accepted.high_id) AND accepted.accepted_at IS NOT NULL
        AND NOT screenr_blocked($1,friend.user_id)
        AND NOT screenr_blocked(p.user_id,friend.user_id)), '[]'::jsonb) AS friends
    FROM profile p LEFT JOIN friendship f
    ON f.low_id=least($1,p.user_id) AND f.high_id=greatest($1,p.user_id)
    WHERE p.username=$2 AND NOT screenr_blocked($1,p.user_id)`,
      [viewer, username.toLowerCase()],
    )
  ).rows[0];
  if (!profile) throw new AppError("Person not found.", 404);
  return profile;
}

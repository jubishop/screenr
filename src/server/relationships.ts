import { AppError, db, transaction } from "./db";
import type { Person } from "../shared";

export async function people(viewer: string) {
  const connections = (
    await db.query<Person & { requested_by: string; accepted_at: Date | null }>(
      `SELECT p.user_id,p.username,p.display_name,screenr_photo(p.user_id) AS photo,
    f.requested_by,f.accepted_at
    FROM friendship f JOIN profile p ON p.user_id=CASE WHEN f.low_id=$1 THEN f.high_id ELSE f.low_id END
    WHERE $1 IN (f.low_id,f.high_id) AND NOT screenr_blocked($1,p.user_id) ORDER BY p.username`,
      [viewer],
    )
  ).rows;
  // Blocking hides the profile, and with it the photo.
  const blocked = (
    await db.query<Person>(
      `SELECT p.user_id,p.username,p.display_name,NULL AS photo FROM block b
    JOIN profile p ON p.user_id=b.blocked_id WHERE b.blocker_id=$1 ORDER BY p.username`,
      [viewer],
    )
  ).rows;
  const suggestions = (
    await db.query<Person & { mutual_friends: Person[] }>(
      `WITH direct AS (
        SELECT p.user_id,p.username,p.display_name
        FROM friendship f JOIN profile p
          ON p.user_id=CASE WHEN f.low_id=$1 THEN f.high_id ELSE f.low_id END
        WHERE $1 IN (f.low_id,f.high_id) AND f.accepted_at IS NOT NULL
          AND NOT screenr_blocked($1,p.user_id)
      )
      SELECT candidate.user_id,candidate.username,candidate.display_name,
        screenr_photo(candidate.user_id) AS photo,
        jsonb_agg(jsonb_build_object(
          'user_id',mutual.user_id,'username',mutual.username,'display_name',mutual.display_name,
          'photo',screenr_photo(mutual.user_id)
        ) ORDER BY mutual.username) AS mutual_friends
      FROM direct mutual JOIN friendship f
        ON mutual.user_id IN (f.low_id,f.high_id) AND f.accepted_at IS NOT NULL
      JOIN profile candidate
        ON candidate.user_id=CASE WHEN f.low_id=mutual.user_id THEN f.high_id ELSE f.low_id END
      WHERE candidate.user_id<>$1
        AND NOT screenr_blocked($1,candidate.user_id)
        AND NOT screenr_blocked(mutual.user_id,candidate.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM friendship existing
          WHERE existing.low_id=least($1,candidate.user_id)
            AND existing.high_id=greatest($1,candidate.user_id)
        )
      GROUP BY candidate.user_id,candidate.username,candidate.display_name
      ORDER BY count(*) DESC,candidate.username`,
      [viewer],
    )
  ).rows;
  return { connections, blocked, suggestions };
}
export async function changeRelationship(
  viewer: string,
  target: string,
  action: string,
) {
  if (!["request", "accept", "remove", "block", "unblock"].includes(action))
    throw new AppError("Unknown friendship action.");
  if (viewer === target) throw new AppError("Choose another person.");
  await transaction(async (client) => {
    if (
      !(await client.query("SELECT 1 FROM profile WHERE user_id=$1", [target]))
        .rowCount
    )
      throw new AppError("Person not found.", 404);
    const pair = [viewer, target];
    if (action === "block") {
      await client.query(
        "INSERT INTO block(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [viewer, target],
      );
      await client.query(
        "DELETE FROM friendship WHERE low_id=least($1,$2) AND high_id=greatest($1,$2)",
        pair,
      );
    } else if (action === "unblock") {
      await client.query(
        "DELETE FROM block WHERE blocker_id=$1 AND blocked_id=$2",
        [viewer, target],
      );
    } else if (action === "remove") {
      await client.query(
        "DELETE FROM friendship WHERE low_id=least($1,$2) AND high_id=greatest($1,$2)",
        pair,
      );
    } else {
      if (
        (
          await client.query("SELECT screenr_blocked($1,$2) AS blocked", [
            viewer,
            target,
          ])
        ).rows[0].blocked
      )
        throw new AppError("Person not found.", 404);
      if (action === "request") {
        await client.query(
          "INSERT INTO friendship(low_id,high_id,requested_by) VALUES(least($1,$2),greatest($1,$2),$3) ON CONFLICT DO NOTHING",
          [...pair, viewer],
        );
      } else {
        const result = await client.query(
          "UPDATE friendship SET accepted_at=now() WHERE low_id=least($1,$2) AND high_id=greatest($1,$2) AND requested_by=$3 AND accepted_at IS NULL",
          [...pair, target],
        );
        if (!result.rowCount)
          throw new AppError("Friend request not found.", 404);
      }
    }
  });
}

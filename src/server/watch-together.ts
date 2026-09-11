import { AppError, db } from "./db";
import type { Person, Title } from "../shared";
import { withViewingOptions } from "./title-viewing";
import { matchingServices, viewingAccess } from "../viewing";

export async function watchTogether(viewer: string, usernames: string[]) {
  const names = usernames.map((name) => name.toLowerCase());
  if (!names.length || new Set(names).size !== names.length)
    throw new AppError("Watch together not found.", 404);

  // Check every participant and read their intersection in one snapshot.
  // The query accepts a set of people; the current page exposes one friend.
  const { rows } = await db.query<{
    participants: Person[];
    titles: Title[];
  }>(
    `WITH participants AS (
      SELECT user_id,username,display_name FROM profile
      WHERE user_id=$1 OR username=ANY($2::text[])
    ), eligible AS (
      SELECT count(*)=cardinality($2::text[])+1
        AND bool_and(screenr_can_read($1,user_id)) AS allowed
      FROM participants
    ), matches AS (
      SELECT f.title_id,max(f.activity_at) AS shared_at
      FROM feed_item f JOIN participants p ON p.user_id=f.owner_id
      CROSS JOIN eligible e
      WHERE e.allowed AND f.item_type='want_to_watch' AND f.active
      GROUP BY f.title_id
      HAVING count(*)=(SELECT count(*) FROM participants)
    ), titles AS (
      SELECT t.id,t.kind,t.tmdb_id,t.name,t.overview,t.poster_path,t.release_date,m.shared_at
      FROM title t JOIN matches m ON m.title_id=t.id
    )
    SELECT
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id<>$1,p.username)
        FROM participants p) AS participants,
      (SELECT coalesce(jsonb_agg(to_jsonb(t)-'shared_at'
        ORDER BY t.shared_at DESC,lower(t.name),t.id),'[]'::jsonb)
        FROM titles t) AS titles
    FROM eligible WHERE allowed`,
    [viewer, names],
  );
  if (!rows[0]) throw new AppError("Watch together not found.", 404);
  const { participants, titles } = rows[0];
  const { rows: services } = await db.query<{ service_id: string }>(
    "SELECT DISTINCT service_id FROM member_streaming_service WHERE user_id=ANY($1::text[])",
    [participants.map((person) => person.user_id)],
  );
  const serviceIds = services.map((service) => service.service_id);
  return {
    participants,
    titles: (await withViewingOptions(titles)).map((title) => ({
      ...title,
      access: viewingAccess(title.viewing, serviceIds),
      // Expose only services matching a shared title, not a friend's full list.
      matchingServiceIds: matchingServices(title.viewing, serviceIds),
    })),
  };
}

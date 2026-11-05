import { db } from "./db";
import { titleObject } from "./catalog";
import { viewerStatus } from "./feed";
import { findListLimit, myServicesFilter } from "./title-viewing";
import type { FriendsRecommendation, Title } from "../shared";

// Titles that the viewer's current, unblocked direct friends actively
// recommend. Scores use integer twentieths so rank weights stay exact: a
// Recommend contributes 20, or 40 - rank when it is in the friend's profile
// top 10 (docs/profile-top-ten.md#ranking). Ties break on the most recent
// recommendation, then the title name and ID. Friends with a top 10 rank are
// named first, best rank first, then newest first. The viewer's own status
// and Recommend never hide a title.
//
// Find a title lists the top titles that pass its filters: `type`, `services`
// (the TMDB providers of the viewer's saved services, for My services), and
// `hideFinished`, which leaves out titles the viewer marked Finished. Along
// with them come how many titles pass every filter, the list's length before
// its cap, and how many titles passing the other filters the viewer
// finished, so an empty list can say Show finished would list them.
export async function friendsRecommend(
  viewer: string,
  {
    type = null,
    services = null,
    hideFinished = false,
  }: {
    type?: Title["kind"] | null;
    services?: number[] | null;
    hideFinished?: boolean;
  } = {},
): Promise<{
  titles: FriendsRecommendation[];
  total: number;
  finished: number;
}> {
  const params: unknown[] = [viewer, type, hideFinished, findListLimit];
  const { rows } = await db.query<{
    titles: FriendsRecommendation[];
    total: number;
    finished: number;
  }>(
    `WITH direct_friends AS (
      SELECT user_id FROM screenr_friends($1)
    ), recommendations AS (
      -- feed_item holds at most one Recommend per person and title.
      SELECT f.title_id,f.activity_at,coalesce(40-e.rank,20) AS contribution,
        e.rank,p.username,p.display_name
      FROM feed_item f JOIN direct_friends d ON d.user_id=f.owner_id
      JOIN profile p ON p.user_id=f.owner_id
      LEFT JOIN top_ten e ON e.owner_id=f.owner_id AND e.title_id=f.title_id
      WHERE f.item_type='recommended' AND f.active
    ), totals AS (
      SELECT title_id,sum(contribution) AS score,max(activity_at) AS latest
      FROM recommendations GROUP BY title_id
    ), matching AS (
      SELECT t.*,s.score,s.latest,
        EXISTS (SELECT 1 FROM watch_progress own WHERE own.owner_id=$1
          AND own.title_id=t.id AND own.active AND own.status='finished') AS finished
      FROM totals s JOIN title t ON t.id=s.title_id
      WHERE ($2::text IS NULL OR t.kind=$2::text)
        AND ${myServicesFilter("t.id", services, params)}
    ), kept AS (
      SELECT * FROM matching WHERE NOT ($3::boolean AND finished)
    ), listed AS (
      -- Ranking needs every recommendation; names are gathered only for the
      -- listed titles.
      SELECT * FROM kept ORDER BY score DESC,latest DESC,lower(name),id LIMIT $4
    ), named AS (
      SELECT title_id,
        jsonb_agg(jsonb_build_object('username',username,'display_name',display_name,'rank',rank)
          ORDER BY rank NULLS LAST,activity_at DESC,username) AS recommended_by
      FROM recommendations WHERE title_id IN (SELECT id FROM listed)
      GROUP BY title_id
    )
    SELECT (SELECT count(*)::int FROM kept) AS total,
      (SELECT count(*)::int FROM matching WHERE finished) AS finished,
      coalesce((SELECT jsonb_agg(jsonb_build_object(${titleObject("t")},
        'recommended_by',n.recommended_by,
        'viewer_status',${viewerStatus("t.id")},
        'viewer_recommended',EXISTS (SELECT 1 FROM feed_item own WHERE own.owner_id=$1
          AND own.title_id=t.id AND own.item_type='recommended' AND own.active)
      ) ORDER BY t.score DESC,t.latest DESC,lower(t.name),t.id)
      FROM listed t JOIN named n ON n.title_id=t.id),'[]') AS titles`,
    params,
  );
  return rows[0];
}

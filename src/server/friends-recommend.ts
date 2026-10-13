import { db } from "./db";
import { viewerStatus } from "./feed";
import type { FriendsRecommendation } from "../shared";

// Titles that the viewer's current, unblocked direct friends actively
// recommend. Scores use integer twentieths so rank weights stay exact: each
// Recommend contributes 20 (docs/profile-top-ten.md#ranking). Ties break on
// the most recent recommendation, then the title name and ID. The viewer's
// own status and Recommend never hide a title.
export async function friendsRecommend(
  viewer: string,
): Promise<FriendsRecommendation[]> {
  const { rows } = await db.query<{ recommendation: FriendsRecommendation }>(
    `WITH direct_friends AS (
      SELECT CASE WHEN low_id=$1 THEN high_id ELSE low_id END AS user_id
      FROM friendship
      WHERE $1 IN (low_id,high_id) AND accepted_at IS NOT NULL
        AND NOT screenr_blocked(low_id,high_id)
    ), recommendations AS (
      -- feed_item holds at most one Recommend per person and title.
      SELECT f.title_id,f.activity_at,20 AS contribution,p.username,p.display_name
      FROM feed_item f JOIN direct_friends d ON d.user_id=f.owner_id
      JOIN profile p ON p.user_id=f.owner_id
      WHERE f.item_type='recommended' AND f.active
    ), totals AS (
      SELECT title_id,sum(contribution) AS score,max(activity_at) AS latest,
        jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY activity_at DESC,username) AS recommended_by
      FROM recommendations GROUP BY title_id
    )
    SELECT jsonb_build_object(
      'id',t.id,'kind',t.kind,'tmdb_id',t.tmdb_id,'name',t.name,
      'overview',t.overview,'poster_path',t.poster_path,'release_date',t.release_date,
      'recommended_by',s.recommended_by,
      'viewer_status',${viewerStatus("t.id")},
      'viewer_recommended',EXISTS (SELECT 1 FROM feed_item own WHERE own.owner_id=$1
        AND own.title_id=t.id AND own.item_type='recommended' AND own.active)
    ) AS recommendation
    FROM totals s JOIN title t ON t.id=s.title_id
    ORDER BY s.score DESC,s.latest DESC,lower(t.name),t.id`,
    [viewer],
  );
  return rows.map((row) => row.recommendation);
}

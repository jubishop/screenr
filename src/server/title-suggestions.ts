import { db } from "./db";
import type { TitleSuggestion } from "../shared";

export async function titleSuggestions(
  viewer: string,
): Promise<TitleSuggestion[]> {
  // Resolve both social groups and their active signals in one snapshot.
  // Second-degree identities never leave this query; ordinary content access
  // still uses screenr_can_read and does not inherit this aggregate exception.
  const { rows } = await db.query<{ suggestion: TitleSuggestion }>(
    `WITH direct_friends AS (
      SELECT CASE WHEN low_id=$1 THEN high_id ELSE low_id END AS user_id
      FROM friendship
      WHERE $1 IN (low_id,high_id) AND accepted_at IS NOT NULL
        AND NOT screenr_blocked(low_id,high_id)
    ), second_degree AS (
      SELECT DISTINCT CASE WHEN f.low_id=d.user_id THEN f.high_id ELSE f.low_id END AS user_id
      FROM friendship f JOIN direct_friends d ON d.user_id IN (f.low_id,f.high_id)
      WHERE f.accepted_at IS NOT NULL AND NOT screenr_blocked(f.low_id,f.high_id)
    ), circle AS (
      SELECT user_id,3 AS weight FROM direct_friends
      UNION ALL
      SELECT s.user_id,1 AS weight FROM second_degree s
      WHERE s.user_id<>$1 AND NOT screenr_blocked($1,s.user_id)
        AND NOT EXISTS (SELECT 1 FROM direct_friends d WHERE d.user_id=s.user_id)
    ), signals AS (
      SELECT f.title_id,f.item_type,f.activity_at,c.weight,p.username,p.display_name
      FROM feed_item f JOIN circle c ON c.user_id=f.owner_id
      LEFT JOIN profile p ON p.user_id=f.owner_id AND c.weight=3
      WHERE f.active AND f.item_type IN ('recommended','want_to_watch')
        AND NOT EXISTS (
          SELECT 1 FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=f.title_id
            AND own.active AND own.item_type IN ('recommended','want_to_watch')
        )
    ), totals AS (
      SELECT title_id,max(activity_at) AS latest,
        coalesce(sum(weight) FILTER (WHERE item_type='recommended'),0) AS recommendation_score,
        coalesce(sum(weight) FILTER (WHERE item_type='want_to_watch'),0) AS want_score,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY username) FILTER (WHERE weight=3 AND item_type='recommended'),'[]'::jsonb) AS recommended_by,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY username) FILTER (WHERE weight=3 AND item_type='want_to_watch'),'[]'::jsonb) AS wanted_by,
        count(*) FILTER (WHERE weight=1 AND item_type='recommended') AS second_degree_recommended,
        count(*) FILTER (WHERE weight=1 AND item_type='want_to_watch') AS second_degree_wanted
      FROM signals GROUP BY title_id
    )
    SELECT jsonb_build_object(
      'id',t.id,'kind',t.kind,'tmdb_id',t.tmdb_id,'name',t.name,
      'overview',t.overview,'poster_path',t.poster_path,'release_date',t.release_date,
      'recommended_by',s.recommended_by,'wanted_by',s.wanted_by,
      'second_degree_recommended',s.second_degree_recommended,
      'second_degree_wanted',s.second_degree_wanted
    ) AS suggestion
    FROM totals s JOIN title t ON t.id=s.title_id
    ORDER BY s.recommendation_score DESC,s.want_score DESC,s.latest DESC,lower(t.name),t.id`,
    [viewer],
  );
  return rows.map((row) => row.suggestion);
}

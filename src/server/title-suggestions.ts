import { db } from "./db";
import type { TitleSuggestion } from "../shared";

// Fewer friends of friends sharing an action could identify them, so their
// signal is ignored entirely: no eligibility, ranking, or count.
const minimumSecondDegreePeople = 3;

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
    ), own AS (
      -- The viewer already knows titles they recommend or hold any current
      -- status for: Want to watch or a progress status, Stopped included.
      SELECT title_id FROM feed_item WHERE owner_id=$1 AND active
        AND item_type IN ('recommended','want_to_watch')
      UNION
      SELECT title_id FROM watch_progress WHERE owner_id=$1 AND active
    ), actions AS (
      SELECT owner_id,title_id,item_type AS action,activity_at FROM feed_item
      WHERE active AND item_type IN ('recommended','want_to_watch')
      UNION ALL
      -- Watching and Caught up both mean the person is still watching.
      SELECT owner_id,title_id,'watching',activity_at FROM watch_progress
      WHERE active AND status IN ('watching','caught_up')
    ), signals AS (
      SELECT a.title_id,a.action,a.activity_at,c.weight,p.username,p.display_name,
        e.rank
      FROM actions a JOIN circle c ON c.user_id=a.owner_id
      LEFT JOIN profile p ON p.user_id=a.owner_id AND c.weight=3
      LEFT JOIN top_ten e ON e.owner_id=a.owner_id AND e.title_id=a.title_id
        AND a.action='recommended'
      WHERE NOT EXISTS (SELECT 1 FROM own WHERE own.title_id=a.title_id)
    ), sized AS (
      -- circle lists each person once, and feed_item and watch_progress hold
      -- at most one row per person, title, and action, so group_size counts
      -- distinct people.
      SELECT *,count(*) OVER (PARTITION BY title_id,action,weight) AS group_size
      FROM signals
    ), qualified AS (
      SELECT * FROM sized WHERE weight=3 OR group_size>=$2
    ), totals AS (
      -- Recommendations count in twentieths so top 10 weights stay exact:
      -- 20 for a plain Recommend and 40 - rank for a top 10 one, which is
      -- 1.5 times at #10 up to 1.95 times at #1. Only qualified groups
      -- reach this point, so the minimum also governs the top 10 boost.
      SELECT title_id,max(activity_at) AS latest,
        coalesce(sum(weight*coalesce(40-rank,20)) FILTER (WHERE action='recommended'),0) AS recommendation_score,
        coalesce(sum(weight) FILTER (WHERE action='want_to_watch'),0) AS want_score,
        coalesce(sum(weight) FILTER (WHERE action='watching'),0) AS watching_score,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name,'rank',rank)
          ORDER BY rank NULLS LAST,username) FILTER (WHERE weight=3 AND action='recommended'),'[]'::jsonb) AS recommended_by,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY username) FILTER (WHERE weight=3 AND action='want_to_watch'),'[]'::jsonb) AS wanted_by,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY username) FILTER (WHERE weight=3 AND action='watching'),'[]'::jsonb) AS watching_by,
        count(*) FILTER (WHERE weight=1 AND action='recommended') AS second_degree_recommended,
        count(*) FILTER (WHERE weight=1 AND action='want_to_watch') AS second_degree_wanted,
        count(*) FILTER (WHERE weight=1 AND action='watching') AS second_degree_watching
      FROM qualified GROUP BY title_id
    )
    SELECT jsonb_build_object(
      'id',t.id,'kind',t.kind,'tmdb_id',t.tmdb_id,'name',t.name,
      'overview',t.overview,'poster_path',t.poster_path,'release_date',t.release_date,
      'recommended_by',s.recommended_by,'wanted_by',s.wanted_by,
      'watching_by',s.watching_by,
      'second_degree_recommended',s.second_degree_recommended,
      'second_degree_wanted',s.second_degree_wanted,
      'second_degree_watching',s.second_degree_watching
    ) AS suggestion
    FROM totals s JOIN title t ON t.id=s.title_id
    ORDER BY s.recommendation_score DESC,s.want_score DESC,s.watching_score DESC,
      s.latest DESC,lower(t.name),t.id`,
    [viewer, minimumSecondDegreePeople],
  );
  return rows.map((row) => row.suggestion);
}

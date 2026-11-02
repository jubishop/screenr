import { db } from "./db";
import { titleObject } from "./catalog";
import { findListLimit, myServicesFilter } from "./title-viewing";
import type { TitleSuggestion } from "../shared";

// Fewer friends of friends sharing an action could identify them, so their
// signal is ignored entirely: no eligibility, ranking, or count.
const minimumSecondDegreePeople = 3;

// The viewer's top suggestions. With `services`, the TMDB providers of the
// viewer's saved services, My services narrows them before the cap.
export async function titleSuggestions(
  viewer: string,
  services: number[] | null = null,
): Promise<TitleSuggestion[]> {
  // Resolve both social groups and their active signals in one snapshot.
  // Second-degree identities never leave this query; ordinary content access
  // still uses screenr_can_read and does not inherit this aggregate exception.
  const params: unknown[] = [viewer, minimumSecondDegreePeople, findListLimit];
  const { rows } = await db.query<{ suggestion: TitleSuggestion }>(
    `WITH direct_friends AS (
      SELECT user_id FROM screenr_friends($1)
    ), second_degree AS (
      SELECT DISTINCT s.user_id
      FROM direct_friends d CROSS JOIN screenr_friends(d.user_id) s
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
        count(*) FILTER (WHERE weight=1 AND action='recommended') AS second_degree_recommended,
        count(*) FILTER (WHERE weight=1 AND action='want_to_watch') AS second_degree_wanted,
        count(*) FILTER (WHERE weight=1 AND action='watching') AS second_degree_watching
      FROM qualified GROUP BY title_id
    ), listed AS (
      -- Ranking needs every qualified signal; names and title details are
      -- read only for the listed titles.
      SELECT s.*,t.* FROM totals s JOIN title t ON t.id=s.title_id
      WHERE ${myServicesFilter("t.id", services, params)}
      ORDER BY s.recommendation_score DESC,s.want_score DESC,s.watching_score DESC,
        s.latest DESC,lower(t.name),t.id
      LIMIT $3
    ), named AS (
      SELECT title_id,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name,'rank',rank)
          ORDER BY rank NULLS LAST,username) FILTER (WHERE action='recommended'),'[]'::jsonb) AS recommended_by,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY username) FILTER (WHERE action='want_to_watch'),'[]'::jsonb) AS wanted_by,
        coalesce(jsonb_agg(jsonb_build_object('username',username,'display_name',display_name)
          ORDER BY username) FILTER (WHERE action='watching'),'[]'::jsonb) AS watching_by
      FROM qualified WHERE weight=3 AND title_id IN (SELECT title_id FROM listed)
      GROUP BY title_id
    )
    SELECT jsonb_build_object(${titleObject("l")},
      'recommended_by',coalesce(n.recommended_by,'[]'::jsonb),
      'wanted_by',coalesce(n.wanted_by,'[]'::jsonb),
      'watching_by',coalesce(n.watching_by,'[]'::jsonb),
      'second_degree_recommended',l.second_degree_recommended,
      'second_degree_wanted',l.second_degree_wanted,
      'second_degree_watching',l.second_degree_watching
    ) AS suggestion
    FROM listed l LEFT JOIN named n ON n.title_id=l.id
    ORDER BY l.recommendation_score DESC,l.want_score DESC,l.watching_score DESC,
      l.latest DESC,lower(l.name),l.id`,
    params,
  );
  return rows.map((row) => row.suggestion);
}

import { db } from "./db";
import type { SaveSurface } from "../shared";

// Usage telemetry for the initial success measures. See docs/usage-telemetry.md.
// Days and weeks use Pacific time; weeks run Monday through Sunday.
const pacificToday = "(now() AT TIME ZONE 'America/Los_Angeles')::date";

// Saves made where a friend's recommendation was shown.
const observedSurfaces: SaveSurface[] = [
  "friend_recommendation",
  "friends_recommend",
  "suggestion_recommendation",
];

// Signed-in page renders and member actions call this; background screen and
// notification refreshes do not. Rows hold only the member and the date.
// Someone who has not finished setup has no profile, so no day is recorded.
export async function recordActiveDay(userId: string) {
  await db.query(
    `INSERT INTO member_active_day(user_id) SELECT user_id FROM profile
    WHERE user_id=$1 ON CONFLICT DO NOTHING`,
    [userId],
  );
}

// The worker's periodic cleanup. Conversation measures read existing feed and
// comment data, which this retention does not affect.
export async function pruneUsage() {
  const cutoff = `((now() AT TIME ZONE 'America/Los_Angeles') - interval '12 months')::date`;
  await db.query(`DELETE FROM member_active_day WHERE day < ${cutoff}`);
  await db.query(`DELETE FROM want_to_watch_save WHERE saved_on < ${cutoff}`);
}

export type UsageWeek = {
  week: string;
  inProgress: boolean;
  activeMembers: number;
  activePreviousWeek: number;
  saves: number;
  observedSaves: number;
  inferredSaves: number;
  // Of those saves, the ones the same member later marked Watching, Caught
  // up, or Finished, at any time since.
  followedSaves: number;
  followedObserved: number;
  followedInferred: number;
  conversations: number;
  backAndForth: number;
  repeatCommenters: number;
};

// Weekly totals for the given number of weeks, ending with the week that
// contains `through` (a Pacific date), or the current week by default.
export async function usageReport({
  weeks = 12,
  through,
}: {
  weeks?: number;
  through?: string;
}): Promise<UsageWeek[]> {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104)
    throw new Error("Choose 1 to 104 weeks.");
  if (through !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(through))
    throw new Error("Give the last week as a date, such as 2026-10-12.");
  const { rows } = await db.query<UsageWeek>(
    `WITH demo AS (
      -- Every figure leaves out the demo circle for Apple's review.
      SELECT user_id FROM profile WHERE demo
    ), weeks AS (
      SELECT (last_week - 7 * n)::date AS week, last_week - 7 * n = current_week AS in_progress
      FROM (SELECT date_trunc('week', coalesce($2::date, ${pacificToday})::timestamp)::date AS last_week,
        date_trunc('week', ${pacificToday}::timestamp)::date AS current_week) bounds,
        generate_series(0, $1 - 1) n
    ), spans AS (
      SELECT week, in_progress, week::timestamp AT TIME ZONE 'America/Los_Angeles' AS starts,
        (week + 7)::timestamp AT TIME ZONE 'America/Los_Angeles' AS ends
      FROM weeks
    ), active AS (
      SELECT user_id, day FROM member_active_day
      WHERE user_id NOT IN (SELECT user_id FROM demo)
    ), saved AS (
      SELECT * FROM want_to_watch_save WHERE user_id NOT IN (SELECT user_id FROM demo)
    ), entries AS (
      SELECT * FROM (
        SELECT id, owner_id, created_at FROM feed_item
        UNION ALL SELECT id, owner_id, created_at FROM title_comment
        UNION ALL SELECT id, owner_id, created_at FROM watch_progress
        UNION ALL SELECT id, owner_id, created_at FROM review
        UNION ALL SELECT id, owner_id, created_at FROM discussion_post
      ) e WHERE owner_id NOT IN (SELECT user_id FROM demo)
    ), comments AS (
      -- Removed comments still count as activity when they were posted.
      SELECT coalesce(feed_item_id, title_comment_id, watch_progress_id, review_id, discussion_post_id) AS entry,
        author_id, created_at FROM comment
      WHERE author_id NOT IN (SELECT user_id FROM demo)
    ), posts AS (
      -- An entry's owner posts the entry itself; everyone else posts comments.
      SELECT e.id AS entry, e.owner_id AS author, e.created_at FROM entries e
      WHERE EXISTS (SELECT 1 FROM comments c WHERE c.entry = e.id)
      UNION ALL SELECT entry, author_id, created_at FROM comments
    )
    SELECT s.week::text AS week, s.in_progress AS "inProgress",
      (SELECT count(DISTINCT a.user_id) FROM active a
        WHERE a.day >= s.week AND a.day < s.week + 7)::int AS "activeMembers",
      (SELECT count(DISTINCT a.user_id) FROM active a
        WHERE a.day >= s.week AND a.day < s.week + 7 AND EXISTS (
          SELECT 1 FROM active p
          WHERE p.user_id = a.user_id AND p.day >= s.week - 7 AND p.day < s.week
        ))::int AS "activePreviousWeek",
      saves.total AS saves, saves.observed AS "observedSaves", saves.inferred AS "inferredSaves",
      saves.followed AS "followedSaves", saves.followed_observed AS "followedObserved",
      saves.followed_inferred AS "followedInferred",
      talk.conversations, talk.back_and_forth AS "backAndForth",
      (SELECT count(DISTINCT c.author_id) FROM comments c
        WHERE c.created_at >= s.starts AND c.created_at < s.ends AND EXISTS (
          SELECT 1 FROM comments earlier
          WHERE earlier.author_id = c.author_id AND earlier.created_at < s.starts
        ))::int AS "repeatCommenters"
    FROM spans s
    CROSS JOIN LATERAL (
      -- Toggling Want to watch off and on again in one week counts once.
      -- Follow-through counts in the week of the save, whenever it happened.
      SELECT count(DISTINCT (w.user_id, w.title_id))::int AS total,
        (count(DISTINCT (w.user_id, w.title_id)) FILTER (WHERE w.surface = ANY($3)))::int AS observed,
        (count(DISTINCT (w.user_id, w.title_id)) FILTER (WHERE w.friend_recommending))::int AS inferred,
        (count(DISTINCT (w.user_id, w.title_id)) FILTER (WHERE w.followed_through))::int AS followed,
        (count(DISTINCT (w.user_id, w.title_id))
          FILTER (WHERE w.followed_through AND w.surface = ANY($3)))::int AS followed_observed,
        (count(DISTINCT (w.user_id, w.title_id))
          FILTER (WHERE w.followed_through AND w.friend_recommending))::int AS followed_inferred
      FROM saved w WHERE w.saved_on >= s.week AND w.saved_on < s.week + 7
    ) saves
    CROSS JOIN LATERAL (
      -- Participants are the owner and every commenter by the week's end.
      -- Back-and-forth: someone posted, another person followed, and the
      -- first person posted again.
      SELECT count(*)::int AS conversations,
        (count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM posts again
          JOIN posts other ON other.entry = again.entry AND other.author <> again.author
            AND other.created_at < again.created_at
          JOIN posts first ON first.entry = again.entry AND first.author = again.author
            AND first.created_at < other.created_at
          WHERE again.entry = e.id AND again.created_at < s.ends
        )))::int AS back_and_forth
      FROM entries e
      WHERE EXISTS (SELECT 1 FROM comments c WHERE c.entry = e.id
          AND c.created_at >= s.starts AND c.created_at < s.ends)
        AND EXISTS (SELECT 1 FROM comments c WHERE c.entry = e.id
          AND c.author_id <> e.owner_id AND c.created_at < s.ends)
    ) talk
    ORDER BY s.week`,
    [weeks, through ?? null, observedSurfaces],
  );
  return rows;
}

function table(headings: string[], rows: (string | number)[][]) {
  const widths = headings.map((heading, index) =>
    Math.max(
      heading.length,
      ...rows.map((row) => String(row[index]).length),
      index === 0 ? 10 : 0,
    ),
  );
  return [headings, ...rows]
    .map((row) =>
      row
        .map((cell, index) =>
          index === 0
            ? String(cell).padEnd(widths[0])
            : String(cell).padStart(widths[index]),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

// Totals only: nothing here names or counts an individual member.
export function formatUsageReport(weeks: UsageWeek[]) {
  const label = (week: UsageWeek) => week.week + (week.inProgress ? "*" : "");
  const section = (
    heading: string,
    columns: string[],
    values: (week: UsageWeek) => number[],
  ) =>
    `${heading}\n${table(
      ["Week of", ...columns],
      weeks.map((week) => [label(week), ...values(week)]),
    )}`;
  return (
    [
      `Screenr usage for the ${weeks.length} ${weeks.length === 1 ? "week" : "weeks"} starting ${weeks[0].week}\nWeeks run Monday through Sunday, Pacific time. Totals only.`,
      section(
        "Members who return each week",
        ["Active members", "Also active the week before"],
        (week) => [week.activeMembers, week.activePreviousWeek],
      ),
      `${section(
        "Want to watch saves from friends' recommendations",
        ["Saves", "Observed", "Inferred"],
        (week) => [week.saves, week.observedSaves, week.inferredSaves],
      )}
Observed: saved where a friend's recommendation was shown.
Inferred: saved while a direct friend was recommending the title.`,
      `${section(
        "Those saves later marked Watching, Caught up, or Finished",
        ["Saves", "Observed", "Inferred"],
        (week) => [
          week.followedSaves,
          week.followedObserved,
          week.followedInferred,
        ],
      )}
Each save counts in its own week once the same member marks that title.
Stopped watching alone does not count.`,
      section(
        "Conversations with at least two people",
        ["Conversations", "Back-and-forth", "Repeat commenters"],
        (week) => [
          week.conversations,
          week.backAndForth,
          week.repeatCommenters,
        ],
      ),
      ...(weeks.some((week) => week.inProgress) ? ["* Week in progress."] : []),
    ].join("\n\n") + "\n"
  );
}

// TMDB's user score (docs/title-catalog.md#tmdb-user-score-implementation):
// the average rating TMDB members give a title, out of 10, and how many
// members rated it. Both arrive in the title details and search results
// Screenr already requests, and are stored with the title's details.
export type StoredScore = {
  vote_average: number | null;
  vote_count: number | null;
};

// Fewer votes show no score. TMDB reports an unreleased title as 0 with no
// votes.
export const minimumVotes = 20;

// A count beyond this does not fit the `title.vote_count` column.
const largestCount = 2 ** 31 - 1;

// The votes in a details or search response, or stored with a title. A
// missing or non-numeric value, an average outside 0 to 10, or a count that
// is not a whole number from 0 is null, which shows no score.
export function parseScore(raw: Record<string, unknown>): StoredScore {
  const average = raw.vote_average;
  const count = raw.vote_count;
  return {
    vote_average:
      typeof average === "number" && average >= 0 && average <= 10
        ? average
        : null,
    vote_count:
      Number.isSafeInteger(count) &&
      Number(count) >= 0 &&
      Number(count) <= largestCount
        ? Number(count)
        : null,
  };
}

// The score as a whole percentage, such as 73 for 7.3 out of 10, or null
// without enough valid votes.
export function tmdbScore(stored: StoredScore): number | null {
  const { vote_average: average, vote_count: count } = parseScore(stored);
  return average !== null && count !== null && count >= minimumVotes
    ? Math.round(average * 10)
    : null;
}

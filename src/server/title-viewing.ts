import type { ReleaseTitle, Title, ViewingTitle } from "../shared";
import {
  getTitleAvailabilities,
  getTitleReleases,
  searchTitles,
} from "./catalog";
import { db } from "./db";

// A title list stops starting provider requests this long after it begins.
const listRefreshMs = 3000;

// Adds each title's viewing options, release status, and TMDB user score, as
// every title list shows them.
export async function withViewingOptions<T extends Title>(
  titles: T[],
  refreshDeadline = Infinity,
): Promise<ViewingTitle<T>[]> {
  // Read each cache for the whole list in one query. Stop starting provider
  // requests after three seconds. Existing cache entries remain readable;
  // unconfirmed titles remain visible as unknown. Each in-flight provider
  // request also has the catalog's two-second timeout. Availability and
  // release details refresh side by side within the same deadline.
  const ids = titles.map((title) => title.id);
  const deadline = Math.min(Date.now() + listRefreshMs, refreshDeadline);
  const [availability, statuses] = await Promise.all([
    getTitleAvailabilities(ids, deadline),
    getTitleReleases(ids, deadline),
  ]);
  return titles.map((title, index) => {
    const { status, checked_at, sections } = availability[index];
    return {
      ...title,
      viewing: { status, checked_at, sections },
      ...statuses[index],
    };
  });
}

// An In theaters list (docs/want-to-watch.md#in-theaters): the movies among
// `titles` whose release status says In theaters, and those whose release
// data could not be loaded, in the list's order. Shows never count. Release
// data refreshes as for any title list, and no viewing options are read.
export async function inTheaters<T extends Title>(
  titles: T[],
): Promise<ReleaseTitle<T>[]> {
  const movies = titles.filter((title) => title.kind === "movie");
  const statuses = await getTitleReleases(
    movies.map((title) => title.id),
    Date.now() + listRefreshMs,
  );
  return movies
    .map((title, index) => ({ ...title, ...statuses[index] }))
    .filter(
      ({ release }) => release.in_theaters || release.status === "unavailable",
    );
}

export async function findTitles(query: string) {
  // Reserve the last two seconds for in-flight provider requests and leave a
  // margin before the browser's ten-second search deadline.
  const refreshDeadline = Date.now() + 7000;
  const results = await searchTitles(query);
  if (results.length) {
    // The availability cache references a stored title. Search summaries create
    // only missing identities and never replace details or mark them fresh,
    // so a summary-only title fetches its details for its release status.
    // Until those details load, the summary's votes give its TMDB user score.
    // Any unique conflict means the title is stored: a concurrent insert of
    // the same new title can collide on (kind, tmdb_id) before the ID.
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,overview,poster_path,release_date,vote_average,vote_count,fetched_at)
      SELECT id,kind,tmdb_id,name,overview,poster_path,release_date,vote_average,vote_count,'epoch'::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS t(id text,kind text,tmdb_id bigint,name text,
        overview text,poster_path text,release_date text,vote_average double precision,vote_count integer)
      ON CONFLICT DO NOTHING`,
      [JSON.stringify(results)],
    );
  }
  // The listed score comes from the stored title, never the summary's votes.
  const titles = results.map(
    ({ vote_average: _average, vote_count: _count, ...title }) => title,
  );
  return withViewingOptions(titles, refreshDeadline);
}

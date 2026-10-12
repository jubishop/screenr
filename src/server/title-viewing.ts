import type { Title, ViewingTitle } from "../shared";
import { getTitleAvailabilities, searchTitles } from "./catalog";
import { db } from "./db";

export async function withViewingOptions<T extends Title>(
  titles: T[],
  refreshDeadline = Infinity,
): Promise<ViewingTitle<T>[]> {
  // Read the cache for the whole list in one query. Stop starting provider
  // requests after three seconds. Existing cache entries remain readable;
  // unconfirmed titles remain visible as unknown. Each in-flight provider
  // request also has the catalog's two-second timeout.
  const availability = await getTitleAvailabilities(
    titles.map((title) => title.id),
    Math.min(Date.now() + 3000, refreshDeadline),
  );
  return titles.map((title, index) => {
    const { status, checked_at, sections } = availability[index];
    return { ...title, viewing: { status, checked_at, sections } };
  });
}

export async function findTitles(query: string) {
  // Reserve the last two seconds for in-flight provider requests and leave a
  // margin before the browser's ten-second search deadline.
  const refreshDeadline = Date.now() + 7000;
  const titles = await searchTitles(query);
  if (titles.length) {
    // The availability cache references a stored title. Search summaries create
    // only missing identities and never replace details or mark them fresh.
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,overview,poster_path,release_date,fetched_at)
      SELECT id,kind,tmdb_id,name,overview,poster_path,release_date,'epoch'::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS t(id text,kind text,tmdb_id bigint,name text,
        overview text,poster_path text,release_date text)
      ON CONFLICT(id) DO NOTHING`,
      [JSON.stringify(titles)],
    );
  }
  return withViewingOptions(titles, refreshDeadline);
}

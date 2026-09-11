import type { Title, ViewingTitle } from "../shared";
import { getTitleAvailability, searchTitles } from "./catalog";
import { db } from "./db";

export async function withViewingOptions<T extends Title>(
  titles: T[],
  refreshDeadline = Infinity,
): Promise<ViewingTitle<T>[]> {
  const result = new Array<ViewingTitle<T>>(titles.length);
  // Stop starting provider requests after three seconds. Existing cache entries
  // remain readable; unconfirmed titles remain visible as unknown. Each in-flight
  // provider request also has the catalog's two-second timeout.
  const refreshBefore = Math.min(Date.now() + 3000, refreshDeadline);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, titles.length) }, async () => {
      while (next < titles.length) {
        const index = next++;
        const { status, checked_at, sections } = await getTitleAvailability(
          titles[index].id,
          refreshBefore,
        );
        result[index] = {
          ...titles[index],
          viewing: { status, checked_at, sections },
        };
      }
    }),
  );
  return result;
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

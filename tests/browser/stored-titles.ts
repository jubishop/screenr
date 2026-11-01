import { db } from "./database-fixture";
import { fromToday } from "./release-titles";
import type { StoredRelease } from "../../src/server/title-release";

const { titleRelease } = await import("../../src/server/title-release");

// Stores a title with current details and US release data, so pages read it
// without the catalog. A null release leaves the status unavailable. Specs
// share one database when they run in one process, so this replaces any row
// another spec stored under the same ID rather than keeping it.
export async function storeTitle(
  id: string,
  name: string,
  release: StoredRelease | null,
) {
  const [kind, tmdbId] = id.split(":");
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name,overview,release_date,release)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,overview=excluded.overview,
      release_date=excluded.release_date,release=excluded.release,
      fetched_at=now(),retry_after=NULL`,
    [
      id,
      kind,
      tmdbId,
      name,
      "A fictional title for release status checks.",
      fromToday(-200),
      release && JSON.stringify(release),
    ],
  );
  // The label the server derives today, such as "In theaters · Digital Dec 9".
  const status = titleRelease(kind as "movie" | "tv", release);
  return [
    ...(status.in_theaters ? ["In theaters"] : []),
    ...status.upcoming.map((date) => date.label),
  ].join(" · ");
}

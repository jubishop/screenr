import { db } from "./db";

// catalog.ts writes the caches that this cleanup deletes. The cleanup stays
// out of that module because the worker pass in email.ts runs it, auth.ts
// imports email.ts, and the browser fixtures load auth.ts with a module
// loader that rejects catalog.ts's JSON import.

// The worker's periodic cleanup (docs/title-catalog.md#catalog-retention).
// A conversation, which every member action and post on a title has, a top
// 10 entry, or a Want to watch save keeps all of the title's rows. Otherwise
// each row goes 30 days after it expired: availability and trailers first,
// then the details, search results included, once neither remains. Details
// expire a day after they are fetched, at a failed refresh's retry time, or,
// for a search result whose details never loaded, when search stored it.
export async function pruneCatalog() {
  const unreferenced = (id: string) =>
    `NOT EXISTS (SELECT 1 FROM conversation WHERE title_id=${id})
    AND NOT EXISTS (SELECT 1 FROM top_ten WHERE title_id=${id})
    AND NOT EXISTS (SELECT 1 FROM want_to_watch_save WHERE title_id=${id})`;
  await db.query(
    `DELETE FROM title_availability a
    WHERE refresh_after<now()-interval '30 days' AND ${unreferenced("a.title_id")}`,
  );
  await db.query(
    `DELETE FROM title_trailer t
    WHERE expires_at<now()-interval '30 days' AND ${unreferenced("t.title_id")}`,
  );
  await db.query(
    `DELETE FROM title t
    WHERE greatest(stored_at,fetched_at+interval '1 day',retry_after)<now()-interval '30 days'
    AND ${unreferenced("t.id")}
    AND NOT EXISTS (SELECT 1 FROM title_availability WHERE title_id=t.id)
    AND NOT EXISTS (SELECT 1 FROM title_trailer WHERE title_id=t.id)`,
  );
}

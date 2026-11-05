import { AppError, db, settleAll } from "./db";
import { titleColumns } from "./catalog";
import type { Person, Title, ViewingAccess } from "../shared";
import type { ListMode } from "../member-routes";
import { savedServices } from "./streaming-services";
import { inTheaters, withAccess, withViewingOptions } from "./title-viewing";

// A profile's Want to watch page (docs/want-to-watch.md): the owner's current
// Want to watch titles that the viewer can watch now, newest first, and those
// whose availability is unknown. The viewer's saved services decide, even on
// a friend's page; the owner's are never read. In theaters lists the owner's
// movies in US theaters now instead, whatever services anyone saved.
export async function wantToWatch(
  viewer: string,
  username: string,
  mode?: ListMode,
) {
  // Check access and read the owner's current choices in one snapshot. The
  // viewer always reads their own page; others need an accepted friendship
  // and no block, as private feeds do.
  const { rows } = await db.query<{ owner: Person; titles: Title[] }>(
    `WITH owner AS (
      SELECT user_id,username,display_name,screenr_photo(user_id) AS photo
      FROM profile WHERE username=$2 AND screenr_can_read($1,user_id)
    ), titles AS (
      SELECT ${titleColumns("t")},f.activity_at
      FROM owner o JOIN feed_item f ON f.owner_id=o.user_id
      JOIN title t ON t.id=f.title_id
      WHERE f.item_type='want_to_watch' AND f.active
    )
    SELECT to_jsonb(o) AS owner,
      (SELECT coalesce(jsonb_agg(to_jsonb(t)-'activity_at'
        ORDER BY t.activity_at DESC,lower(t.name),t.id),'[]'::jsonb)
        FROM titles t) AS titles
    FROM owner o`,
    [viewer, username.toLowerCase()],
  );
  if (!rows[0]) throw new AppError("Want to watch not found.", 404);
  const { owner, titles } = rows[0];
  if (mode === "theaters")
    return {
      mode,
      owner,
      hasWantToWatch: titles.length > 0,
      titles: await inTheaters(titles),
    };
  const [serviceIds, viewing] = await settleAll([
    savedServices(viewer),
    withViewingOptions(titles),
  ]);
  return {
    owner,
    // Prompts the viewer to save services.
    viewerHasServices: serviceIds.length > 0,
    // Whether the owner wants to watch anything, including titles the viewer
    // cannot watch now, so an empty page can say which is the case.
    hasWantToWatch: titles.length > 0,
    titles: withAccess(viewing, serviceIds).filter(
      (title): title is typeof title & { access: ShownAccess } =>
        title.access !== "unmatched",
    ),
  };
}

// Titles the viewer can watch now, and those whose availability is unknown.
type ShownAccess = Exclude<ViewingAccess, "unmatched">;

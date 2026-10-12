import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, db, transaction } from "./db";
import { viewerStatus } from "./feed";
import type { ProgressStatus, SaveSurface, WatchStatus } from "../shared";
import { progressStatuses, saveSurfaces } from "../shared";

const pacificToday = "(now() AT TIME ZONE 'America/Los_Angeles')::date";

// `surface` reports where a Want to watch save was made, for usage telemetry.
export async function updateTitleActivity(
  viewer: string,
  titleId: string,
  field: string,
  value: unknown,
  surface?: unknown,
) {
  if (
    !["recommended", "want_to_watch"].includes(field) ||
    typeof value !== "boolean" ||
    !validSurface(surface)
  )
    throw new AppError("Invalid title action.");
  return transaction(async (client) => {
    await titleKind(client, titleId);
    return setAction(client, viewer, titleId, field, value, surface);
  });
}

// Sets the member's one current status for a title, or clears it with null.
// Finished records `finishedOn` (YYYY-MM-DD), or today in Pacific time.
export async function updateWatchStatus(
  viewer: string,
  titleId: string,
  status: unknown,
  finishedOn?: unknown,
  surface?: unknown,
) {
  if (
    (status !== null &&
      status !== "want_to_watch" &&
      !progressStatuses.includes(status as ProgressStatus)) ||
    !validSurface(surface)
  )
    throw new AppError("Invalid watch status.");
  if (finishedOn != null && status !== "finished")
    throw new AppError("Only Finished takes a finished date.");
  if (finishedOn != null) validDate(finishedOn);
  return transaction(async (client) => {
    const kind = await titleKind(client, titleId);
    if (status === "caught_up" && kind !== "tv")
      throw new AppError("Caught up is only for TV shows.");
    if (status === "want_to_watch")
      return setAction(client, viewer, titleId, "want_to_watch", true, surface);
    // Clearing, or choosing a progress status, switches Want to watch off
    // under its lifecycle, keeping its entry, discussion, and activity date.
    await client.query(
      `UPDATE feed_item SET active=false
      WHERE owner_id=$1 AND title_id=$2 AND item_type='want_to_watch' AND active`,
      [viewer, titleId],
    );
    if (status === null) {
      await withdrawProgress(client, viewer, titleId);
      return null;
    }
    await anchor(client, viewer, titleId);
    // One progress entry per person and title. A new status updates it in
    // place and moves it up; choosing the current status changes nothing.
    // Choosing Finished sets the date; other statuses keep it, as in a rewatch.
    const row = (
      await client.query(
        `INSERT INTO watch_progress(id,conversation_id,owner_id,title_id,status,finished_on)
        SELECT $1,id,owner_id,title_id,$4::text,
          CASE WHEN $4='finished' THEN coalesce($5::date,${pacificToday}) END
        FROM conversation WHERE owner_id=$2 AND title_id=$3
        ON CONFLICT(owner_id,title_id) DO UPDATE SET status=excluded.status,active=true,
          finished_on=CASE WHEN excluded.status='finished' AND NOT (watch_progress.active
            AND watch_progress.status='finished') THEN excluded.finished_on ELSE watch_progress.finished_on END,
          activity_at=CASE WHEN watch_progress.active AND watch_progress.status=excluded.status
            THEN watch_progress.activity_at ELSE now() END
        RETURNING id`,
        [randomUUID(), viewer, titleId, status, finishedOn ?? null],
      )
    ).rows[0];
    return row.id as string;
  });
}

// Changes or clears (null) the last-finished date without moving the entry.
export async function setFinishedDate(
  viewer: string,
  titleId: string,
  date: unknown,
) {
  if (date !== null) validDate(date);
  await transaction(async (client) => {
    const result = await client.query(
      "UPDATE watch_progress SET finished_on=$3 WHERE owner_id=$1 AND title_id=$2",
      [viewer, titleId, date],
    );
    if (!result.rowCount)
      throw new AppError(
        "Choose a watch status before adding a finished date.",
      );
  });
}

// The member's own current status and stored last-finished date for a title.
export async function watchStatus(
  viewer: string,
  titleId: string,
): Promise<{ status: WatchStatus | null; finished_on: string | null }> {
  return (
    await db.query(
      `SELECT ${viewerStatus("$2")} AS status,
      (SELECT finished_on::text FROM watch_progress WHERE owner_id=$1 AND title_id=$2) AS finished_on`,
      [viewer, titleId],
    )
  ).rows[0];
}

function validSurface(surface: unknown) {
  return surface == null || saveSurfaces.includes(surface as SaveSurface);
}

// A real calendar date from 1900 through today in the earliest time zone.
function validDate(value: unknown) {
  const latest = new Date(Date.now() + 14 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value ||
    value < "1900-01-01" ||
    value > latest
  )
    throw new AppError("Enter a finished date from 1900 through today.");
}

async function titleKind(client: PoolClient, titleId: string) {
  const title = (
    await client.query("SELECT kind FROM title WHERE id=$1", [titleId])
  ).rows[0];
  if (!title) throw new AppError("Title not found.", 404);
  return title.kind as "movie" | "tv";
}

async function withdrawProgress(
  client: PoolClient,
  viewer: string,
  titleId: string,
) {
  // The removal does not move the entry; it keeps its replies and date.
  await client.query(
    `UPDATE watch_progress SET active=false
    WHERE owner_id=$1 AND title_id=$2 AND active`,
    [viewer, titleId],
  );
}

// The person/title conversation row anchors entries and old links.
async function anchor(client: PoolClient, viewer: string, titleId: string) {
  await client.query(
    `INSERT INTO conversation(id,owner_id,title_id) VALUES($1,$2,$3)
    ON CONFLICT(owner_id,title_id) DO NOTHING`,
    [randomUUID(), viewer, titleId],
  );
}

async function setAction(
  client: PoolClient,
  viewer: string,
  titleId: string,
  field: string,
  value: boolean,
  surface?: unknown,
) {
  const other = field === "recommended" ? "want_to_watch" : "recommended";
  // A save turns Want to watch on. Store only whether any direct friend
  // recommends the title now, never who.
  if (field === "want_to_watch" && value)
    await client.query(
      `INSERT INTO want_to_watch_save(user_id,title_id,surface,friend_recommending)
      SELECT $1,$2,$3,EXISTS (
        SELECT 1 FROM feed_item f WHERE f.title_id=$2 AND f.item_type='recommended'
          AND f.active AND f.owner_id<>$1 AND screenr_can_read($1,f.owner_id))
      WHERE NOT EXISTS (
        SELECT 1 FROM feed_item own WHERE own.owner_id=$1 AND own.title_id=$2
          AND own.item_type='want_to_watch' AND own.active)`,
      [viewer, titleId, surface ?? null],
    );
  await anchor(client, viewer, titleId);
  // Recommend and Want to watch are exclusive. Withdraw the other entry
  // first so the unique active-action index holds; it keeps its replies
  // and activity date for a later switch back. Want to watch is also a
  // status, so it replaces any progress status.
  if (value)
    await client.query(
      `UPDATE feed_item SET active=false
      WHERE owner_id=$1 AND title_id=$2 AND item_type=$3 AND active`,
      [viewer, titleId, other],
    );
  if (field === "want_to_watch" && value)
    await withdrawProgress(client, viewer, titleId);
  const row = (
    await client.query(
      `INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active)
      SELECT $1,id,owner_id,title_id,$4,$5 FROM conversation WHERE owner_id=$2 AND title_id=$3
      ON CONFLICT(owner_id,title_id,item_type) DO UPDATE SET active=$5,
      activity_at=CASE WHEN $5 AND NOT feed_item.active THEN now() ELSE feed_item.activity_at END RETURNING id`,
      [randomUUID(), viewer, titleId, field, value],
    )
  ).rows[0];
  return row.id as string;
}

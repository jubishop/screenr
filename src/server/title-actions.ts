import { randomUUID } from "node:crypto";
import { AppError, transaction } from "./db";
import type { SaveSurface } from "../shared";
import { saveSurfaces } from "../shared";

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
    (surface != null && !saveSurfaces.includes(surface as SaveSurface))
  )
    throw new AppError("Invalid title action.");
  const other = field === "recommended" ? "want_to_watch" : "recommended";
  return transaction(async (client) => {
    if (
      !(await client.query("SELECT 1 FROM title WHERE id=$1", [titleId]))
        .rowCount
    )
      throw new AppError("Title not found.", 404);
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
    // The person/title conversation row anchors feed items. This release
    // never reads its flags; they keep the previous release's
    // synchronization trigger correct during activation or rollback.
    const legacy = (
      await client.query(
        `INSERT INTO conversation(id,owner_id,title_id,${field}) VALUES($1,$2,$3,$4)
      ON CONFLICT(owner_id,title_id) DO UPDATE SET ${field}=$4,
      ${other}=CASE WHEN $4 THEN false ELSE conversation.${other} END,
      activity_at=CASE WHEN $4 AND NOT conversation.${field} THEN now() ELSE conversation.activity_at END RETURNING id`,
        [randomUUID(), viewer, titleId, value],
      )
    ).rows[0];
    // Recommend and Want to watch are exclusive. Withdraw the other entry
    // first so the unique active-action index holds; it keeps its replies
    // and activity date for a later switch back.
    if (value)
      await client.query(
        `UPDATE feed_item SET active=false
        WHERE owner_id=$1 AND title_id=$2 AND item_type=$3 AND active`,
        [viewer, titleId, other],
      );
    const row = (
      await client.query(
        `INSERT INTO feed_item(id,conversation_id,owner_id,title_id,item_type,active) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(owner_id,title_id,item_type) DO UPDATE SET active=$6,
      activity_at=CASE WHEN $6 AND NOT feed_item.active THEN now() ELSE feed_item.activity_at END RETURNING id`,
        [randomUUID(), legacy.id, viewer, titleId, field, value],
      )
    ).rows[0];
    return row.id as string;
  });
}

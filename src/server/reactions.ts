import { AppError, isUuid, transaction } from "./db";
import { entryColumn, erasable, itemQuery } from "./feed";
import type { FeedItem } from "../shared";
import { reactionOptions } from "../shared";

export async function setReaction(
  viewer: string,
  itemId: string,
  replyId: unknown,
  kind: unknown,
) {
  if (kind !== null && !reactionOptions.some((option) => option.kind === kind))
    throw new AppError("Invalid reaction.");
  if (
    replyId != null &&
    (typeof replyId !== "string" || !/^\d+$/.test(replyId))
  )
    throw new AppError("Invalid reply target.");
  if (!isUuid(itemId)) throw new AppError("Conversation not found.", 404);
  await transaction(async (client) => {
    const item: FeedItem | undefined = (
      await client.query(`${itemQuery} AND c.id=$2::uuid`, [viewer, itemId])
    ).rows[0];
    // Deleted standalone comments and posts and removed reviews accept no
    // reactions.
    if (!item || (replyId == null && erasable(item.item_type) && !item.active))
      throw new AppError("Conversation not found.", 404);
    if (
      replyId != null &&
      !item.comments.some(
        (comment) =>
          comment.id === replyId && !comment.removed && !comment.unavailable,
      )
    )
      throw new AppError("Reply target not found.", 404);
    const column = replyId != null ? "comment_id" : entryColumn(item.item_type);
    const target = replyId ?? itemId;
    if (kind === null) {
      await client.query(
        `DELETE FROM reaction WHERE ${column}=$1 AND user_id=$2`,
        [target, viewer],
      );
    } else {
      await client.query(
        `INSERT INTO reaction(${column},user_id,kind) VALUES($1,$2,$3)
        ON CONFLICT (${column},user_id) DO UPDATE SET kind=EXCLUDED.kind`,
        [target, viewer, kind],
      );
    }
  });
}

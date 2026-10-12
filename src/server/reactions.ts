import { AppError, transaction } from "./db";
import { itemQuery } from "./feed";
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
  await transaction(async (client) => {
    const item: FeedItem | undefined = (
      await client.query(`${itemQuery} AND c.id::text=$2`, [viewer, itemId])
    ).rows[0];
    if (
      !item ||
      (replyId == null && item.item_type === "comment" && !item.active)
    )
      throw new AppError("Conversation not found.", 404);
    if (
      replyId != null &&
      !item.comments.some(
        (comment) =>
          comment.id === replyId && !comment.removed && !comment.unavailable,
      )
    )
      throw new AppError("Reply target not found.", 404);
    const column =
      replyId != null
        ? "comment_id"
        : item.item_type === "comment"
          ? "title_comment_id"
          : "feed_item_id";
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

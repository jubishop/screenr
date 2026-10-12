import { randomUUID } from "node:crypto";
import { AppError, text, transaction } from "./db";
import { feedEntries, itemQuery } from "./feed";

export async function addComment(
  viewer: string,
  conversationId: string,
  body: unknown,
  spoiler: unknown,
  replyTo?: unknown,
) {
  const content = text(body, "Reply", 2000);
  if (typeof spoiler !== "boolean") throw new AppError("Invalid spoiler flag.");
  if (
    replyTo != null &&
    (typeof replyTo !== "string" || !/^\d+$/.test(replyTo))
  )
    throw new AppError("Invalid reply target.");
  return transaction(async (client) => {
    const conversation = (
      await client.query(`${itemQuery} AND c.id::text=$2`, [
        viewer,
        conversationId,
      ])
    ).rows[0];
    if (!conversation) throw new AppError("Conversation not found.", 404);
    let parent:
      { id: string; root_id: string | null; author_id: string } | undefined;
    if (replyTo) {
      parent = (
        await client.query(
          `SELECT id::text,root_id::text,author_id FROM comment
        WHERE id::text=$1 AND (feed_item_id::text=$2 OR title_comment_id::text=$2) AND removed_at IS NULL
        AND screenr_can_read(author_id,$3) AND NOT screenr_blocked($4,author_id)`,
          [replyTo, conversationId, conversation.owner_id, viewer],
        )
      ).rows[0];
      if (!parent) throw new AppError("Reply target not found.", 404);
    }
    const result = await client.query(
      `INSERT INTO comment(feed_item_id,author_id,body,spoiler,root_id,addressed_id,conversation_id,title_comment_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
      [
        conversation.item_type === "comment" ? null : conversationId,
        viewer,
        content,
        spoiler,
        parent ? (parent.root_id ?? parent.id) : null,
        parent?.author_id ?? null,
        conversation.conversation_id,
        conversation.item_type === "comment" ? conversationId : null,
      ],
    );
    return result.rows[0].id as string;
  });
}
export async function removeComment(viewer: string, id: string) {
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE comment cm SET removed_at=coalesce(removed_at,now()),body='[removed]'
      FROM ${feedEntries} c WHERE cm.id::text=$1 AND (c.id=cm.feed_item_id OR c.id=cm.title_comment_id)
      AND (cm.author_id=$2 OR c.owner_id=$2)
      AND screenr_can_read(cm.author_id,c.owner_id) AND NOT screenr_blocked($2,cm.author_id)`,
      [id, viewer],
    );
    if (result.rowCount) return;
    const standalone = await client.query(
      `UPDATE title_comment SET removed_at=coalesce(removed_at,now()),body='[removed]'
       WHERE id::text=$1 AND owner_id=$2`,
      [id, viewer],
    );
    if (!standalone.rowCount) throw new AppError("Comment not found.", 404);
  });
}

export async function createTitleComment(
  viewer: string,
  titleId: string,
  body: unknown,
  spoiler: unknown,
) {
  const content = text(body, "Comment", 2000);
  if (typeof spoiler !== "boolean") throw new AppError("Invalid spoiler flag.");
  return transaction(async (client) => {
    if (
      !(await client.query("SELECT 1 FROM title WHERE id=$1", [titleId]))
        .rowCount
    )
      throw new AppError("Title not found.", 404);
    // The conversation row anchors entries and old links; add it when absent.
    await client.query(
      `INSERT INTO conversation(id,owner_id,title_id) VALUES($1,$2,$3)
       ON CONFLICT(owner_id,title_id) DO NOTHING`,
      [randomUUID(), viewer, titleId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,spoiler)
       SELECT $1,id,owner_id,title_id,$4,$5 FROM conversation WHERE owner_id=$2 AND title_id=$3`,
      [id, viewer, titleId, content, spoiler],
    );
    return id;
  });
}

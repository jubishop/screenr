import { randomUUID } from "node:crypto";
import { AppError, isBigintId, isUuid, text, transaction } from "./db";
import { belongsTo, entryColumn, feedEntries, itemQuery } from "./feed";
import { queueBadgePush } from "./push";

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
  if (!isUuid(conversationId))
    throw new AppError("Conversation not found.", 404);
  return transaction(async (client) => {
    const conversation = (
      await client.query(`${itemQuery} AND c.id=$2::uuid`, [
        viewer,
        conversationId,
      ])
    ).rows[0];
    if (!conversation) throw new AppError("Conversation not found.", 404);
    let parent:
      { id: string; root_id: string | null; author_id: string } | undefined;
    if (replyTo) {
      parent = isBigintId(replyTo)
        ? (
            await client.query(
              `SELECT id::text,root_id::text,author_id FROM comment
        WHERE id=$1::bigint AND ${belongsTo("comment", "$2::uuid")} AND removed_at IS NULL
        AND screenr_can_read(author_id,$3) AND NOT screenr_blocked($4,author_id)`,
              [replyTo, conversation.id, conversation.owner_id, viewer],
            )
          ).rows[0]
        : undefined;
      if (!parent) throw new AppError("Reply target not found.", 404);
    }
    const result = await client.query(
      `INSERT INTO comment(${entryColumn(conversation.item_type)},author_id,body,spoiler,root_id,addressed_id,conversation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
      [
        conversation.id,
        viewer,
        content,
        spoiler,
        parent ? (parent.root_id ?? parent.id) : null,
        parent?.author_id ?? null,
        conversation.conversation_id,
      ],
    );
    return result.rows[0].id as string;
  });
}

// Replies have bigint IDs, and standalone entries have uuid IDs.
export async function removeComment(viewer: string, id: string) {
  const reply = isBigintId(id);
  if (!reply && !isUuid(id)) throw new AppError("Comment not found.", 404);
  await transaction(async (client) => {
    // Removing a reply hides its notifications, lowering the count of each
    // member who has one unread. A removed entry keeps its replies and their
    // notifications.
    const unread = reply
      ? (
          await client.query<{ recipient_id: string }>(
            `SELECT recipient_id FROM visible_notification
            WHERE comment_id=$1::bigint AND read_at IS NULL`,
            [id],
          )
        ).rows
      : [];
    const result = reply
      ? await client.query(
          `UPDATE comment cm SET removed_at=coalesce(removed_at,now()),body='[removed]'
      FROM ${feedEntries} c WHERE cm.id=$1::bigint AND ${belongsTo("cm", "c.id")}
      AND (cm.author_id=$2 OR c.owner_id=$2)
      AND screenr_can_read(cm.author_id,c.owner_id) AND NOT screenr_blocked($2,cm.author_id)`,
          [id, viewer],
        )
      : // Authors delete their own comments and posts, keeping the replies.
        await client.query(
          `WITH removed AS (
            UPDATE title_comment SET removed_at=coalesce(removed_at,now()),body='[removed]'
            WHERE id=$1::uuid AND owner_id=$2 RETURNING id
          ), post AS (
            UPDATE discussion_post SET removed_at=coalesce(removed_at,now()),body='[removed]'
            WHERE id=$1::uuid AND owner_id=$2 RETURNING id
          ) SELECT id FROM removed UNION ALL SELECT id FROM post`,
          [id, viewer],
        );
    if (!result.rowCount) throw new AppError("Comment not found.", 404);
    for (const { recipient_id } of unread)
      await queueBadgePush(recipient_id, client);
  });
}

// A discussion post without a title, for the author and their friends.
export async function createDiscussionPost(
  viewer: string,
  body: unknown,
  spoiler: unknown,
) {
  const content = text(body, "Post", 2000);
  if (typeof spoiler !== "boolean") throw new AppError("Invalid spoiler flag.");
  const id = randomUUID();
  await transaction((client) =>
    client.query(
      "INSERT INTO discussion_post(id,owner_id,body,spoiler) VALUES($1,$2,$3,$4)",
      [id, viewer, content, spoiler],
    ),
  );
  return id;
}

// Season and episode numbers from the TV composer's TMDB pickers. Either may
// be absent; an episode needs its season.
function label(value: unknown, name: string) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1e5)
    throw new AppError(`Invalid ${name}.`);
  return Number(value);
}

export async function createTitleComment(
  viewer: string,
  titleId: string,
  body: unknown,
  spoiler: unknown,
  seasonNumber?: unknown,
  episodeNumber?: unknown,
) {
  const content = text(body, "Comment", 2000);
  if (typeof spoiler !== "boolean") throw new AppError("Invalid spoiler flag.");
  const season = label(seasonNumber, "season");
  const episode = label(episodeNumber, "episode");
  if (episode !== null && season === null)
    throw new AppError("Choose a season for the episode.");
  return transaction(async (client) => {
    const title = (
      await client.query("SELECT kind FROM title WHERE id=$1", [titleId])
    ).rows[0];
    if (!title) throw new AppError("Title not found.", 404);
    if (season !== null && title.kind !== "tv")
      throw new AppError("Season and episode labels are only for TV shows.");
    // The conversation row anchors entries and old links; add it when absent.
    await client.query(
      `INSERT INTO conversation(id,owner_id,title_id) VALUES($1,$2,$3)
       ON CONFLICT(owner_id,title_id) DO NOTHING`,
      [randomUUID(), viewer, titleId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO title_comment(id,conversation_id,owner_id,title_id,body,spoiler,season_number,episode_number)
       SELECT $1,id,owner_id,title_id,$4,$5,$6,$7 FROM conversation WHERE owner_id=$2 AND title_id=$3`,
      [id, viewer, titleId, content, spoiler, season, episode],
    );
    return id;
  });
}

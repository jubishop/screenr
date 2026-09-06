import { randomUUID } from "node:crypto";
import { AppError, db, text, transaction } from "./db";
import type { Conversation, Person, Thread } from "../shared";

export async function member(userId: string): Promise<Person> {
  const profile = (
    await db.query(
      "SELECT user_id,username,display_name FROM profile WHERE user_id=$1",
      [userId],
    )
  ).rows[0];
  if (!profile) throw new AppError("Complete your profile first.", 403);
  return profile;
}
export async function profileFor(viewer: string, username: string) {
  const profile = (
    await db.query(
      `SELECT p.user_id,p.username,p.display_name,screenr_can_read($1,p.user_id) AS can_read,
    f.requested_by,f.accepted_at FROM profile p LEFT JOIN friendship f
    ON f.low_id=least($1,p.user_id) AND f.high_id=greatest($1,p.user_id)
    WHERE p.username=$2 AND NOT screenr_blocked($1,p.user_id)`,
      [viewer, username.toLowerCase()],
    )
  ).rows[0];
  if (!profile) throw new AppError("Person not found.", 404);
  return profile;
}
export async function people(viewer: string) {
  const connections = (
    await db.query(
      `SELECT p.user_id,p.username,p.display_name,f.requested_by,f.accepted_at
    FROM friendship f JOIN profile p ON p.user_id=CASE WHEN f.low_id=$1 THEN f.high_id ELSE f.low_id END
    WHERE $1 IN (f.low_id,f.high_id) AND NOT screenr_blocked($1,p.user_id) ORDER BY p.username`,
      [viewer],
    )
  ).rows;
  const blocked = (
    await db.query(
      `SELECT p.user_id,p.username,p.display_name FROM block b
    JOIN profile p ON p.user_id=b.blocked_id WHERE b.blocker_id=$1 ORDER BY p.username`,
      [viewer],
    )
  ).rows;
  return { connections, blocked };
}
export async function changeRelationship(
  viewer: string,
  target: string,
  action: string,
) {
  if (!["request", "accept", "remove", "block", "unblock"].includes(action))
    throw new AppError("Unknown friendship action.");
  if (viewer === target) throw new AppError("Choose another person.");
  await transaction(async (client) => {
    if (
      !(await client.query("SELECT 1 FROM profile WHERE user_id=$1", [target]))
        .rowCount
    )
      throw new AppError("Person not found.", 404);
    const pair = [viewer, target];
    if (action === "block") {
      await client.query(
        "INSERT INTO block(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [viewer, target],
      );
      await client.query(
        "DELETE FROM friendship WHERE low_id=least($1,$2) AND high_id=greatest($1,$2)",
        pair,
      );
    } else if (action === "unblock") {
      await client.query(
        "DELETE FROM block WHERE blocker_id=$1 AND blocked_id=$2",
        [viewer, target],
      );
    } else if (action === "remove") {
      await client.query(
        "DELETE FROM friendship WHERE low_id=least($1,$2) AND high_id=greatest($1,$2)",
        pair,
      );
    } else {
      if (
        (
          await client.query("SELECT screenr_blocked($1,$2) AS blocked", [
            viewer,
            target,
          ])
        ).rows[0].blocked
      )
        throw new AppError("Person not found.", 404);
      if (action === "request") {
        await client.query(
          "INSERT INTO friendship(low_id,high_id,requested_by) VALUES(least($1,$2),greatest($1,$2),$3) ON CONFLICT DO NOTHING",
          [...pair, viewer],
        );
      } else {
        const result = await client.query(
          "UPDATE friendship SET accepted_at=now() WHERE low_id=least($1,$2) AND high_id=greatest($1,$2) AND requested_by=$3 AND accepted_at IS NULL",
          [...pair, target],
        );
        if (!result.rowCount)
          throw new AppError("Friend request not found.", 404);
      }
    }
  });
}

const conversationColumns = `c.*,p.username,p.display_name,t.name AS title_name,t.poster_path,t.kind`;
const visibleActivity = `greatest(c.activity_at, coalesce((SELECT max(cm.created_at) FROM comment cm
  WHERE cm.conversation_id=c.id AND cm.removed_at IS NULL AND screenr_can_read(cm.author_id,c.owner_id)
  AND NOT screenr_blocked($1,cm.author_id)),c.activity_at))`;

export async function conversations(
  viewer: string,
  filter: { title?: string; owner?: string } = {},
): Promise<Conversation[]> {
  return (
    await db.query(
      `SELECT ${conversationColumns},${visibleActivity} AS visible_activity
    FROM conversation c JOIN profile p ON p.user_id=c.owner_id JOIN title t ON t.id=c.title_id
    WHERE screenr_can_read($1,c.owner_id) AND ($2::text IS NULL OR c.title_id=$2)
    AND ($3::text IS NULL OR c.owner_id=$3)
    ORDER BY ${filter.title ? "visible_activity" : "c.activity_at"} DESC,c.id`,
      [viewer, filter.title ?? null, filter.owner ?? null],
    )
  ).rows;
}

export async function updateTitleActivity(
  viewer: string,
  titleId: string,
  field: string,
  value: unknown,
) {
  if (
    !["recommended", "want_to_watch"].includes(field) ||
    typeof value !== "boolean"
  )
    throw new AppError("Invalid title action.");
  return transaction(async (client) => {
    if (
      !(await client.query("SELECT 1 FROM title WHERE id=$1", [titleId]))
        .rowCount
    )
      throw new AppError("Title not found.", 404);
    const row = (
      await client.query(
        `INSERT INTO conversation(id,owner_id,title_id,${field}) VALUES($1,$2,$3,$4)
      ON CONFLICT(owner_id,title_id) DO UPDATE SET ${field}=$4,
      activity_at=CASE WHEN conversation.${field} IS DISTINCT FROM $4 THEN now() ELSE conversation.activity_at END
      RETURNING id`,
        [randomUUID(), viewer, titleId, value],
      )
    ).rows[0];
    return row.id as string;
  });
}

export async function thread(viewer: string, id: string): Promise<Thread> {
  // One SQL statement uses one PostgreSQL snapshot for access and comment visibility.
  const { rows } = await db.query(
    `SELECT ${conversationColumns},${visibleActivity} AS visible_activity,
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',cm.id::text,'author_id',cm.author_id,'username',author.username,'display_name',author.display_name,
      'body',CASE WHEN cm.removed_at IS NULL THEN cm.body ELSE '' END,'spoiler',cm.spoiler,
      'root_id',cm.root_id::text,'addressed_username',CASE WHEN NOT screenr_blocked($1,cm.addressed_id) THEN addressed.username ELSE NULL END,
      'removed',cm.removed_at IS NOT NULL,'created_at',cm.created_at) ORDER BY cm.id)
      FROM comment cm JOIN profile author ON author.user_id=cm.author_id
      LEFT JOIN profile addressed ON addressed.user_id=cm.addressed_id
      WHERE cm.conversation_id=c.id AND screenr_can_read(cm.author_id,c.owner_id)
      AND NOT screenr_blocked($1,cm.author_id)), '[]') AS comments
    FROM conversation c JOIN profile p ON p.user_id=c.owner_id JOIN title t ON t.id=c.title_id
    WHERE c.id::text=$2 AND screenr_can_read($1,c.owner_id)`,
    [viewer, id],
  );
  if (!rows[0]) throw new AppError("Conversation not found.", 404);
  const { comments, ...conversation } = rows[0];
  return { conversation, comments };
}

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
      await client.query(
        "SELECT owner_id FROM conversation WHERE id::text=$1 AND screenr_can_read($2,owner_id)",
        [conversationId, viewer],
      )
    ).rows[0];
    if (!conversation) throw new AppError("Conversation not found.", 404);
    let parent:
      { id: string; root_id: string | null; author_id: string } | undefined;
    if (replyTo) {
      parent = (
        await client.query(
          `SELECT id::text,root_id::text,author_id FROM comment
        WHERE id::text=$1 AND conversation_id::text=$2 AND removed_at IS NULL
        AND screenr_can_read(author_id,$3) AND NOT screenr_blocked($4,author_id)`,
          [replyTo, conversationId, conversation.owner_id, viewer],
        )
      ).rows[0];
      if (!parent) throw new AppError("Reply target not found.", 404);
    }
    const result = await client.query(
      `INSERT INTO comment(conversation_id,author_id,body,spoiler,root_id,addressed_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [
        conversationId,
        viewer,
        content,
        spoiler,
        parent ? (parent.root_id ?? parent.id) : null,
        parent?.author_id ?? null,
      ],
    );
    return result.rows[0].id as string;
  });
}
export async function removeComment(viewer: string, id: string) {
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE comment cm SET removed_at=coalesce(removed_at,now()),body='[removed]'
      FROM conversation c WHERE cm.id::text=$1 AND c.id=cm.conversation_id AND c.owner_id=$2`,
      [id, viewer],
    );
    if (!result.rowCount) throw new AppError("Comment not found.", 404);
  });
}

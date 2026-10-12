import { randomUUID } from "node:crypto";
import { AppError, text, transaction } from "./db";

// Each member has one review per title: a whole-star rating from 1 to 5,
// text, or both, with a spoiler flag that covers the text and discussion
// (docs/title-feed.md#reviews). Saving creates the review's feed entry or
// updates it in place. A change moves it up and marks it edited; saving the
// same review changes nothing. A removed review is reused with its replies.
export async function saveReview(
  viewer: string,
  titleId: string,
  rating: unknown,
  body: unknown,
  spoiler: unknown,
) {
  if (
    rating != null &&
    !(Number.isInteger(rating) && Number(rating) >= 1 && Number(rating) <= 5)
  )
    throw new AppError("Choose a rating from 1 to 5 stars.");
  if (body != null && typeof body !== "string")
    throw new AppError("Invalid review text.");
  // Text is optional; blank text saves none.
  const content =
    typeof body === "string" && body.trim() ? text(body, "Review", 2000) : null;
  if (typeof spoiler !== "boolean") throw new AppError("Invalid spoiler flag.");
  if (rating == null && content == null)
    throw new AppError("Add a star rating or review text.");
  return transaction(async (client) => {
    if (
      !(await client.query("SELECT 1 FROM title WHERE id=$1", [titleId]))
        .rowCount
    )
      throw new AppError("Title not found.", 404);
    // The person/title conversation row anchors entries and old links.
    await client.query(
      `INSERT INTO conversation(id,owner_id,title_id) VALUES($1,$2,$3)
      ON CONFLICT(owner_id,title_id) DO NOTHING`,
      [randomUUID(), viewer, titleId],
    );
    const row = (
      await client.query(
        `INSERT INTO review(id,conversation_id,owner_id,title_id,rating,body,spoiler)
        SELECT $1,id,owner_id,title_id,$4,$5,$6 FROM conversation WHERE owner_id=$2 AND title_id=$3
        ON CONFLICT(owner_id,title_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,
          spoiler=excluded.spoiler,active=true,
          activity_at=CASE WHEN review.active AND review.rating IS NOT DISTINCT FROM excluded.rating
            AND review.body IS NOT DISTINCT FROM excluded.body AND review.spoiler=excluded.spoiler
            THEN review.activity_at ELSE now() END
        RETURNING id`,
        [randomUUID(), viewer, titleId, rating ?? null, content, spoiler],
      )
    ).rows[0];
    return row.id as string;
  });
}

// Erases the rating and text. The entry keeps its spoiler flag, date, and
// discussion, and the removal does not move it up.
export async function removeReview(viewer: string, titleId: string) {
  await transaction(async (client) => {
    const result = await client.query(
      `UPDATE review SET active=false,rating=NULL,body=NULL
      WHERE owner_id=$1 AND title_id=$2 AND active`,
      [viewer, titleId],
    );
    if (!result.rowCount) throw new AppError("Review not found.", 404);
  });
}

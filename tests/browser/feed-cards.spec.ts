import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";

const { saveReview } = await import("../../src/server/reviews");
const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");

// One person's close-together actions for a title show as one card
// (docs/title-feed.md#combine-one-persons-close-together-title-actions--2026-11-08).
// The server's rules have application tests; this checks what only the
// browser shows.
test("a card names its actions in one author line with one date, shows its review, and keeps a reader's draft when its review arrives", async ({
  member,
}) => {
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview,release_date) VALUES
    ('movie:998501','movie',998501,'Lantern Bay','A fictional film.','2023-03-01')
    ON CONFLICT DO NOTHING`);
  // Distinct names let the scenario repeat against the same database.
  const name = `card_${randomUUID().slice(0, 8)}`;
  const author = await member(name);
  const reader = await member(`${name}_reader`);
  await prepareFriendship(author, reader);
  const id = await userId(author);
  const progress = await updateWatchStatus(id, "movie:998501", "finished");
  await updateTitleActivity(id, "movie:998501", "recommended", true);
  await reader.goto("/");
  const card = reader.locator(".feed-entry").filter({
    has: reader.getByRole("link", { name, exact: true }),
  });
  const byline = card.locator(".activity-by");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-item-id", progress!);
  await expect(byline.locator(".muted").first()).toHaveText(
    "finished and recommends",
  );
  // One date for the whole card, and no finished date beside "finished".
  await expect(byline.locator("time")).toHaveCount(1);

  // A draft on the card stays while the author's review comes to hold it,
  // and the card keeps its place until the reader accepts the activity.
  await card.getByRole("button", { name: "Comment", exact: true }).click();
  const draft = card.getByLabel("Add your reply");
  await draft.fill("Was the ending happy?");
  const review = await saveReview(
    id,
    "movie:998501",
    4,
    "Warm and bright.",
    false,
  );
  await expect(card).toHaveAttribute("data-item-id", review);
  await expect(byline.locator(".muted").first()).toHaveText(
    "finished, reviewed, and recommends",
  );
  await expect(card.locator(".review-stars")).toHaveText("★★★★☆");
  await expect(
    card.getByText("Warm and bright.", { exact: true }),
  ).toBeVisible();
  await expect(
    reader.getByRole("button", { name: "New activity (1)", exact: true }),
  ).toBeVisible();
  await expect(card).toHaveCount(1);
  await expect(draft).toHaveValue("Was the ending happy?");

  // The reply posts to the review that holds the card.
  const reply = card.locator("[data-comment-id]");
  await card.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    reply.getByText("Was the ending happy?", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await db.query("SELECT review_id FROM comment WHERE body=$1", [
        "Was the ending happy?",
      ])
    ).rows,
  ).toEqual([{ review_id: review }]);

  // An edit marks the card Edited. A spoiler flag covers the review's text
  // and the card's discussion, but not its stars.
  await saveReview(id, "movie:998501", 5, "The twist at the end!", true);
  await expect(byline).toContainText("Edited");
  await expect(card.locator(".review-stars")).toHaveText("★★★★★");
  await expect(
    card.getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
    }),
  ).toBeVisible();
  await expect(card.getByText("The twist at the end!")).toHaveCount(0);
  await expect(reply).toHaveCount(0);
});

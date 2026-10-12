import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { expectTextContrast, expectThemedPage } from "./contrast";
import { failAction } from "./action-errors";

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}
// The element fits the screen and the page never scrolls sideways.
async function expectOnScreen(page: Page, element: Locator, name: string) {
  const { width } = page.viewportSize()!;
  await element.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const bounds = await box(element);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `.cache/${name}-${width}.png` });
}

// Text stays readable and every color comes from the theme in both themes.
async function expectBothThemes(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectThemedPage(page, `${name} ${colorScheme}`);
    await page.screenshot({ path: `.cache/${name}-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("members rate, review, edit, and remove from the title page while friends read, reply, and react in every feed", async ({
  member,
}) => {
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview,release_date) VALUES
    ('movie:998301','movie',998301,'Paper Lanterns','A fictional film.','2022-04-01')
    ON CONFLICT DO NOTHING`);
  // Distinct names let the scenario repeat against the same database.
  const name = `review_${randomUUID().slice(0, 8)}`;
  const author = await member(name);
  const reader = await member(`${name}_reader`);
  await prepareFriendship(author, reader);
  await author.goto("/titles/movie/998301");
  const action = (label: string) =>
    author.getByRole("button", { name: label, exact: true });
  const form = author.getByRole("form", { name: "Your review" });
  const star = (count: number) =>
    form.getByRole("radio", {
      name: `${count} star${count === 1 ? "" : "s"}`,
      exact: true,
    });
  const text = form.getByRole("textbox", { name: "Your review (optional)" });
  const save = form.getByRole("button", { name: "Save review", exact: true });
  const entries = (page: Page) =>
    page.locator(".feed-entry").filter({
      has: page.getByRole("link", { name, exact: true }),
    });
  const own = entries(author);
  // An entry's author line, after the name.
  const byline = (entry: Locator) =>
    entry.locator(".activity-by > .muted").first();

  // The form opens on demand beneath the header buttons, starting on the
  // first star, and saves only with a rating or text.
  await expect(action("Rate or review")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(form).toHaveCount(0);
  await action("Rate or review").click();
  await expect(action("Rate or review")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(star(1)).toBeFocused();
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(form.getByLabel("Contains spoilers")).not.toBeChecked();
  for (const width of [390, 1366]) {
    await author.setViewportSize({ width, height: 844 });
    await expectOnScreen(author, form, "review-form");
  }
  // Native radios: Space chooses the focused star, arrows move the choice.
  await author.keyboard.press("Space");
  for (let i = 0; i < 3; i++) await author.keyboard.press("ArrowRight");
  await expect(star(4)).toBeChecked();
  await expect(star(4)).toBeFocused();
  // The transparent radio keeps the shared keyboard focus ring.
  expect(
    await star(4).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.outlineStyle, style.outlineWidth];
    }),
  ).toEqual(["solid", "3px"]);
  await author.screenshot({ path: ".cache/review-stars-focus.png" });
  await expect(form.locator(".star-choices label")).toHaveText([
    "★1 star",
    "★2 stars",
    "★3 stars",
    "★4 stars",
    "☆5 stars",
  ]);
  await expect(save).toHaveAttribute("aria-disabled", "false");
  await text.fill("Quiet, warm, and lovely to look at.");
  await expectBothThemes(author, "review-form-themes");
  // A failed save keeps the form and draft with the error.
  await failAction(author, "review", "Screenr is busy. Please try again.");
  await save.click();
  await expect(form.getByRole("alert")).toHaveText(
    "Screenr is busy. Please try again.",
  );
  await author.unroute("**/api/screenr/review");
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(action("Edit your review")).toBeFocused();
  await expect(own).toHaveCount(1);
  const id = (await own.getAttribute("data-item-id"))!;
  await expect(byline(own)).toHaveText("reviewed");
  await expect(own.locator(".activity-by")).not.toContainText("Edited");
  await expect(own.locator(".review-stars")).toHaveText(
    "★★★★☆Rated 4 stars out of 5",
  );
  await expect(own.locator(".comment-body")).toHaveText(
    "Quiet, warm, and lovely to look at.",
  );
  await expectTextContrast(own.locator(".review-stars-empty"));

  // A friend reads the full entry in the friends feed and on the author's
  // profile, then replies and reacts there.
  for (const path of ["/", `/people/${name}`]) {
    await reader.goto(path);
    const entry = reader.locator(`[data-item-id="${id}"]`);
    await expect(
      entry.getByRole("heading", { name: "Paper Lanterns" }),
    ).toBeVisible();
    await expect(byline(entry)).toHaveText("reviewed");
    await expect(entry.locator(".review-stars")).toContainText(
      "Rated 4 stars out of 5",
    );
    await expect(entry.locator(".comment-body")).toHaveText(
      "Quiet, warm, and lovely to look at.",
    );
  }
  const entry = reader.locator(`[data-item-id="${id}"]`);
  for (const width of [390, 1366]) {
    await reader.setViewportSize({ width, height: 844 });
    await expectOnScreen(reader, entry, "review-entry");
  }
  await expectBothThemes(reader, "review-entry-themes");
  await entry.getByRole("button", { name: "Comment", exact: true }).click();
  await entry.getByLabel("Add your reply").fill("Was the ending happy?");
  await entry.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(entry.getByText("Was the ending happy?")).toBeVisible();
  const reactions = entry.getByRole("group", {
    name: "Reactions to entry",
    exact: true,
  });
  await reactions.getByRole("button", { name: "React", exact: true }).click();
  await entry
    .getByRole("group", { name: "Choose a reaction", exact: true })
    .getByRole("button", { name: "Love", exact: true })
    .click();
  await expect(
    reactions.getByRole("button", { name: "Love: 1", exact: true }),
  ).toBeVisible();

  // The comment notifies the author and opens the review on the title page.
  const bell = author.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName("Notifications, 1 unread");
  await bell.click();
  const notice = author
    .getByRole("dialog", { name: "Notifications" })
    .getByRole("button", {
      name: new RegExp(
        `${name}_reader commented on your post about Paper Lanterns`,
      ),
    });
  await notice.click();
  await expect(author).toHaveURL(
    new RegExp(`/titles/movie/998301\\?item=${id}&reply=\\d+$`),
  );
  await expect(own.getByText("Was the ending happy?")).toBeVisible();

  // Editing starts from the saved review, updates the same entry in place
  // with an Edited label, and keeps its discussion and reactions.
  await action("Edit your review").click();
  await expect(star(4)).toBeChecked();
  await expect(star(4)).toBeFocused();
  await expect(text).toHaveValue("Quiet, warm, and lovely to look at.");
  // Cancel discards changes.
  await star(1).click();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(action("Edit your review")).toBeFocused();
  await action("Edit your review").click();
  await expect(star(4)).toBeChecked();
  await star(2).click();
  await text.fill("The ending: they never find the lanterns.");
  await form.getByLabel("Contains spoilers").check();
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(own).toHaveCount(1);
  await expect(own).toHaveAttribute("data-item-id", id);
  await expect(own.locator(".activity-by")).toContainText("· Edited");
  await expect(own.locator(".review-stars")).toContainText(
    "Rated 2 stars out of 5",
  );

  // The spoiler flag hides the text and discussion until revealed, but not
  // the rating.
  await reader.goto(`/titles/movie/998301`);
  const compact = reader.locator(`[data-item-id="${id}"]`);
  await expect(compact.locator(".activity-by")).toContainText("· Edited");
  await expect(compact.locator(".review-stars")).toContainText(
    "Rated 2 stars out of 5",
  );
  await expect(compact.getByText("they never find")).toHaveCount(0);
  await expect(compact.getByText("Was the ending happy?")).toHaveCount(0);
  await compact
    .getByRole("button", { name: "Contains spoilers · Reveal discussion" })
    .click();
  await expect(compact.locator(".comment-body").first()).toHaveText(
    "The ending: they never find the lanterns.",
  );
  await expect(compact.getByText("Was the ending happy?")).toBeVisible();
  await expect(
    compact.getByRole("button", { name: "Love: 1", exact: true }),
  ).toBeVisible();

  // A rating alone reads "rated".
  await action("Edit your review").click();
  await text.fill("");
  await form.getByLabel("Contains spoilers").uncheck();
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(byline(own)).toHaveText("rated");
  await expect(own.locator(".activity-content .comment-body")).toHaveCount(0);

  // Removal asks first, then erases the rating and text. The entry stays for
  // its reply, without reactions, until the author reviews again.
  await action("Edit your review").click();
  const remove = form.getByRole("button", {
    name: "Remove review",
    exact: true,
  });
  await remove.click();
  const confirmation = form.getByRole("group", {
    name: "Remove your review? Its rating and text will be erased.",
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await confirmation
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(form).toHaveCount(0);
  await expect(action("Rate or review")).toBeFocused();
  await expect(byline(own)).toHaveText("removed their review");
  await expect(own.locator(".review-stars")).toHaveCount(0);
  await expect(
    own.getByRole("button", { name: "React", exact: true }),
  ).toHaveCount(
    1, // the reply's
  );
  await reader.reload();
  await expect(byline(compact)).toHaveText("removed their review");
  await expect(compact.getByText("Was the ending happy?")).toBeVisible();

  // Reviewing again reuses the entry and its discussion.
  await action("Rate or review").click();
  await star(5).click();
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(own).toHaveAttribute("data-item-id", id);
  await expect(byline(own)).toHaveText("rated");
  await expect(own.getByText("Was the ending happy?")).toBeVisible();
});

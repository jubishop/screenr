import { expect, type Locator, type Page } from "@playwright/test";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { friend, person, userId } from "./member-fixture";
import { failAction } from "./action-errors";
import { keepThroughFailedRead, openWithoutPolling } from "./refresh-helpers";
import { expectThemedPage } from "./contrast";
import {
  chooseStatus,
  entryStatusButton,
  entryStatusName,
} from "./watch-status";

const { updateTitleActivity, watchStatus } =
  await import("../../src/server/title-actions");
const { saveReview } = await import("../../src/server/reviews");
const { addComment } = await import("../../src/server/comments");

// Feed entry actions as icons (docs/interface-design.md#icon-actions-on-feed-entries--2026-11-09).

async function titles(rows: [id: string, name: string][]) {
  for (const [id, name] of rows) {
    const [kind, tmdb] = id.split(":");
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,release_date) VALUES($1,$2,$3,$4,'2024-01-01')
      ON CONFLICT DO NOTHING`,
      [id, kind, Number(tmdb), name],
    );
  }
}
const action = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
// Where the reader saved each title to Want to watch, for usage telemetry.
async function saves(viewer: string) {
  return (
    await db.query(
      "SELECT title_id,surface FROM want_to_watch_save WHERE user_id=$1 ORDER BY title_id",
      [viewer],
    )
  ).rows;
}
// An icon button names its action, shows the name as its tooltip, and shows
// no text.
async function expectIcon(button: Locator, name: string) {
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName(name);
  await expect(button).toHaveAttribute("title", name);
  await expect(button).toHaveText("");
  await expect(button.locator("svg")).not.toHaveCount(0);
}

test("full feed entries offer the title actions, React, and Comment as named icons on one phone line, and compact entries keep React, Comment, and Reply", async ({
  member,
}) => {
  const page = await member("iconviewer");
  const viewer = await userId(page);
  const maya = await person("iconmaya", "Maya Icon");
  await friend(viewer, maya);
  await titles([
    ["tv:998401", "Harbor Lights"],
    ["movie:998402", "Paper Boats"],
  ]);
  // A friend's review, which Report adds to, and the reader's own entry.
  const review = await saveReview(
    maya,
    "tv:998401",
    4,
    "Slow, then wonderful.",
    false,
  );
  const reply = await addComment(maya, review!, "Season two is better", false);
  const own = await updateTitleActivity(
    viewer,
    "movie:998402",
    "recommended",
    true,
  );
  const names = [
    "Recommend",
    entryStatusName(),
    "Rate or review",
    "React",
    "Comment",
    "Copy link to discussion",
  ];

  for (const path of ["/", "/people/iconmaya"]) {
    await page.goto(path);
    const entry = page.locator(`[data-item-id="${review}"]`);
    const card = entry.locator(".activity-card");
    for (const name of names) await expectIcon(action(card, name), name);
    await expectIcon(action(card, "Report review"), "Report review");
    await expect(action(card, "Recommend")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expectIcon(
      entry.locator(`[data-comment-id="${reply}"]`).getByRole("button", {
        name: "Reply",
        exact: true,
      }),
      "Reply",
    );
    await expectIcon(
      entry
        .locator(`[data-comment-id="${reply}"]`)
        .getByRole("button", { name: "React", exact: true }),
      "React",
    );
    // Feeds offer no top 10 action.
    await expect(card.getByRole("button", { name: /top 10/i })).toHaveCount(0);
  }

  // The reader's own entry offers the same actions, showing their choices.
  await page.goto("/");
  const ownEntry = page.locator(`[data-item-id="${own}"] .activity-card`);
  await expect(action(ownEntry, "Recommend")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(action(ownEntry, "Recommend")).toHaveAttribute(
    "title",
    "Recommended",
  );
  for (const name of names.slice(1))
    await expectIcon(action(ownEntry, name), name);

  // At 390px, a full entry's title actions, React, Comment, the copy link,
  // and Report share one line.
  const entry = page.locator(`[data-item-id="${review}"] .activity-card`);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    await entry.scrollIntoViewIfNeeded();
    const tops = new Set<number>();
    for (const name of [...names, "Report review"]) {
      const bounds = await action(entry, name).boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      tops.add(Math.round(bounds!.y));
    }
    expect([...tops]).toHaveLength(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await entry.screenshot({ path: `.cache/feed-entry-icons-${width}.png` });
  }

  // Compact title page entries leave the title actions to the header but
  // keep React, Comment, and Reply as icons.
  await page.goto("/titles/tv/998401");
  const compact = page.locator(`[data-item-id="${review}"]`);
  await expect(compact).toHaveClass(/compact/);
  const compactCard = compact.locator(".activity-card");
  for (const name of names.slice(0, 3))
    await expect(action(compactCard, name)).toHaveCount(0);
  for (const name of ["React", "Comment", "Copy link to discussion"])
    await expectIcon(action(compactCard, name), name);
  await expectIcon(
    compact
      .locator(`[data-comment-id="${reply}"]`)
      .getByRole("button", { name: "Reply", exact: true }),
    "Reply",
  );
  await compact.screenshot({ path: ".cache/feed-entry-icons-compact.png" });
});

test("a feed entry's status menu sets and clears every status and the last-finished date, saving Want to watch from where it was chosen", async ({
  member,
}) => {
  const page = await member("iconstatus");
  const viewer = await userId(page);
  const maya = await person("iconstatusmaya", "Maya Status");
  await friend(viewer, maya);
  await titles([
    ["tv:998411", "Tide Tables"],
    ["movie:998412", "Glass Garden"],
    ["movie:998413", "North Window"],
  ]);
  const show = await updateTitleActivity(
    maya,
    "tv:998411",
    "recommended",
    true,
  );
  const movie = await updateTitleActivity(
    maya,
    "movie:998412",
    "want_to_watch",
    true,
  );
  const own = await updateTitleActivity(
    viewer,
    "movie:998413",
    "recommended",
    true,
  );
  await page.goto("/");
  const entry = page.locator(`[data-item-id="${show}"]`);
  const button = entryStatusButton(entry);
  const menu = entry.getByRole("menu", { name: "Watch status" });
  await expectIcon(button, entryStatusName());
  await expect(button).toHaveAttribute("aria-haspopup", "menu");

  // A TV title offers Caught up; each choice saves with the title page's
  // rules and shows on the icon.
  await button.click();
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Want to watch",
    "Watching",
    "Caught up",
    "Finished",
    "Stopped watching",
  ]);
  await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
  await page.screenshot({ path: ".cache/feed-entry-status-menu-390.png" });
  await expectThemedPage(page, "feed status menu");
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  for (const status of ["Want to watch", "Watching", "Caught up"]) {
    await chooseStatus(page, status, entry);
    await expectIcon(button, entryStatusName(status));
  }
  expect((await watchStatus(viewer, "tv:998411")).status).toBe("caught_up");
  // Finished sets the reader's local date, which the menu then edits.
  await chooseStatus(page, "Finished", entry);
  const today = await page.evaluate(() => {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
  });
  expect(await watchStatus(viewer, "tv:998411")).toEqual({
    status: "finished",
    finished_on: today,
  });
  await button.click();
  const date = entry.getByLabel("Last finished");
  await expect(date).toHaveValue(today);
  await date.fill("2026-10-01");
  await action(entry, "Save date").click();
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect
    .poll(async () => (await watchStatus(viewer, "tv:998411")).finished_on)
    .toBe("2026-10-01");
  await page.reload();
  await button.click();
  await expect(date).toHaveValue("2026-10-01");
  await action(entry, "Clear date").click();
  await expect
    .poll(async () => (await watchStatus(viewer, "tv:998411")).finished_on)
    .toBeNull();
  await chooseStatus(page, "Stopped watching", entry);
  await chooseStatus(page, "Clear status", entry);
  expect(await watchStatus(viewer, "tv:998411")).toEqual({
    status: null,
    finished_on: null,
  });

  // A movie offers no Caught up. Want to watch from a friend's entry reports
  // where it was saved.
  const movieEntry = page.locator(`[data-item-id="${movie}"]`);
  await entryStatusButton(movieEntry).click();
  await expect(
    movieEntry.getByRole("menu").getByRole("menuitemradio"),
  ).toHaveText(["Want to watch", "Watching", "Finished", "Stopped watching"]);
  await page.keyboard.press("Escape");
  await chooseStatus(page, "Want to watch", movieEntry);

  // The reader's own entry follows the same rules: Want to watch withdraws
  // its Recommend, so the entry leaves and focus moves to the nearest one.
  const ownEntry = page.locator(`[data-item-id="${own}"]`);
  await entryStatusButton(ownEntry).click();
  await ownEntry
    .getByRole("menu")
    .getByRole("menuitemradio", { name: "Want to watch", exact: true })
    .click();
  await expect(ownEntry).toBeHidden();
  await expect(page.locator("article.feed-entry:focus")).toHaveCount(1);
  expect((await watchStatus(viewer, "movie:998413")).status).toBe(
    "want_to_watch",
  );
  expect(await saves(viewer)).toEqual([
    { title_id: "movie:998412", surface: "friend_entry" },
    { title_id: "movie:998413", surface: null },
    { title_id: "tv:998411", surface: "friend_recommendation" },
  ]);

  // A failed change shows its message beneath the entry's action line.
  await failAction(page, "watch-status", "Screenr is busy. Please try again.");
  await entryStatusButton(movieEntry).click();
  await movieEntry
    .getByRole("menu")
    .getByRole("menuitemradio", { name: "Watching", exact: true })
    .click();
  await expect(movieEntry.locator(".action-error")).toHaveText(
    "Screenr is busy. Please try again.",
  );
  await expect(entryStatusButton(movieEntry)).toHaveAccessibleName(
    entryStatusName("Want to watch"),
  );
});

test("a feed entry's review editor saves, edits, and removes the reader's review", async ({
  member,
}) => {
  const page = await member("iconreview");
  const viewer = await userId(page);
  const maya = await person("iconreviewmaya", "Maya Review");
  await friend(viewer, maya);
  await titles([["movie:998421", "Lamplight"]]);
  const recommendation = await updateTitleActivity(
    maya,
    "movie:998421",
    "recommended",
    true,
  );
  await openWithoutPolling(page, "/");
  const entry = page.locator(`[data-item-id="${recommendation}"]`);
  const form = entry.getByRole("form", { name: "Your review" });
  const star = (count: number) =>
    form.getByRole("radio", {
      name: `${count} star${count === 1 ? "" : "s"}`,
      exact: true,
    });
  const text = form.getByRole("textbox", { name: "Your review (optional)" });
  const save = form.getByRole("button", { name: "Save review", exact: true });
  const ownReview = (page: Page) =>
    page.locator(".feed-entry").filter({
      has: page.getByRole("link", { name: "iconreview", exact: true }),
    });

  // The form opens beneath the entry's actions, on the first star.
  await expectIcon(action(entry, "Rate or review"), "Rate or review");
  await action(entry, "Rate or review").click();
  await expect(action(entry, "Rate or review")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(star(1)).toBeFocused();
  await star(4).check();
  await text.fill("A warm little film.");
  await page.screenshot({ path: ".cache/feed-entry-review-form-390.png" });
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(action(entry, "Edit your review")).toBeFocused();
  await expectIcon(action(entry, "Edit your review"), "Edit your review");
  await expect(ownReview(page)).toHaveCount(1);
  await expect(ownReview(page).locator(".review-stars")).toHaveText("★★★★☆");

  // Editing starts from the saved review, from any entry for the title.
  for (const scope of [entry, ownReview(page)]) {
    await action(scope, "Edit your review").click();
    const editor = scope.getByRole("form", { name: "Your review" });
    await expect(editor.getByRole("radio", { name: "4 stars" })).toBeChecked();
    await expect(
      editor.getByRole("textbox", { name: "Your review (optional)" }),
    ).toHaveValue("A warm little film.");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(action(scope, "Edit your review")).toBeFocused();
  }
  await action(entry, "Edit your review").click();
  await star(5).check();
  await save.click();
  await expect(ownReview(page).locator(".review-stars")).toHaveText("★★★★★");
  await expect(ownReview(page).locator(".activity-by")).toContainText("Edited");

  // Remove asks first, and a failed read keeps the question open.
  await action(entry, "Edit your review").click();
  const confirm = await keepThroughFailedRead(page, {
    open: form.getByRole("button", { name: "Remove review", exact: true }),
    question: "Remove your review? Its rating and text will be erased.",
    action: "Remove",
    content: entry.getByRole("heading", { name: "Lamplight" }),
  });
  await confirm.click();
  await expect(form).toHaveCount(0);
  await expect(action(entry, "Rate or review")).toBeFocused();
  await expect(ownReview(page)).toHaveCount(0);

  // Removing it from the reader's own review entry, which has no replies,
  // takes that entry out of the feed, so focus moves to the nearest entry.
  await action(entry, "Rate or review").click();
  await star(3).check();
  await save.click();
  await expect(ownReview(page)).toHaveCount(1);
  const mine = ownReview(page);
  await action(mine, "Edit your review").click();
  await mine
    .getByRole("form", { name: "Your review" })
    .getByRole("button", { name: "Remove review", exact: true })
    .click();
  await mine
    .getByRole("group", { name: /^Remove your review\?/ })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(ownReview(page)).toHaveCount(0);
  await expect(
    page.locator(`article[data-item-id="${recommendation}"]`),
  ).toBeFocused();
});

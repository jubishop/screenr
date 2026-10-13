import { expect, type Page } from "@playwright/test";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { friend, person } from "./member-fixture";
import { chooseStatus } from "./watch-status";

const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");

async function recommend(owner: string, title: string, at: string) {
  const item = await updateTitleActivity(owner, title, "recommended", true);
  await db.query("UPDATE feed_item SET activity_at=$2 WHERE id=$1", [item, at]);
}
async function saves(viewer: string) {
  return (
    await db.query(
      `SELECT title_id,surface,friend_recommending FROM want_to_watch_save
      WHERE user_id=$1 ORDER BY title_id`,
      [viewer],
    )
  ).rows;
}
const refresh = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("focus")));

test("Friends recommend lists friends' recommendations, filters by type, and saves to Want to watch", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "recommendviewer");
  await page.goto("/search");
  const tabs = page.getByRole("navigation", { name: "Find a title lists" });
  const friendsTab = tabs.getByRole("link", { name: "Friends recommend" });
  const suggestionsTab = tabs.getByRole("link", { name: "Suggestions" });
  await expect(suggestionsTab).toHaveAttribute("aria-current", "page");
  await friendsTab.click();
  await expect(page).toHaveURL(/\/search\?tab=friends-recommend$/);
  await expect(friendsTab).toHaveAttribute("aria-current", "page");
  await expect(suggestionsTab).not.toHaveAttribute("aria-current");
  await expect(
    page.getByRole("heading", { name: "No recommendations yet." }),
  ).toBeVisible();

  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview,release_date) VALUES
    ('movie:987654','movie',987654,'The Lantern Room','A fictional coastal story.','2026-06-12'),
    ('tv:998001','tv',998001,'The Harbor Signal','A fictional mystery.','2025-09-01'),
    ('movie:987671','movie',987671,'The Quiet Pier','A fictional harbor town.','2024-03-08')
    ON CONFLICT(id) DO NOTHING`);
  const maya = await person("recommendmaya", "Maya Chen");
  const theo = await person("recommendtheo", "Theo Park");
  const sam = await person("recommendsam", "Sam Okafor");
  for (const id of [maya, theo, sam]) await friend(viewer, id);
  // Two friends outrank one; then the newest recommendation leads.
  await recommend(maya, "movie:987654", "2026-01-01");
  await recommend(theo, "movie:987654", "2026-01-02");
  await recommend(sam, "tv:998001", "2026-01-03");
  await recommend(theo, "movie:987671", "2026-01-04");
  await refresh(page);
  const list = page.getByRole("region", {
    name: "Friends recommend",
    exact: true,
  });
  const card = (name: string) =>
    page.locator(".title-card").filter({
      has: page.getByRole("heading", { name, exact: true }),
    });
  await expect(list.getByRole("heading")).toHaveText([
    "The Lantern Room",
    "The Quiet Pier",
    "The Harbor Signal",
  ]);
  await expect(card("The Lantern Room").locator(".recommenders")).toHaveText(
    "Recommended by Theo Park and Maya Chen",
  );
  await expect(card("The Harbor Signal").locator(".recommenders")).toHaveText(
    "Recommended by Sam Okafor",
  );

  const kinds = page.getByRole("group", { name: "Title type" });
  for (const [kind, names] of [
    ["TV", ["The Harbor Signal"]],
    ["Movies", ["The Lantern Room", "The Quiet Pier"]],
    ["All", ["The Lantern Room", "The Quiet Pier", "The Harbor Signal"]],
  ] as const) {
    const button = kinds.getByRole("button", { name: kind, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(list.getByRole("heading")).toHaveText(names);
  }

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.cache/friends-recommend-${width}.png`,
      fullPage: true,
    });
  }

  // The inline action saves with the Friends recommend surface.
  const lantern = card("The Lantern Room").getByRole("group", {
    name: "The Lantern Room",
  });
  await lantern.getByRole("button", { name: "+ Want to watch" }).click();
  await expect(
    lantern.getByRole("button", { name: "✓ Want to watch" }),
  ).toBeVisible();
  expect(await saves(viewer)).toEqual([
    {
      title_id: "movie:987654",
      surface: "friends_recommend",
      friend_recommending: true,
    },
  ]);

  // A title page opened from here reports the same surface.
  const harbor = card("The Harbor Signal").getByRole("link", {
    name: /^The Harbor Signal/,
  });
  await expect(harbor).toHaveAttribute(
    "href",
    "/titles/tv/998001?from=friends_recommend",
  );
  await harbor.click();
  await expect(page).toHaveURL(/\/titles\/tv\/998001\?from=friends_recommend$/);
  await chooseStatus(page, "Want to watch");
  expect(await saves(viewer)).toEqual([
    {
      title_id: "movie:987654",
      surface: "friends_recommend",
      friend_recommending: true,
    },
    {
      title_id: "tv:998001",
      surface: "friends_recommend",
      friend_recommending: true,
    },
  ]);
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?tab=friends-recommend$/);
  await expect(
    card("The Harbor Signal").getByRole("button", { name: "✓ Want to watch" }),
  ).toBeVisible();

  // Another status, or the viewer's own Recommend, links to the title page.
  await updateWatchStatus(viewer, "movie:987654", "watching");
  await updateTitleActivity(viewer, "movie:987671", "recommended", true);
  await refresh(page);
  for (const [name, label] of [
    ["The Lantern Room", "✓ Watching"],
    ["The Quiet Pier", "✓ Recommended"],
  ]) {
    const status = card(name).getByRole("link", { name: label, exact: true });
    await expect(status).toHaveAttribute(
      "href",
      new RegExp(`\\?from=friends_recommend$`),
    );
    await expect(card(name).getByRole("button")).toHaveCount(0);
  }

  // Removing Want to watch keeps the title listed.
  await card("The Harbor Signal")
    .getByRole("button", { name: "✓ Want to watch" })
    .click();
  await expect(
    card("The Harbor Signal").getByRole("button", { name: "+ Want to watch" }),
  ).toBeVisible();
});

test("the Find a title tab stays in the URL through search, history, and reloads", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "recommendtabs");
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview) VALUES
    ('movie:987654','movie',987654,'The Lantern Room','A fictional coastal story.')
    ON CONFLICT(id) DO NOTHING`);
  const maya = await person("recommendtabsmaya", "Maya Chen");
  await friend(viewer, maya);
  await recommend(maya, "movie:987654", "2026-01-01");
  await page.goto("/search?tab=friends-recommend");
  const tabs = page.getByRole("navigation", { name: "Find a title lists" });
  const list = page.getByRole("region", {
    name: "Friends recommend",
    exact: true,
  });
  const suggestions = page.getByRole("region", {
    name: "Title suggestions",
    exact: true,
  });
  const results = page.getByRole("region", {
    name: "Search results",
    exact: true,
  });
  await expect(list.getByRole("heading")).toHaveText(["The Lantern Room"]);
  await expect(suggestions).toHaveCount(0);

  // A search replaces the tabs and keeps the tab for when it clears.
  const input = page.getByLabel("Movie or show title");
  await input.fill("The Lantern Room");
  await input.press("Enter");
  await expect(page).toHaveURL(
    /\/search\?tab=friends-recommend&q=The\+Lantern\+Room$/,
  );
  await expect(results.getByRole("heading")).toHaveText(["The Lantern Room"]);
  await expect(tabs).toHaveCount(0);
  await expect(list).toHaveCount(0);
  await input.fill("");
  await expect(page).toHaveURL(/\/search\?tab=friends-recommend$/);
  await expect(list.getByRole("heading")).toHaveText(["The Lantern Room"]);

  // Each tab is a history entry, chosen by keyboard or pointer.
  await tabs.getByRole("link", { name: "Suggestions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search$/);
  await expect(suggestions.getByRole("link")).toHaveText([/The Lantern Room/]);
  await expect(list).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?tab=friends-recommend$/);
  await expect(list.getByRole("heading")).toHaveText(["The Lantern Room"]);
  await page.reload();
  await expect(
    tabs.getByRole("link", { name: "Friends recommend" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("heading")).toHaveText(["The Lantern Room"]);
  await page.goForward();
  await expect(page).toHaveURL(/\/search$/);
  await expect(suggestions.getByRole("link")).toHaveCount(1);
});

test("Friends recommend hides titles the viewer finished until Show finished is on", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "recommendfinished");
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview) VALUES
    ('movie:987654','movie',987654,'The Lantern Room','A fictional coastal story.'),
    ('tv:998001','tv',998001,'The Harbor Signal','A fictional mystery.')
    ON CONFLICT(id) DO NOTHING`);
  const maya = await person("recommendfinishedmaya", "Maya Chen");
  await friend(viewer, maya);
  await recommend(maya, "movie:987654", "2026-01-02");
  await recommend(maya, "tv:998001", "2026-01-01");
  await updateWatchStatus(viewer, "movie:987654", "finished");
  await page.goto("/search?tab=friends-recommend");
  const tabs = page.getByRole("navigation", { name: "Find a title lists" });
  const list = page.getByRole("region", {
    name: "Friends recommend",
    exact: true,
  });
  const card = (name: string) =>
    page.locator(".title-card").filter({
      has: page.getByRole("heading", { name, exact: true }),
    });
  const showFinished = page.getByRole("button", {
    name: "Show finished",
    exact: true,
  });
  await expect(list.getByRole("heading")).toHaveText(["The Harbor Signal"]);
  await expect(showFinished).toHaveAttribute("aria-pressed", "false");
  await showFinished.click();
  await expect(showFinished).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("heading")).toHaveText([
    "The Lantern Room",
    "The Harbor Signal",
  ]);
  await expect(
    card("The Lantern Room").getByRole("link", {
      name: "✓ Finished",
      exact: true,
    }),
  ).toBeVisible();

  // Like the Movies/TV filter, the switch keeps its state across tabs, and
  // each visit starts with Finished titles hidden.
  await tabs.getByRole("link", { name: "Suggestions" }).click();
  await expect(list).toHaveCount(0);
  await tabs.getByRole("link", { name: "Friends recommend" }).click();
  await expect(showFinished).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("heading")).toHaveCount(2);
  await page.reload();
  await expect(showFinished).toHaveAttribute("aria-pressed", "false");
  await expect(list.getByRole("heading")).toHaveText(["The Harbor Signal"]);

  // Finishing a title on its page hides it here.
  await card("The Harbor Signal")
    .getByRole("link", { name: /^The Harbor Signal/ })
    .click();
  await chooseStatus(page, "Finished");
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?tab=friends-recommend$/);
  await expect(
    page.getByText(
      "You finished all 2 recommendations. Turn on Show finished to see them.",
    ),
  ).toBeVisible();
  await expect(list.getByRole("heading")).toHaveCount(0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.cache/friends-recommend-finished-${width}.png`,
      fullPage: true,
    });
  }
  await showFinished.click();
  await expect(list.getByRole("heading")).toHaveText([
    "The Lantern Room",
    "The Harbor Signal",
  ]);
});

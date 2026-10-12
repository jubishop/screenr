import { expect, type Locator } from "@playwright/test";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { friend, userId } from "./member-fixture";
import { chooseStatus } from "./watch-status";

const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");

test("title and feed actions switch exclusively and restore each original discussion", async ({
  page,
  member,
  signIn,
}) => {
  const ownerPage = await member("exclusiveowner");
  const owner = await userId(ownerPage);
  const viewer = await signIn(page, "exclusiveviewer");
  await friend(owner, viewer);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('movie:987654','movie',987654,'The Lantern Room') ON CONFLICT DO NOTHING`);
  const friendItem = await updateTitleActivity(
    owner,
    "movie:987654",
    "recommended",
    true,
  );
  const recommendation = await updateTitleActivity(
    viewer,
    "movie:987654",
    "recommended",
    true,
  );
  const recommendationReply = await addComment(
    owner,
    recommendation,
    "Recommendation discussion",
    false,
  );
  const wanted = await updateTitleActivity(
    viewer,
    "movie:987654",
    "want_to_watch",
    true,
  );
  const wantedReply = await addComment(
    owner,
    wanted,
    "Watch discussion",
    false,
  );
  await updateTitleActivity(viewer, "movie:987654", "recommended", true);
  await page.setViewportSize({ width: 390, height: 900 });

  const button = (scope: Locator, name: string) =>
    scope.getByRole("button", { name, exact: true });
  async function states(
    scope: Locator,
    recommended: boolean,
    want: boolean,
    title = false,
  ) {
    await expect(
      button(
        scope,
        recommended
          ? "✓ Recommended"
          : title
            ? "Recommend to friends"
            : "+ Recommend",
      ),
    ).toBeVisible();
    await expect(
      button(scope, want ? "✓ Want to watch" : "+ Want to watch"),
    ).toBeVisible();
    await expect(
      button(
        scope,
        recommended
          ? title
            ? "Recommend to friends"
            : "+ Recommend"
          : "✓ Recommended",
      ),
    ).toHaveCount(0);
    await expect(
      button(scope, want ? "+ Want to watch" : "✓ Want to watch"),
    ).toHaveCount(0);
  }
  // Title page entries are compact; their header owns the title actions.
  for (const path of ["/people/exclusiveowner", "/"]) {
    await page.goto(path);
    const entry = page.locator(`[data-item-id="${friendItem}"]`);
    await states(entry, true, false);
    await button(entry, "+ Want to watch").click();
    await states(entry, false, true);
    await page.reload();
    await states(entry, false, true);
    await button(entry, "+ Recommend").click();
    await states(entry, true, false);
    await button(entry, "✓ Recommended").click();
    await states(entry, false, false);
    await button(entry, "+ Recommend").click();
    await states(entry, true, false);
    await page.reload();
    await states(entry, true, false);
  }

  await page.goto("/titles/movie/987654");
  for (const name of ["+ Want to watch", "+ Recommend", "✓ Recommended"])
    await expect(
      button(page.locator(`[data-item-id="${friendItem}"]`), name),
    ).toHaveCount(0);
  // The title header's status menu chooses Want to watch.
  const header = page.locator(".title-hero .inline-actions");
  await states(header, true, false, true);
  await chooseStatus(page, "Want to watch");
  await states(header, false, true, true);
  const recEntry = page.locator(`[data-item-id="${recommendation}"]`);
  const watchEntry = page.locator(`[data-item-id="${wanted}"]`);
  await expect(recEntry).toContainText("removed their recommendation");
  await expect(
    recEntry.locator(`[data-comment-id="${recommendationReply}"]`),
  ).toContainText("Recommendation discussion");
  await expect(
    watchEntry.locator(`[data-comment-id="${wantedReply}"]`),
  ).toContainText("Watch discussion");
  await chooseStatus(page, "Clear status");
  await states(header, false, false, true);
  await chooseStatus(page, "Want to watch");
  await states(header, false, true, true);
  await expect(watchEntry).toContainText("wants to watch");
  await button(header, "Recommend to friends").click();
  await states(header, true, false, true);
  await expect(recEntry).toContainText("recommends");
  await expect(
    recEntry.locator(`[data-comment-id="${recommendationReply}"]`),
  ).toContainText("Recommendation discussion");
  await expect(watchEntry).toContainText("removed Want to watch");
  await page.reload();
  await states(header, true, false, true);
  await expect(
    watchEntry.locator(`[data-comment-id="${wantedReply}"]`),
  ).toContainText("Watch discussion");

  await page.goto("/");
  const friendEntry = page.locator(`[data-item-id="${friendItem}"]`);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await friendEntry.scrollIntoViewIfNeeded();
    const watchBounds = await button(
      friendEntry,
      "+ Want to watch",
    ).boundingBox();
    const recommendBounds = await button(
      friendEntry,
      "✓ Recommended",
    ).boundingBox();
    expect(recommendBounds!.y).toBeGreaterThanOrEqual(watchBounds!.y);
    if (recommendBounds!.y === watchBounds!.y)
      expect(recommendBounds!.x).toBeGreaterThan(watchBounds!.x);
    expect(recommendBounds!.x + recommendBounds!.width).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: `.cache/exclusive-actions-${width}.png`,
      fullPage: true,
    });
  }
  // The friend's own choice is unaffected by the viewer's changes.
  await ownerPage.goto("/people/exclusiveviewer");
  await states(
    ownerPage.locator(`[data-item-id="${recommendation}"]`),
    true,
    false,
  );
});

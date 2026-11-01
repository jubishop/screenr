import { expect, type Locator, type Page } from "@playwright/test";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";
import { friend, person } from "./member-fixture";
import { fromToday } from "./release-titles";
import { storeTitle } from "./stored-titles";

const { updateTitleActivity } = await import("../../src/server/title-actions");

// TMDB's user score (docs/title-catalog.md#tmdb-user-score-implementation):
// the unmodified TMDB logo and a whole percentage beside the release status.
const widths = [1366, 390, 320];

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

// The badge reads as the logo, then the score, on one line beside the
// release status, and the logo has loaded at about the height of the text.
async function expectScore(status: Locator, percent: string) {
  const score = status.locator(".tmdb-score");
  await expect(score).toHaveText(percent);
  const logo = score.getByRole("img", { name: "TMDB" });
  await expect(logo).toHaveAttribute("src", "/tmdb.svg");
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const [image, text] = await Promise.all([
    logo.boundingBox(),
    score.boundingBox(),
  ]);
  expect(image!.height).toBeGreaterThanOrEqual(8);
  expect(image!.height).toBeLessThanOrEqual(12);
  expect(image!.width / image!.height).toBeCloseTo(273.42 / 35.52, 0);
  expect(text!.height).toBeLessThan(30);
  await expectTextContrast(score);
}

test("title pages show the TMDB logo and score beside the release status only with 20 votes", async ({
  page,
  signIn,
}) => {
  await signIn(page, "scorepage");
  const showing = await storeTitle(
    "movie:996600",
    "Rated Showing",
    { theatrical: [fromToday(-5)], digital: [] },
    { average: 7.346, count: 312 },
  );
  expect(showing).toBe("In theaters");
  await storeTitle(
    "tv:996601",
    "Rated Without Dates",
    { premiere: fromToday(-900), network: "Netflix", seasons: [] },
    { average: 8.15, count: 20 },
  );
  await storeTitle(
    "movie:996602",
    "Barely Rated",
    { theatrical: [fromToday(-5)], digital: [] },
    { average: 9.9, count: 19 },
  );

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/titles/movie/996600");
    const status = page
      .getByRole("region", { name: "Where to watch" })
      .locator(".title-status");
    await expect(status.locator(".release-status")).toHaveText(showing);
    await expectScore(status, "73%");
    await noOverflow(page);
    await page.screenshot({ path: `.cache/score-title-${width}.png` });

    // A score shows even when the title has no release label.
    await page.goto("/titles/tv/996601");
    const alone = page
      .getByRole("region", { name: "Where to watch" })
      .locator(".title-status");
    await expect(alone.locator(".release-status")).toHaveCount(0);
    await expectScore(alone, "82%");
    await noOverflow(page);
  }

  // Fewer than 20 votes show no score, and no logo.
  await page.goto("/titles/movie/996602");
  await expect(
    page
      .getByRole("region", { name: "Where to watch" })
      .locator(".title-status"),
  ).toHaveText("In theaters");
  await expect(page.locator(".tmdb-score")).toHaveCount(0);
  await expect(page.locator('img[src="/tmdb.svg"]')).toHaveCount(0);
});

test("title cards show the TMDB score in Find a title and Watch together", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "scorecards");
  const other = await person("scorecardsfriend", "Sky Friend");
  await friend(viewer, other);
  await storeTitle(
    "movie:996610",
    "Scored Favorite",
    { theatrical: [fromToday(-400)], digital: [] },
    { average: 6.95, count: 58 },
  );
  await storeTitle(
    "movie:996611",
    "Unscored Share",
    { theatrical: [fromToday(-3)], digital: [] },
    { average: 8, count: 3 },
  );
  await storeTitle(
    "movie:996612",
    "Scored Share",
    { theatrical: [fromToday(-400)], digital: [] },
    { average: 6.04, count: 40 },
  );
  await updateTitleActivity(other, "movie:996610", "recommended", true);
  for (const id of [viewer, other]) {
    await updateTitleActivity(id, "movie:996611", "want_to_watch", true);
    await updateTitleActivity(id, "movie:996612", "want_to_watch", true);
  }

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });

    // A circle suggestion tile, then catalog results from TMDB's search.
    await page.goto("/search");
    const tile = page
      .getByRole("region", { name: "Title suggestions" })
      .getByRole("link", { name: /Scored Favorite/ });
    await expectScore(tile.locator(".title-status"), "70%");
    await noOverflow(page);
    await page.getByLabel("Movie or show title").fill("release dates");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const results = page.getByRole("region", { name: "Search results" });
    const lanterns = results.getByRole("link", { name: /Lanterns at Dusk/ });
    await expectScore(lanterns.locator(".title-status"), "71%");
    await expect(lanterns.locator(".title-status .release-status")).toHaveText(
      /^In theaters · Digital /,
    );
    // An unreleased show TMDB members have not rated shows no score.
    const tidewater = results.getByRole("link", { name: /Tidewater Hour/ });
    await expect(tidewater.locator(".release-status")).toBeVisible();
    await expect(tidewater.locator(".tmdb-score")).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: `.cache/score-search-${width}.png` });

    await page.goto("/watch-together?with=scorecardsfriend");
    const shared = page.getByRole("link", { name: /Scored Share/ });
    await expectScore(shared.locator(".title-status"), "60%");
    // Too few votes keep the release status without a score.
    const unscored = page.getByRole("link", { name: /Unscored Share/ });
    await expect(unscored.locator(".release-status")).toHaveText("In theaters");
    await expect(unscored.locator(".tmdb-score")).toHaveCount(0);
    await noOverflow(page);
  }
});

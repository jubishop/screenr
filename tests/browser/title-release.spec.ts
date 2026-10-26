import { expect, type Page } from "@playwright/test";
import { db } from "./database-fixture";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";
import { friend, person } from "./member-fixture";
import { fromToday } from "./release-titles";
import type { StoredRelease } from "../../src/server/title-release";

const { updateTitleActivity } = await import("../../src/server/title-actions");
const { titleRelease } = await import("../../src/server/title-release");

const widths = [1366, 390, 320];

// Stores a title with current details and US release data, so pages read it
// without the catalog. A null release leaves the status unavailable.
async function storeTitle(
  id: string,
  name: string,
  release: StoredRelease | null,
) {
  const [kind, tmdbId] = id.split(":");
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name,overview,release_date,release)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      id,
      kind,
      tmdbId,
      name,
      "A fictional title for release status checks.",
      fromToday(-200),
      release && JSON.stringify(release),
    ],
  );
  // The label the server derives today, such as "In theaters · Digital Dec 9".
  const status = titleRelease(kind as "movie" | "tv", release);
  return [
    ...(status.in_theaters ? ["In theaters"] : []),
    ...status.upcoming.map((date) => date.label),
  ].join(" · ");
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("title pages show the release status above Where to watch's options at each width", async ({
  page,
  signIn,
}) => {
  await signIn(page, "releasepage");
  const showing = await storeTitle("movie:996300", "Now Showing", {
    theatrical: [fromToday(-5)],
    digital: [fromToday(20)],
  });
  const premiere = await storeTitle("tv:996301", "Coming Tide", {
    premiere: fromToday(9),
    network: "An exceptionally long streaming network name for narrow screens",
    seasons: [],
  });
  await storeTitle("movie:996302", "Unknown Release", null);
  expect(showing).toMatch(/^In theaters · Digital [A-Z][a-z]{2} \d{1,2}/);
  expect(premiere).toMatch(/^Premieres [A-Z][a-z]{2} \d{1,2}.* on An /);

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/titles/movie/996300");
    const whereToWatch = page.getByRole("region", { name: "Where to watch" });
    const status = whereToWatch.locator(".release-status");
    await expect(status).toHaveText(showing);
    // The digital date is never offered as a Subs or Free option.
    await expect(whereToWatch.getByRole("group")).toHaveCount(0);
    await expect(
      whereToWatch.getByText(
        "No subscription or free options are listed for the US.",
      ),
    ).toBeVisible();
    await expectTextContrast(status);
    await noOverflow(page);
    await page.screenshot({ path: `.cache/release-title-${width}.png` });

    await page.goto("/titles/tv/996301");
    await expect(
      page
        .getByRole("region", { name: "Where to watch" })
        .locator(".release-status"),
    ).toHaveText(premiere);
    await noOverflow(page);
  }

  // A title whose release data could not be loaded shows no label.
  await page.goto("/titles/movie/996302");
  await expect(
    page.getByRole("heading", { name: "Unknown Release" }),
  ).toBeVisible();
  await expect(page.locator(".release-status")).toHaveCount(0);
});

test("title cards show release status in Find a title, Friends recommend, Want to watch, and Watch together at each width", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "releasecards");
  const other = await person("releasecardsfriend", "Rae Friend");
  await friend(viewer, other);
  const recommended = await storeTitle("movie:996310", "Friend Favorite", {
    theatrical: [fromToday(-3)],
    digital: [],
  });
  const shared = await storeTitle("movie:996311", "Shared Opening", {
    theatrical: [fromToday(15)],
    digital: [fromToday(60)],
  });
  await storeTitle("movie:996312", "Shared Unknown", null);
  await updateTitleActivity(other, "movie:996310", "recommended", true);
  for (const id of [viewer, other]) {
    await updateTitleActivity(id, "movie:996311", "want_to_watch", true);
    await updateTitleActivity(id, "movie:996312", "want_to_watch", true);
  }
  // A free option puts the shared movie on the viewer's Want to watch page.
  await db.query(
    `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
    VALUES('movie:996311','US',$1,now(),now()+interval '1 day')`,
    [
      {
        link: null,
        providers: {
          free: [
            { provider_id: 73, provider_name: "Tubi TV", logo_path: null },
          ],
        },
      },
    ],
  );
  expect(shared).toMatch(/^In theaters [A-Z][a-z]{2} \d{1,2}.* · Digital /);

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });

    // Find a title's circle suggestions and catalog results.
    await page.goto("/search");
    const tile = page
      .getByRole("region", { name: "Title suggestions" })
      .getByRole("link", { name: /Friend Favorite/ });
    await expect(tile.locator(".release-status")).toHaveText(recommended);
    await noOverflow(page);
    await page.getByLabel("Movie or show title").fill("release dates");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const results = page.getByRole("region", { name: "Search results" });
    const result = (name: string) =>
      results.getByRole("link", { name: new RegExp(name) });
    await expect(
      result("Lanterns at Dusk").locator(".release-status"),
    ).toHaveText(/^In theaters · Digital [A-Z][a-z]{2} \d{1,2}/);
    await expect(
      result("The Tidewater Hour").locator(".release-status"),
    ).toHaveText(/^Premieres [A-Z][a-z]{2} \d{1,2}(, \d{4})? on Netflix$/);
    await expectTextContrast(
      result("Lanterns at Dusk").locator(".release-status"),
    );
    await noOverflow(page);
    await page.screenshot({ path: `.cache/release-search-${width}.png` });

    await page.goto("/search?tab=friends-recommend");
    const card = page.locator(".title-card", { hasText: "Friend Favorite" });
    await expect(card.locator(".release-status")).toHaveText(recommended);
    await noOverflow(page);

    await page.goto("/people/releasecards/want-to-watch");
    await expect(
      page
        .getByRole("link", { name: /Shared Opening/ })
        .locator(".release-status"),
    ).toHaveText(shared);
    await noOverflow(page);

    await page.goto("/watch-together?with=releasecardsfriend");
    const opening = page.getByRole("link", { name: /Shared Opening/ });
    await expect(opening.locator(".release-status")).toHaveText(shared);
    // An unknown release keeps the title listed without a label.
    const unknown = page.getByRole("link", { name: /Shared Unknown/ });
    await expect(unknown).toBeVisible();
    await expect(unknown.locator(".release-status")).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({
      path: `.cache/release-watch-together-${width}.png`,
      fullPage: true,
    });
  }
});

import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { friend, person } from "./member-fixture";
import { fromToday } from "./release-titles";
import { storeTitle } from "./stored-titles";

const { updateTitleActivity } = await import("../../src/server/title-actions");

// The At home and In theaters switch on Want to watch pages and Watch
// together (docs/want-to-watch.md#in-theaters). Release dates sit well inside
// or outside the theatrical window, so a date change during the run cannot
// move a movie; the application tests cover the window's edges.
const widths = [1440, 390, 320];

function mode(page: Page, name: "At home" | "In theaters") {
  return page.getByRole("link", { name, exact: true });
}
// A list section's title headings, by the section's heading.
function listed(page: Page, heading: string) {
  return page
    .locator(".watch-section", {
      has: page.getByRole("heading", { level: 2, name: heading, exact: true }),
    })
    .getByRole("heading", { level: 3 });
}

async function checkWidths(page: Page, name: string) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `.cache/in-theaters-${name}-${width}.png`,
      fullPage: true,
    });
  }
}

test("In theaters switches Want to watch pages and Watch together to movies in theaters and keeps the mode on reload", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "theaterviewer", {
    displayName: "Tess Viewer",
  });
  const other = await person("theaterfriend", "Theo Friend");
  await friend(viewer, other);
  const showing = await storeTitle("movie:996600", "Marquee Lights", {
    theatrical: [fromToday(-3)],
    digital: [fromToday(40)],
  });
  await storeTitle("movie:996601", "Second Week", {
    theatrical: [fromToday(-30)],
    digital: [],
  });
  await storeTitle("movie:996602", "Long Gone", {
    theatrical: [fromToday(-100)],
    digital: [],
  });
  await storeTitle("movie:996603", "Projector Fault", null);
  await storeTitle("tv:996604", "Lobby Show", {
    premiere: fromToday(-10),
    network: "Netflix",
    seasons: [],
  });
  await storeTitle("movie:996605", "Theo's Pick", {
    theatrical: [fromToday(-1)],
    digital: [],
  });
  expect(showing).toMatch(/^In theaters · Digital [A-Z][a-z]{2} \d{1,2}/);
  // Each save is newer than the one before it.
  for (const title of [
    "movie:996603",
    "tv:996604",
    "movie:996602",
    "movie:996601",
    "movie:996600",
  ])
    await updateTitleActivity(viewer, title, "want_to_watch", true);
  for (const title of [
    "movie:996603",
    "tv:996604",
    "movie:996600",
    "movie:996605",
  ])
    await updateTitleActivity(other, title, "want_to_watch", true);

  // The viewer's own page opens At home, with the switch above the filter.
  const own = "/people/theaterviewer/want-to-watch";
  await page.goto(own);
  await expect(mode(page, "At home")).toHaveAttribute("aria-current", "page");
  await expect(mode(page, "In theaters")).not.toHaveAttribute("aria-current");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toBeVisible();

  // In theaters lists the movies in theaters, newest first, then the movie
  // whose release data could not be loaded. No filter, services prompt, or
  // viewing options appear.
  await mode(page, "In theaters").click();
  await expect(page).toHaveURL(`${own}?mode=theaters`);
  await expect(page).toHaveTitle("Want to watch · Tess Viewer · Screenr");
  await expect(
    page.getByText(
      "Movies you want to watch that are in US theaters now, newest first.",
    ),
  ).toBeVisible();
  await expect(listed(page, "In theaters now")).toHaveText([
    "Marquee Lights",
    "Second Week",
  ]);
  await expect(listed(page, "Availability unknown")).toHaveText([
    "Projector Fault",
  ]);
  await expect(page.getByText("2 movies in theaters")).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: /Marquee Lights/ })
      .locator(".release-status"),
  ).toHaveText(showing);
  await expect(page.getByText("Long Gone")).toHaveCount(0);
  await expect(page.getByText("Lobby Show")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All" })).toHaveCount(0);
  await expect(page.getByText(/Save your streaming services/)).toHaveCount(0);
  await expect(page.getByText(/Viewing options|US availability/)).toHaveCount(
    0,
  );

  // A reload keeps In theaters.
  await page.reload();
  await expect(mode(page, "In theaters")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(listed(page, "In theaters now")).toHaveText([
    "Marquee Lights",
    "Second Week",
  ]);
  await checkWidths(page, "want-to-watch");

  // A friend's page lists the friend's movies, and At home switches back.
  await page.goto("/people/theaterfriend/want-to-watch?mode=theaters");
  await expect(listed(page, "In theaters now")).toHaveText([
    "Theo's Pick",
    "Marquee Lights",
  ]);
  await expect(listed(page, "Availability unknown")).toHaveText([
    "Projector Fault",
  ]);
  await mode(page, "At home").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/people/theaterfriend/want-to-watch");
  await expect(mode(page, "At home")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toBeVisible();

  // Watch together opens At home and switches to the shared movies in
  // theaters.
  const together = "/watch-together?with=theaterfriend";
  await page.goto(together);
  await expect(mode(page, "At home")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toBeVisible();
  await mode(page, "In theaters").click();
  await expect(page).toHaveURL(`${together}&mode=theaters`);
  await expect(listed(page, "In theaters now")).toHaveText(["Marquee Lights"]);
  await expect(listed(page, "Availability unknown")).toHaveText([
    "Projector Fault",
  ]);
  await expect(page.getByText("1 shared movie in theaters")).toBeVisible();
  await expect(page.getByRole("button", { name: "All" })).toHaveCount(0);
  await expect(page.getByText(/Save your streaming services/)).toHaveCount(0);
  await page.reload();
  await expect(mode(page, "In theaters")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(listed(page, "In theaters now")).toHaveText(["Marquee Lights"]);
  await checkWidths(page, "watch-together");

  // Selecting a movie opens its title page.
  await page.getByRole("link", { name: /Marquee Lights/ }).click();
  await expect(page).toHaveURL("/titles/movie/996600?from=watch_together");
  await page.goBack();
  await expect(page).toHaveURL(`${together}&mode=theaters`);

  // Refreshes drop a movie either person no longer wants, leaving the empty
  // state above the movie with unknown release data.
  await updateTitleActivity(other, "movie:996600", "want_to_watch", false);
  await expect(
    page.getByRole("heading", { name: "No shared movies in theaters." }),
  ).toBeVisible();
  await expect(listed(page, "In theaters now")).toHaveCount(0);
  await expect(listed(page, "Availability unknown")).toHaveText([
    "Projector Fault",
  ]);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: ".cache/in-theaters-watch-together-empty-390.png",
    fullPage: true,
  });
});

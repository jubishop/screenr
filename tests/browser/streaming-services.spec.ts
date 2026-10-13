import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { db } from "./database-fixture";
import { browserConfig } from "../../scripts/browser-config";
import fixtures from "../fixtures/streaming-titles.json" with { type: "json" };

const titles = fixtures.map((title) => `${title.media_type}:${title.id}`);
async function save(page: Page, serviceIds: string[]) {
  expect(
    (
      await page.request.post("/api/screenr/streaming-services", {
        headers: { Origin: browserConfig.baseURL },
        data: { serviceIds },
      })
    ).status(),
  ).toBe(200);
}
async function choose(page: Page, id: string, field: string) {
  expect(
    (
      await page.request.post("/api/screenr/activity", {
        headers: { Origin: browserConfig.baseURL },
        data: { title: id, field, value: true },
      })
    ).status(),
  ).toBe(200);
}
async function noOverflow(page: Page, prefix: string) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `.cache/${prefix}-${width}.png`,
      fullPage: true,
    });
  }
}

test("streaming preferences persist, cancel, survive a failed save, and clear on phone and desktop", async ({
  page,
  signIn,
}) => {
  await signIn(page, "streamingeditor");
  await page.goto("/account");
  const settings = page.getByRole("region", {
    name: "Your streaming services",
  });
  await settings.getByRole("button", { name: "Edit services" }).click();
  const find = settings.getByLabel("Find a service");
  await expect(find).toBeFocused();
  await find.fill("Netflix");
  await settings
    .getByRole("checkbox", { name: "Netflix", exact: true })
    .check();
  await find.fill("AMC");
  const amc = settings.getByRole("checkbox", { name: "AMC+", exact: true });
  await amc.focus();
  await amc.press("Space");
  await expect(
    settings.getByRole("status").filter({ hasText: "2 selected" }),
  ).toBeVisible();
  await noOverflow(page, "streaming-account");
  await page.route(
    "**/api/screenr/streaming-services",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await settings.getByRole("button", { name: "Save services" }).click();
  await expect(settings.getByRole("alert")).toBeVisible();
  await expect(
    settings.getByRole("checkbox", { name: "AMC+", exact: true }),
  ).toBeChecked();
  await settings.getByRole("button", { name: "Save services" }).click();
  await expect(
    settings.getByText("Services saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    settings.getByText("AMC+, Netflix", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Edit services" }).click();
  await settings.getByRole("button", { name: "Clear selections" }).click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Edit services" }),
  ).toBeFocused();
  await expect(
    settings.getByText("AMC+, Netflix", { exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Edit services" }).click();
  await settings.getByRole("button", { name: "Clear selections" }).click();
  await settings.getByRole("button", { name: "Save services" }).click();
  await expect(
    settings.getByText("No services selected.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    settings.getByText("No services selected.", { exact: true }),
  ).toBeVisible();
});

test("My services can be turned off when a preferences refresh fails", async ({
  page,
  signIn,
}) => {
  await signIn(page, "streamingrecovery");
  await save(page, ["service:netflix"]);
  await page.goto("/search");
  await page.getByLabel("Movie or show title").fill("streaming choices");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("region", { name: "Search results" });
  const filter = page.getByRole("button", { name: "My services", exact: true });
  await expect(results.getByRole("heading")).toHaveCount(5);
  await filter.click();
  await expect(results.getByRole("heading")).toHaveCount(2);
  await page.route("**/api/screenr/screen?**", (route) =>
    route.abort("failed"),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByText("Your services could not be loaded. Try refreshing."),
  ).toBeVisible();
  await expect(filter).toBeEnabled();
  await filter.click();
  await expect(results.getByRole("heading")).toHaveCount(5);
});

test("Find a title filters catalog results and suggestions using current services or free options", async ({
  page,
  signIn,
  member,
}) => {
  await signIn(page, "streamingsearch");
  const other = await member("streamingrecommender");
  await prepareFriendship(page, other);
  await save(page, ["service:netflix"]);
  await page.goto("/search");
  const query = page.getByRole("textbox", { name: "Movie or show title" });
  await query.fill("streaming choices");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("region", { name: "Search results" });
  const filter = page.getByRole("button", { name: "My services", exact: true });
  const summary = page.getByRole("status").filter({ hasText: /results?$/ });
  await expect(results.getByRole("heading")).toHaveText(
    fixtures.map((t) => t.name),
  );
  await expect(summary).toHaveText("5 results");
  // These fixtures have no release date, so cards show only the kind.
  await expect(results.getByText("Movie", { exact: true })).toHaveCount(3);
  await expect(results.getByText("TV show", { exact: true })).toHaveCount(2);
  await expect(results.locator(".search-result > svg:last-child")).toHaveCount(
    5,
  );
  await expect(results.getByText("↗")).toHaveCount(0);
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await expect(results.getByText("On AMC+", { exact: true })).toBeVisible();
  await expect(
    results.getByText("Free on Tubi TV", { exact: true }),
  ).toBeVisible();
  await expect(results.getByText(/via Amazon|with ads/)).toHaveCount(0);
  await filter.click();
  await expect(results.getByRole("heading")).toHaveText([
    "Night Crossing",
    "Night Orchard",
  ]);
  // The count follows the My services filter.
  await expect(summary).toHaveText("2 results");
  await expect(
    page.getByText(/1 title has unknown viewing options/),
  ).toBeVisible();
  await save(page, ["service:amc-plus"]);
  await expect(results.getByRole("heading")).toHaveText([
    "Night Harbor",
    "Night Orchard",
  ]);
  await expect(query).toHaveValue("streaming choices");
  await filter.click();
  await expect(results.getByRole("heading")).toHaveCount(5);
  for (const id of titles) await choose(other, id, "recommended");
  await query.fill("");
  const suggestions = page.getByRole("region", { name: "Title suggestions" });
  await expect(suggestions.getByRole("link")).toHaveCount(5);
  await filter.click();
  await expect(suggestions.getByRole("heading")).toHaveText([
    "Night Orchard",
    "Night Harbor",
  ]);
  // The page-wide filter stays on for the Friends recommend tab.
  const tabs = page.getByRole("navigation", { name: "Find a title lists" });
  await tabs.getByRole("link", { name: "Friends recommend" }).click();
  const recommended = page.getByRole("region", {
    name: "Friends recommend",
    exact: true,
  });
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(recommended.getByRole("heading")).toHaveText([
    "Night Orchard",
    "Night Harbor",
  ]);
  await expect(
    recommended.getByText("Included in your saved services"),
  ).toHaveCount(1);
  await expect(
    page.getByText(/1 title has unknown viewing options/),
  ).toBeVisible();
  await noOverflow(page, "streaming-recommend");
  await tabs.getByRole("link", { name: "Suggestions" }).click();
  await noOverflow(page, "streaming-search");
  await save(page, []);
  await expect(suggestions.getByRole("heading")).toHaveText(["Night Orchard"]);
  await filter.click();
  await expect(suggestions.getByRole("link")).toHaveCount(5);
});

test("Watch together groups either member's services and free titles ahead of unmatched and unknown picks", async ({
  page,
  signIn,
  member,
}) => {
  await signIn(page, "streamingpair");
  const other = await member("streamingpartner");
  await prepareFriendship(page, other);
  await save(page, ["service:netflix"]);
  await save(other, ["service:amc-plus", "service:hulu"]);
  for (const id of titles)
    for (const person of [page, other])
      await choose(person, id, "want_to_watch");
  // Rows show the whole description, clamped to two lines on desktop.
  const overview = Array(8)
    .fill("A night ferry crosses a quiet harbor while old friends")
    .join(" and ");
  await db.query("UPDATE title SET overview=$1 WHERE id=$2", [
    overview,
    "movie:939103",
  ]);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/watch-together?with=streamingpartner");
  const prompt = page.getByRole("link", {
    name: "Save your streaming services to see what you can watch right now.",
    exact: true,
  });
  const ready = page.getByRole("region", {
    name: "Ready to watch",
    exact: true,
  });
  const unavailable = page.getByRole("region", {
    name: "Not on your services",
    exact: true,
  });
  const unknown = page.getByRole("region", {
    name: "Availability unknown",
    exact: true,
  });
  await expect(ready.getByRole("heading", { level: 3 })).toHaveText([
    "Night Orchard",
    "Night Harbor",
    "Night Crossing",
  ]);
  await expect(unavailable.getByRole("heading", { level: 3 })).toHaveText([
    "Night Market",
  ]);
  await expect(unknown.getByRole("heading", { level: 3 })).toHaveText([
    "Night Signal",
  ]);
  await expect(ready.getByText("On AMC+ ✓", { exact: true })).toBeVisible();
  await expect(prompt).toHaveCount(0);
  const description = ready
    .getByRole("link")
    .filter({ hasText: "Night Orchard" })
    .locator(".overview");
  await expect(description).toHaveText(overview);
  expect(
    await description.evaluate((element) => ({
      lines: Math.round(
        element.clientHeight / parseFloat(getComputedStyle(element).lineHeight),
      ),
      clamped: element.scrollHeight > element.clientHeight,
    })),
  ).toEqual({ lines: 2, clamped: true });
  await expect(page.locator(".search-result > svg:last-child")).toHaveCount(5);
  await expect(page.getByText(/via Amazon|with ads/)).toHaveCount(0);
  await noOverflow(page, "streaming-together");
  await page.getByRole("button", { name: "TV", exact: true }).click();
  await expect(ready.getByRole("heading", { level: 3 })).toHaveText([
    "Night Harbor",
  ]);
  await expect(unknown.getByRole("heading", { level: 3 })).toHaveText([
    "Night Signal",
  ]);
  await save(other, []);
  await expect(ready).toHaveCount(0);
  await expect(unavailable.getByRole("heading", { level: 3 })).toHaveText([
    "Night Harbor",
  ]);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(ready.getByRole("heading", { level: 3 })).toHaveText([
    "Night Orchard",
    "Night Crossing",
  ]);
  await unavailable
    .getByRole("link")
    .filter({ hasText: "Night Harbor" })
    .click();
  await expect(page).toHaveURL("/titles/tv/939102?from=watch_together");
  const availability = page.getByRole("region", { name: "Where to watch" });
  await expect(availability.getByRole("listitem")).toHaveText(["AMC+"]);
  // Without saved services of their own, the viewer is prompted to add them.
  await save(page, []);
  await page.goto("/watch-together?with=streamingpartner");
  await expect(prompt).toBeVisible();
  await noOverflow(page, "streaming-together-prompt");
  await prompt.click();
  await expect(page).toHaveURL("/account#streaming-services");
  await expect(
    page.getByRole("region", { name: "Your streaming services" }),
  ).toBeInViewport();
});

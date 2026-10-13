import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

async function noOverflow(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    width,
  );
}
const options = (select: Locator) => select.locator("option").allTextContents();

test("TV discussion posts take a season or episode label from TMDB pickers that stays outside the spoiler cover", async ({
  member,
}) => {
  test.setTimeout(120_000);
  const owner = await member("labelowner");
  const reader = await member("labelreader");
  await prepareFriendship(owner, reader);
  await owner.goto("/titles/tv/998020");
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  const composer = owner.getByRole("form", { name: "New title comment" });
  const season = composer.getByLabel("Season", { exact: true });
  const episode = composer.getByLabel("Episode", { exact: true });
  // Specials have no "Season N" label, so the picker leaves them out.
  await expect(season).toBeEnabled();
  expect(await options(season)).toEqual(["No season", "Season 1", "Season 2"]);
  await expect(episode).toHaveCount(0);
  await season.selectOption({ label: "Season 2" });
  await expect(episode).toBeEnabled();
  // Episode names appear only in the picker.
  expect(await options(episode)).toEqual([
    "Whole season",
    "Episode 1 · Departure",
    "Episode 2 · Fog Bank",
    "Episode 3 · Night Crossing",
    "Episode 4 · Landfall",
  ]);
  await episode.selectOption({ label: "Episode 4 · Landfall" });
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("That ending!");
  await composer.getByLabel("Contains spoilers").check();
  // The draft keeps its label while the composer is closed.
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  await expect(season).toHaveValue("2");
  await expect(episode).toHaveValue("4");
  for (const width of [390, 320]) {
    await noOverflow(owner, width);
    await owner.screenshot({ path: `.cache/label-composer-${width}.png` });
  }
  await owner.setViewportSize({ width: 1366, height: 900 });
  await composer.scrollIntoViewIfNeeded();
  await owner.screenshot({ path: ".cache/label-composer-1366.png" });
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(
    composer.getByLabel("Your comment", { exact: true }),
  ).toHaveValue("");
  await expect(season).toHaveValue("");
  await expect(episode).toHaveCount(0);
  await season.selectOption({ label: "Season 1" });
  await expect(episode).toBeEnabled();
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("The first season holds up.");
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(owner.locator("[data-item-id]")).toHaveCount(2);
  await noOverflow(owner, 390);

  for (const path of ["/titles/tv/998020", "/", "/people/labelowner"]) {
    await reader.goto(path);
    const spoiler = reader
      .locator("[data-item-id]")
      .filter({ hasText: "Season 2, Episode 4" });
    await expect(spoiler.locator(".discussion-label")).toHaveText(
      "Season 2, Episode 4",
    );
    await expect(
      spoiler.getByRole("button", { name: /Contains spoilers/ }),
    ).toBeVisible();
    await expect(spoiler).not.toContainText("That ending!");
    await expect(spoiler).not.toContainText("Landfall");
    const plain = reader
      .locator("[data-item-id]")
      .filter({ hasText: "The first season holds up." });
    await expect(plain.locator(".discussion-label")).toHaveText("Season 1");
    await noOverflow(reader, 320);
    await reader.screenshot({
      path: `.cache/label-feed-${path === "/" ? "feed" : path.split("/")[1]}-320.png`,
      fullPage: true,
    });
    await reader.setViewportSize({ width: 390, height: 844 });
    await spoiler.getByRole("button", { name: /Contains spoilers/ }).click();
    await expect(spoiler).toContainText("That ending!");
    await expect(spoiler.locator(".discussion-label")).toHaveText(
      "Season 2, Episode 4",
    );
  }
  await reader.setViewportSize({ width: 1366, height: 900 });
  await reader.goto("/");
  await reader.screenshot({ path: ".cache/label-feed-1366.png" });

  // Movies have no pickers, and a show without TMDB seasons posts unlabeled.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto("/titles/movie/987654");
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  await expect(
    composer.getByLabel("Your comment", { exact: true }),
  ).toBeFocused();
  await expect(season).toHaveCount(0);
  await owner.goto("/titles/tv/987657");
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  await expect(composer.getByRole("status")).toHaveText(
    "Seasons are unavailable right now, so this comment will have no season label.",
  );
  await expect(season).toHaveCount(0);
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("No season list here.");
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  const unlabeled = owner
    .locator("[data-item-id]")
    .filter({ hasText: "No season list here." });
  await expect(unlabeled).toBeVisible();
  await expect(unlabeled.locator(".discussion-label")).toHaveCount(0);
});

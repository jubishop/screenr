import { expect } from "@playwright/test";
import { test } from "./monitored-test";
import { befriend } from "./journey-helpers";

test("watch together opens from a friend profile, filters shared titles, and refreshes choices and access", async ({
  member,
  page,
}) => {
  const owner = await member("watchowner");
  const friend = await member("watchfriend");
  const path = "/watch-together?with=watchfriend";
  const apiPath = `/api/screenr/screen?path=${encodeURIComponent(path)}`;
  await owner.goto("/people/watchfriend");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toHaveCount(0);
  expect((await owner.request.get(apiPath)).status()).toBe(404);
  expect((await page.request.get(apiPath)).status()).toBe(401);
  await befriend(owner, friend, "watchfriend", "watchowner");
  await owner.goto("/people/watchowner");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toHaveCount(0);
  await owner.goto("/people/watchfriend");
  await owner
    .getByRole("link", { name: "Watch together", exact: true })
    .click();
  await expect(
    owner.getByRole("heading", { name: "No shared titles yet." }),
  ).toBeVisible();
  for (const title of ["/titles/movie/987654", "/titles/tv/998001"]) {
    for (const person of [owner, friend]) {
      await person.goto(title);
      await person
        .locator(".title-hero")
        .getByRole("button", { name: "+ Want to watch", exact: true })
        .click();
      await expect(
        person
          .locator(".title-hero")
          .getByRole("button", { name: "✓ Want to watch", exact: true }),
      ).toBeVisible();
    }
  }
  await owner.goto("/people/watchfriend");
  await owner
    .getByRole("link", { name: "Watch together", exact: true })
    .click();
  await expect(owner).toHaveURL(path);
  await expect(
    owner.getByRole("heading", { name: "Watch together", exact: true }),
  ).toBeVisible();
  const results = owner.getByLabel("Shared titles");
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Harbor Signal",
    "The Lantern Room",
  ]);
  await expect(
    owner.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    owner.getByRole("button", { name: /Want to watch/ }),
  ).toHaveCount(0);
  await owner.getByRole("button", { name: "Movies", exact: true }).click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Lantern Room",
  ]);
  await owner.waitForResponse((response) =>
    response.url().includes("/api/screenr/screen?"),
  );
  await expect(
    owner.getByRole("button", { name: "Movies", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await owner.getByRole("button", { name: "TV", exact: true }).click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Harbor Signal",
  ]);
  await owner.reload();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Harbor Signal",
    "The Lantern Room",
  ]);
  for (const width of [1440, 390, 320]) {
    await owner.setViewportSize({ width, height: 900 });
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await owner.screenshot({
      path: `.cache/watch-together-${width}.png`,
      fullPage: true,
    });
  }
  await results
    .getByRole("link")
    .filter({ hasText: "The Lantern Room" })
    .click();
  await expect(owner).toHaveURL("/titles/movie/987654");
  await expect(
    owner
      .locator(".title-hero")
      .getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  await owner.goBack();
  await owner.getByRole("button", { name: "TV", exact: true }).click();
  await friend
    .locator(".title-hero")
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await expect(
    owner.getByRole("heading", { name: "No shared TV shows yet." }),
  ).toBeVisible();
  await owner.getByRole("button", { name: "All", exact: true }).click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Lantern Room",
  ]);
  await friend.goto("/titles/movie/987654");
  await friend
    .locator(".title-hero")
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await expect(
    owner.getByRole("heading", { name: "No shared titles yet." }),
  ).toBeVisible();
  await friend
    .locator(".title-hero")
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Lantern Room",
  ]);
  await friend.goto("/people/watchowner");
  await friend.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Watch together not found." }),
  ).toBeVisible();
  await expect(results).toHaveCount(0);
  expect((await owner.request.get(apiPath)).status()).toBe(404);
  await owner.reload();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Watch together not found." }),
  ).toBeVisible();
  await owner.goto("/people/watchfriend");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toHaveCount(0);
  await owner.context().close();
  await friend.context().close();
});

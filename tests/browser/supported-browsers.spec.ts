import { expect } from "@playwright/test";
import { test } from "./monitored-test";
import { openWithoutPolling } from "./refresh-helpers";

// Safari 16.4, the oldest supported browser, has neither AbortSignal.any nor
// URLSearchParams size, and Next.js polyfills neither
// (docs/interface-design.md#supported-browsers--2026-11-01). The test
// browser has both, so the page removes them before its scripts run.
test("member pages refresh, search, and keep link queries without AbortSignal.any or URLSearchParams size", async ({
  member,
}) => {
  const viewer = await member("olderbrowser");
  await viewer.addInitScript(() => {
    Reflect.deleteProperty(AbortSignal, "any");
    Reflect.deleteProperty(URLSearchParams.prototype, "size");
  });
  // Opening the page refreshes it once it is interactive.
  await openWithoutPolling(viewer, "/search");
  expect(
    await viewer.evaluate(
      () => "any" in AbortSignal || "size" in URLSearchParams.prototype,
    ),
  ).toBe(false);
  const main = viewer.getByRole("main");
  await expect(
    main.getByRole("heading", { name: "Find a title", level: 1 }),
  ).toBeVisible();
  await expect(main.locator(".error")).toHaveCount(0);

  // The tab and the submitted search build their URLs in the browser.
  const tabs = viewer.getByRole("navigation", { name: "Find a title lists" });
  const friendsTab = tabs.getByRole("link", { name: "Friends recommend" });
  await friendsTab.click();
  await expect(viewer).toHaveURL(/\/search\?tab=friends-recommend$/);
  await expect(friendsTab).toHaveAttribute("aria-current", "page");
  const input = viewer.getByLabel("Movie or show title");
  await input.fill("The Lantern Room");
  await input.press("Enter");
  await expect(viewer).toHaveURL(
    /\/search\?tab=friends-recommend&q=The\+Lantern\+Room$/,
  );
  await expect(
    viewer
      .getByRole("region", { name: "Search results", exact: true })
      .getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();

  await viewer.getByRole("button", { name: /^Notifications/ }).click();
  await expect(
    viewer.getByRole("dialog").getByText("No notifications yet."),
  ).toBeVisible();
});

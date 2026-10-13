import { expect, type Locator, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

type ProgressWindow = Window & {
  firstProgressOpacity?: Promise<string>;
  focusedHeadingBusy?: Promise<string | null>;
};

// Holds the server render that the next client navigation to the path waits
// for, and returns its release.
async function holdNavigation(page: Page, pathname: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      await released;
      await route.continue();
    },
    { times: 1 },
  );
  return release;
}

// Records the bar's opacity when it enters the page, before any delay ends,
// and whether the heading that the next screen focuses is in a busy region.
async function watchNavigation(page: Page) {
  await page.evaluate(() => {
    const progress = window as ProgressWindow;
    progress.firstProgressOpacity = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const bar = document.querySelector('[role="progressbar"]');
        if (!bar) return;
        observer.disconnect();
        resolve(getComputedStyle(bar).opacity);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    progress.focusedHeadingBusy = new Promise((resolve) => {
      document.addEventListener("focusin", ({ target }) => {
        const main = (target as Element).closest("main");
        if (main && (target as Element).matches("h1"))
          resolve(main.getAttribute("aria-busy"));
      });
    });
  });
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}

test("member screens show a progress bar while the next screen loads", async ({
  member,
}) => {
  const viewer = await member("progressviewer");
  const friend = await member("progressfriend");
  await prepareFriendship(viewer, friend);
  const recommended = await friend.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "tv:987657", field: "recommended", value: true },
  });
  expect(recommended.status()).toBe(200);
  const main = viewer.getByRole("main");
  const progress = viewer.getByRole("progressbar", { name: "Loading page" });
  const nav = viewer.getByRole("navigation", { name: "Main navigation" });
  const heading = (name: string) =>
    main.getByRole("heading", { level: 1, name, exact: true });

  // A navigation link keeps the current screen in place, marks it busy, and
  // fades a bar in across the top of the window until the next screen loads.
  for (const [width, find] of [
    [390, "Find"],
    [1366, "Find a title"],
  ] as const) {
    await viewer.setViewportSize({ width, height: 844 });
    await viewer.goto("/");
    await expect(viewer.locator("[data-item-id]")).toHaveCount(1);
    const layout = await box(main);
    const release = await holdNavigation(viewer, "/search");
    await watchNavigation(viewer);
    await nav.getByRole("link", { name: find, exact: true }).click();
    await expect(progress).toBeAttached();
    await expect(main).toHaveAttribute("aria-busy", "true");
    expect(
      await viewer.evaluate(
        () => (window as ProgressWindow).firstProgressOpacity,
      ),
    ).toBe("0");
    await expect(progress).toHaveCSS("opacity", "1");
    expect(
      await progress.evaluate(
        (bar) => getComputedStyle(bar, "::before").animationName,
      ),
    ).not.toBe("none");
    expect(await box(progress)).toEqual({ x: 0, y: 0, width, height: 3 });
    await expect(heading("Your circle")).toBeVisible();
    expect(await box(main)).toEqual(layout);
    expect(new URL(viewer.url()).pathname).toBe("/");
    release();
    await expect(heading("Find a title")).toBeFocused();
    expect(
      await viewer.evaluate(
        () => (window as ProgressWindow).focusedHeadingBusy,
      ),
    ).toBeNull();
    await expect(progress).toHaveCount(0);
    await expect(main).not.toHaveAttribute("aria-busy");
  }

  // Title links in a feed show the same pending state.
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.goto("/");
  const titleLink = viewer
    .locator("[data-item-id]")
    .getByRole("heading", { level: 2 })
    .getByRole("link");
  const title = await titleLink.innerText();
  const releaseTitle = await holdNavigation(viewer, "/titles/tv/987657");
  await titleLink.click();
  await expect(progress).toHaveCSS("opacity", "1");
  await expect(main).toHaveAttribute("aria-busy", "true");
  await expect(heading("Your circle")).toBeVisible();
  releaseTitle();
  await expect(heading(title)).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(main).not.toHaveAttribute("aria-busy");

  // So does choosing a notification, which opens its page after closing the
  // panel.
  const releaseProfile = await holdNavigation(viewer, "/people/progressfriend");
  await viewer.getByRole("button", { name: /^Notifications/ }).click();
  await viewer
    .getByRole("dialog", { name: "Notifications" })
    .getByRole("button", { name: /progressfriend became your friend/ })
    .click();
  await expect(progress).toHaveCSS("opacity", "1");
  await expect(main).toHaveAttribute("aria-busy", "true");
  await expect(heading(title)).toBeVisible();
  releaseProfile();
  await expect(heading("progressfriend")).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(main).not.toHaveAttribute("aria-busy");

  // Background refreshes keep the page as it is.
  let releaseRefresh = () => {};
  const refreshReleased = new Promise<void>(
    (resolve) => (releaseRefresh = resolve),
  );
  await viewer.route(
    "**/api/screenr/screen?**",
    async (route) => {
      await refreshReleased;
      await route.continue();
    },
    { times: 1 },
  );
  const refresh = viewer.waitForRequest("**/api/screenr/screen?**");
  await viewer.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await refresh;
  await expect(progress).toHaveCount(0);
  await expect(main).not.toHaveAttribute("aria-busy");
  releaseRefresh();

  // Reduced motion keeps the bar still.
  await viewer.emulateMedia({ reducedMotion: "reduce" });
  const releaseAccount = await holdNavigation(viewer, "/account");
  await nav.getByRole("link", { name: "Account", exact: true }).click();
  await expect(progress).toHaveCSS("opacity", "1");
  expect(
    await progress.evaluate(
      (bar) => getComputedStyle(bar, "::before").animationName,
    ),
  ).toBe("none");
  releaseAccount();
  await expect(heading("Account")).toBeVisible();
  await expect(progress).toHaveCount(0);
});

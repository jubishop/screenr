import { expect, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { expectTextContrast, expectThemedPage } from "./contrast";
import { friend, person } from "./member-fixture";
import { chooseStatus, statusButton } from "./watch-status";

const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");

// The device's appearance setting picks the theme: docs/interface-design.md#dark-theme-follows-the-system-setting--2026-10-12
const schemes = ["light", "dark"] as const;

for (const colorScheme of schemes)
  for (const width of [390, 1440]) {
    test(`secondary sign-in text meets normal-text contrast on both backgrounds in the ${colorScheme} theme at ${width}px`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/login");
      const cardText = page.getByText("Welcome back.", { exact: false });
      const card = await expectTextContrast(cardText);
      const paper = await expectTextContrast(
        page.getByRole("link", { name: "Catalog credits", exact: true }),
      );
      expect(card.background).not.toEqual(paper.background);
      await expectTextContrast(
        page.getByText("BETTER WITH FRIENDS", { exact: true }),
      );
      await expectTextContrast(
        page.getByText("or use an email code", { exact: true }),
      );
      await expectTextContrast(
        page.getByText("No password to remember.", { exact: false }),
      );
      const heading = await expectTextContrast(
        page.getByRole("heading", { level: 1 }),
      );
      expect(heading.ratio).toBeGreaterThan(card.ratio);
      await expectThemedPage(page, `sign-in ${colorScheme}`);
      await page.screenshot({
        path: `.cache/contrast-sign-in-${colorScheme}-${width}.png`,
        fullPage: true,
      });
      await page.goto("/credits");
      await expect(
        page.getByRole("heading", { name: "Catalog credits" }),
      ).toBeVisible();
      await expectThemedPage(page, `credits ${colorScheme}`);
      await page.screenshot({
        path: `.cache/contrast-credits-${colorScheme}-${width}.png`,
      });
    });
  }

async function expectBothThemes(page: Page, name: string) {
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme });
    await expectThemedPage(page, `${name} ${colorScheme}`);
  }
  await page.screenshot({ path: `.cache/dark-${name}.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
}

test("profile setup keeps readable text and theme colors in both themes", async ({
  page,
  signIn,
}) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, `themesetup${width}`, { complete: false });
    await expectBothThemes(page, `setup-${width}`);
    await page.context().clearCookies();
  }
});

for (const width of [390, 1366])
  test(`member pages keep readable text and theme colors in both themes at ${width}px`, async ({
    page,
    signIn,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const name = (role: string) => `theme${role}${width}`;
    const viewer = await signIn(page, name("viewer"), {
      displayName: "Theo Viewer",
    });
    const maya = await person(name("maya"), "Maya Chen");
    const sam = await person(name("sam"), "Sam Okafor");
    const priya = await person(name("priya"), "Priya Pending");
    const sid = await person(name("sid"), "Sid Sent");
    const bea = await person(name("bea"), "Bea Blocked");
    await friend(viewer, maya);
    await friend(maya, sam);
    await changeRelationship(priya, viewer, "request");
    await changeRelationship(viewer, sid, "request");
    await changeRelationship(viewer, bea, "block");
    for (const [title, field] of [
      ["movie:987654", "recommended"],
      ["movie:939101", "want_to_watch"],
    ]) {
      const response = await page.request.post("/api/screenr/activity", {
        headers: { Origin: browserConfig.baseURL },
        data: { title, field, value: true },
      });
      expect(response.status()).toBe(200);
    }
    await updateTitleActivity(maya, "movie:939101", "want_to_watch", true);
    const entry = await updateTitleActivity(
      maya,
      "movie:987654",
      "recommended",
      true,
    );
    const comment = await addComment(maya, entry, "Worth a weekend", false);
    await addComment(viewer, entry, "The ending surprised me", true, comment);
    await setReaction(viewer, entry, null, "like");

    await page.goto("/");
    await expect(page.locator("[data-item-id]")).toHaveCount(4);
    const discussion = page.locator(`[data-item-id="${entry}"]`);
    await discussion.getByRole("button", { name: "View 1 reply" }).click();
    await expect(
      discussion.getByRole("button", { name: /^Contains spoilers/ }),
    ).toBeVisible();
    const reply = discussion.getByRole("button", {
      name: "Comment",
      exact: true,
    });
    await reply.focus();
    await page.keyboard.press("Enter");
    await expect(discussion.getByLabel("Add your reply")).toBeFocused();
    await expectBothThemes(page, `feed-${width}`);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Notifications" })
        .getByRole("button", { name: "Accept", exact: true }),
    ).toBeVisible();
    await expectBothThemes(page, `notifications-${width}`);
    await page.keyboard.press("Escape");

    await page.goto("/titles/movie/987654");
    await expect(page.getByText("Recommended by")).toBeVisible();
    await expectBothThemes(page, `title-${width}`);
    await page.goto("/titles/movie/939101");
    await expect(page.locator(".availability-group img").first()).toBeVisible();
    await expectBothThemes(page, `availability-${width}`);
    await page.goto("/search?q=streaming%20choices");
    await expect(page.locator(".search-result").first()).toBeVisible();
    await expectBothThemes(page, `search-${width}`);
    await page.goto("/search?tab=friends-recommend");
    await expect(page.getByText("Recommended by Maya Chen")).toBeVisible();
    await expectBothThemes(page, `friends-recommend-${width}`);
    await page.goto("/people");
    await expect(page.getByText("Bea Blocked")).toBeVisible();
    await expectBothThemes(page, `friends-${width}`);
    await page.goto("/invites");
    await page
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    await expect(page.locator(".invitation-created")).toBeVisible();
    await expectBothThemes(page, `invites-${width}`);
    await page.goto("/account");
    await page
      .getByRole("button", { name: "Edit services", exact: true })
      .click();
    await page.locator(".service-option input").first().check();
    await expectBothThemes(page, `account-${width}`);
    await page.goto(`/watch-together?with=${name("maya")}`);
    await expect(page.getByText("Night Crossing")).toBeVisible();
    await expectBothThemes(page, `watch-together-${width}`);
    await page.goto("/titles/movie/939101");
    await chooseStatus(page, "Watching");
    await statusButton(page).click();
    await expect(page.getByLabel("Last finished")).toBeVisible();
    await expectBothThemes(page, `status-menu-${width}`);
    await page.goto(`/people/${name("maya")}`);
    await page
      .getByRole("button", { name: "More actions for Maya Chen", exact: true })
      .click();
    await expectBothThemes(page, `profile-menu-${width}`);
    await page.getByRole("menuitem", { name: "Block" }).click();
    const confirmation = page.getByRole("group", {
      name: /^Block Maya Chen\?/,
    });
    await expect(confirmation).toBeVisible();
    await expectBothThemes(page, `profile-confirm-${width}`);
    await confirmation
      .getByRole("button", { name: "Block", exact: true })
      .click();
    await expect(page.getByText("You blocked Maya Chen.")).toBeVisible();
    await expectBothThemes(page, `blocked-notice-${width}`);
  });

import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

const { changeRelationship } = await import("../../src/server/social");

async function person(username: string, displayName: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES($1,$2,$3,true,now(),now())`,
    [id, displayName, `${username}@example.test`],
  );
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES($1,$2,$3)",
    [id, username, displayName],
  );
  return id;
}
async function friend(a: string, b: string) {
  await changeRelationship(a, b, "request");
  await changeRelationship(b, a, "accept");
}
async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}
const region = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("the Friends page orders relationship sections and keeps each person's actions on their line", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "sectionviewer", {
    displayName: "Section Viewer",
  });
  await page.goto("/people");
  const main = page.getByRole("main");
  const empty = page.getByText("Start with someone you know.", {
    exact: false,
  });
  await expect(empty).toBeVisible();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText([
    "People you may know",
  ]);

  const longName = "R".repeat(60);
  const requester = await person("sectionrequester", longName);
  const fran = await person("sectionfriend", "Fran Friend");
  const sent = await person("sectionsent", "Sam Sent");
  const blocked = await person("sectionblocked", "Blair Blocked");
  const suggested = await person("sectionsuggested", "Sue Suggested");
  await changeRelationship(requester, viewer, "request");
  await friend(viewer, fran);
  await changeRelationship(viewer, sent, "request");
  await changeRelationship(viewer, blocked, "block");
  await friend(fran, suggested);
  await page.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText([
    "Requests",
    "Friends",
    "Sent requests",
    "People you may know",
    "Blocked people",
  ]);
  await expect(empty).toHaveCount(0);

  const request = region(page, "Requests").getByRole("article");
  await expect(request).toHaveCount(1);
  await expect(
    request.getByRole("link", { name: `${longName} @sectionrequester` }),
  ).toBeVisible();
  await expect(request.getByRole("button")).toHaveText(["Accept", "Decline"]);
  const friendRow = region(page, "Friends").getByRole("article");
  await expect(friendRow).toHaveCount(1);
  await expect(friendRow.getByRole("link")).toHaveAccessibleName(
    "Fran Friend @sectionfriend",
  );
  await expect(friendRow.getByRole("button")).toHaveCount(0);
  await expect(friendRow.getByText("Friends", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unfriend" })).toHaveCount(0);
  const sentRow = region(page, "Sent requests").getByRole("article");
  await expect(sentRow).toContainText("Request sent");
  await expect(sentRow.getByRole("button")).toHaveText(["Cancel"]);
  const suggestion = region(page, "People you may know").getByRole("article");
  await expect(suggestion).toContainText("Mutual friend: Fran Friend");
  const blockedRow = region(page, "Blocked people").getByRole("article");
  await expect(blockedRow).toContainText("Blair Blocked");
  await expect(blockedRow.getByRole("button")).toHaveText(["Unblock"]);

  const find = page.getByRole("button", { name: "Find", exact: true });
  for (const width of [320, 390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    // Find stays on one line beside the field.
    const findBox = await box(find);
    expect(findBox.height).toBeLessThan(50);
    expect(
      await find.evaluate((element) => element.scrollWidth),
    ).toBeLessThanOrEqual(Math.ceil(findBox.width));
    expect(
      Math.abs(findBox.y - (await box(page.getByLabel("Exact username"))).y),
    ).toBeLessThan(2);
    // Each row's actions sit on the person's line, after the name.
    for (const row of [request, sentRow, suggestion, blockedRow]) {
      const who = await box(row.locator(".person"));
      const actions = await box(row.locator(".person-actions"));
      expect(actions.y).toBeLessThan(who.y + who.height);
      expect(actions.y + actions.height).toBeGreaterThan(who.y);
      expect(actions.x).toBeGreaterThanOrEqual(who.x + who.width - 1);
      expect(actions.x + actions.width).toBeLessThanOrEqual(width);
    }
    // A friend row is one link that fills the row.
    const rowBox = await box(friendRow);
    const linkBox = await box(friendRow.getByRole("link"));
    expect(Math.abs(rowBox.width - linkBox.width)).toBeLessThan(1);
    expect(rowBox.height - linkBox.height).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `.cache/friends-sections-${width}.png`,
      fullPage: true,
    });
  }

  // Accepting moves the person to Friends and omits the empty Requests.
  await request.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(region(page, "Requests")).toHaveCount(0);
  await expect(region(page, "Friends").getByRole("article")).toHaveCount(2);
  // Pressing the empty end of the row still opens the profile.
  const franRow = friendRow.filter({ hasText: "Fran Friend" });
  const franBox = await box(franRow);
  await franRow.click({
    position: { x: franBox.width - 8, y: franBox.height / 2 },
  });
  await expect(page).toHaveURL(/\/people\/sectionfriend$/);
});

test("the profile More actions menu works by keyboard and pointer and confirms Unfriend and Block in the page", async ({
  member,
}) => {
  const viewer = await member("menuviewer");
  const friendPage = await member("menufriend", { displayName: "Maya Chen" });
  await prepareFriendship(viewer, friendPage);
  const dialogs: string[] = [];
  viewer.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await viewer.goto("/people/menufriend");
  const watch = viewer.getByRole("link", {
    name: "Watch together",
    exact: true,
  });
  await expect(watch).toBeVisible();
  for (const name of ["Unfriend", "Block"])
    await expect(viewer.getByRole("button", { name })).toHaveCount(0);
  const more = viewer.getByRole("button", {
    name: "More actions for Maya Chen",
    exact: true,
  });
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  const menu = viewer.getByRole("menu", { name: "More actions for Maya Chen" });
  const unfriend = menu.getByRole("menuitem", { name: "Unfriend" });
  const block = menu.getByRole("menuitem", { name: "Block" });

  // Enter opens on the first item; arrows wrap, Home and End jump.
  await more.focus();
  await viewer.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["Unfriend", "Block"]);
  await expect(unfriend).toBeFocused();
  for (const [key, item] of [
    ["ArrowDown", block],
    ["ArrowDown", unfriend],
    ["ArrowUp", block],
    ["Home", unfriend],
    ["End", block],
  ] as const) {
    await viewer.keyboard.press(key);
    await expect(item).toBeFocused();
  }
  // Escape closes and returns to the button.
  await viewer.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // ArrowUp opens on the last item; moving focus away closes the menu.
  await viewer.keyboard.press("ArrowUp");
  await expect(block).toBeFocused();
  await viewer.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // An outside click or a second press of the button closes it.
  await more.click();
  await expect(menu).toBeVisible();
  await viewer.getByRole("heading", { level: 1 }).click();
  await expect(menu).toHaveCount(0);
  await more.click();
  await more.click();
  await expect(menu).toHaveCount(0);

  // The open menu and each confirmation fit phone and desktop widths.
  for (const width of [390, 1366]) {
    await viewer.setViewportSize({ width, height: 844 });
    await more.click();
    const menuBox = await box(menu);
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    await viewer.screenshot({ path: `.cache/profile-menu-${width}.png` });
    await viewer.keyboard.press("Escape");
  }

  // Block on a friend states that it ends the friendship; Cancel keeps it.
  await more.click();
  await block.click();
  const confirmBlock = viewer.getByRole("group", {
    name: /^Block Maya Chen\?/,
  });
  await expect(confirmBlock).toContainText(
    "Block Maya Chen? This ends your friendship. You won’t see each other’s profiles, posts, or comments, and neither of you can send a friend request until you unblock them.",
  );
  await expect(
    confirmBlock.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await viewer.screenshot({ path: `.cache/profile-confirm-1366.png` });
  await viewer.keyboard.press("Enter");
  await expect(confirmBlock).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(watch).toBeVisible();

  // Unfriend by keyboard: Cancel has focus, so the action needs Shift+Tab.
  await viewer.setViewportSize({ width: 390, height: 844 });
  await viewer.keyboard.press("Enter");
  await viewer.keyboard.press("Enter");
  const confirmUnfriend = viewer.getByRole("group", {
    name: "Unfriend Maya Chen? You’ll both lose access to each other’s posts and discussions.",
    exact: true,
  });
  await expect(confirmUnfriend).toBeVisible();
  await viewer.screenshot({ path: `.cache/profile-confirm-390.png` });
  await viewer.keyboard.press("Shift+Tab");
  await expect(
    confirmUnfriend.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeFocused();
  await viewer.keyboard.press("Enter");
  await expect(
    viewer.getByRole("button", { name: "Send friend request", exact: true }),
  ).toBeVisible();
  await expect(watch).toHaveCount(0);
  await expect(confirmUnfriend).toHaveCount(0);
  await expect(more).toBeFocused();

  // Without a friendship the menu offers only Block, which still confirms.
  await more.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Block"]);
  await block.click();
  await expect(confirmBlock).toContainText(
    "Block Maya Chen? You won’t see each other’s profiles",
  );
  await confirmBlock
    .getByRole("button", { name: "Block", exact: true })
    .click();
  // #132 opens the Friends page after Block; the profile no longer loads.
  await expect(
    viewer.getByRole("alert").filter({ hasText: "Person not found." }),
  ).toBeVisible();
  await viewer.goto("/people");
  const blockedRow = region(viewer, "Blocked people").getByRole("article");
  await expect(blockedRow).toContainText("Maya Chen");
  await blockedRow
    .getByRole("button", { name: "Unblock", exact: true })
    .click();
  await expect(region(viewer, "Blocked people")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

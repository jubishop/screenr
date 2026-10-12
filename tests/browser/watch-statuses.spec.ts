import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { browserConfig } from "../../scripts/browser-config";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { chooseStatus, statusButton } from "./watch-status";

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}
// The open panel stays on screen and the page never scrolls sideways.
async function expectPanelOnScreen(page: Page, screenshot: string) {
  const { width } = page.viewportSize()!;
  await page
    .locator(".status-panel")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  const panel = await box(page.locator(".status-panel"));
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `.cache/${screenshot}-${width}.png` });
}

test("members choose, date, and clear watch statuses from the title page, and friends see one progress entry", async ({
  member,
}) => {
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview,release_date) VALUES
    ('tv:998201','tv',998201,'The Night Ferry','A fictional show.','2024-01-05'),
    ('movie:998202','movie',998202,'Glass Orchard','A fictional film.','2023-05-01')
    ON CONFLICT DO NOTHING`);
  // Distinct names let the scenario repeat against the same database.
  const name = `status_${randomUUID().slice(0, 8)}`;
  const viewer = await member(name);
  const friend = await member(`${name}_friend`);
  await prepareFriendship(viewer, friend);
  await viewer.goto("/titles/tv/998201");
  const button = statusButton(viewer);
  const menu = viewer.getByRole("menu", { name: "Watch status" });
  const choice = (name: string) =>
    menu.getByRole("menuitemradio", { name, exact: true });
  // The viewer's own entry's author line, after the name.
  const own = viewer
    .locator(".feed-entry")
    .filter({ has: viewer.getByRole("link", { name, exact: true }) })
    .locator(".activity-by > .muted")
    .first();
  await expect(button).toHaveText("+ Want to watch");
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // The menu lists every TV status, marks none, and focuses the first.
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Want to watch",
    "Watching",
    "Caught up",
    "Finished",
    "Stopped watching",
  ]);
  await expect(menu.locator('[aria-checked="true"]')).toHaveCount(0);
  await expect(menu.getByRole("menuitem")).toHaveCount(0);
  await expect(viewer.getByLabel("Last finished")).toHaveCount(0);
  await expect(choice("Want to watch")).toBeFocused();
  await expectPanelOnScreen(viewer, "watch-status-menu");
  await choice("Watching").click();
  await expect(button).toHaveText("✓ Watching");
  await expect(button).toBeFocused();
  await expect(own).toHaveText("is watching");

  // Keyboard: arrows open and move, Home and End jump, Escape returns.
  await button.press("ArrowDown");
  await expect(choice("Want to watch")).toBeFocused();
  await viewer.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Clear status", exact: true }),
  ).toBeFocused();
  await viewer.keyboard.press("ArrowUp");
  await expect(choice("Stopped watching")).toBeFocused();
  await viewer.keyboard.press("Home");
  await viewer.keyboard.press("ArrowDown");
  await expect(choice("Watching")).toBeFocused();
  await expect(choice("Watching")).toHaveAttribute("aria-checked", "true");
  await viewer.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  // An outside press closes it too.
  await button.click();
  await viewer.getByRole("heading", { level: 1 }).click();
  await expect(menu).toHaveCount(0);

  // Finished sets today's date, which the member can change or clear.
  await button.press("Enter");
  await expect(choice("Watching")).toBeFocused();
  await viewer.keyboard.press("ArrowDown");
  await viewer.keyboard.press("ArrowDown");
  await viewer.keyboard.press("Enter");
  await expect(button).toHaveText("✓ Finished");
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(now);
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  }).format(now);
  await expect(own).toHaveText(`finished · ${todayLabel}`);
  await button.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Clear status"]);
  const date = viewer.getByLabel("Last finished");
  await expect(date).toHaveValue(today);
  await expectPanelOnScreen(viewer, "watch-status-finished");
  const save = viewer.getByRole("button", { name: "Save date", exact: true });
  await expect(save).toBeDisabled();
  await date.fill("2024-03-09");
  await save.click();
  await expect(own).toHaveText("finished · Mar 9, 2024");
  await expect(button).toHaveText("✓ Finished");
  await button.click();
  await expect(viewer.getByLabel("Last finished")).toHaveValue("2024-03-09");
  await viewer.getByRole("button", { name: "Clear date", exact: true }).click();
  await expect(own).toHaveText("finished");
  await chooseStatus(viewer, "Caught up");
  await expect(own).toHaveText("is caught up");

  // A friend sees the entry and saves the show with one tap.
  await friend.goto("/");
  const entry = friend
    .locator(".feed-entry")
    .filter({ hasText: `${name} is caught up` });
  await expect(entry).toHaveCount(1);
  await entry
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(
    entry.getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  await friend.goto("/titles/tv/998201");
  await expect(statusButton(friend)).toHaveText("✓ Want to watch");
  await chooseStatus(friend, "Watching");
  // The friend's own status replaces the one-tap action on others' entries.
  await friend.goto("/");
  const status = entry.getByRole("link", { name: "✓ Watching", exact: true });
  await expect(status).toHaveAttribute("href", "/titles/tv/998201");
  await expect(
    entry.getByRole("button", { name: /Want to watch/ }),
  ).toHaveCount(0);
  const id = await entry.getAttribute("data-item-id");
  const reply = await friend.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "No spoilers please", spoiler: false },
  });
  expect(reply.status()).toBe(200);

  // Clearing keeps an entry with replies, marked as no longer current.
  await viewer.reload();
  await chooseStatus(viewer, "Clear status");
  await expect(own).toHaveText("removed their watch status");
  await expect(
    viewer.getByText("No spoilers please", { exact: true }),
  ).toBeVisible();

  for (const width of [390, 1366]) {
    await viewer.setViewportSize({ width, height: 844 });
    await button.click();
    await expectPanelOnScreen(viewer, "watch-status-panel");
    await viewer.keyboard.press("Escape");
  }
  // Movies have no Caught up.
  await viewer.goto("/titles/movie/998202");
  await statusButton(viewer).click();
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Want to watch",
    "Watching",
    "Finished",
    "Stopped watching",
  ]);
});

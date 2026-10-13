import { expect, type Locator, type Page } from "@playwright/test";
import { db } from "./database-fixture";
import { expectTextContrast, expectThemedPage } from "./contrast";
import { test } from "./monitored-test";
import { friend, person, userId } from "./member-fixture";
import { statusButton } from "./watch-status";
import { expectErrorBeside, failAction } from "./action-errors";

const { updateTitleActivity, updateTopTen } =
  await import("../../src/server/title-actions");

// Profile top 10: docs/profile-top-ten.md. Lists start through the existing
// action path; each test then drives the page.

// Stores `count` current titles numbered from `first`, named "<prefix> N".
async function titles(first: number, count: number, prefix: string) {
  const ids = Array.from({ length: count }, (_, index) => first + index);
  for (const [index, tmdbId] of ids.entries())
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,fetched_at) VALUES($1,'movie',$2,$3,now())
      ON CONFLICT DO NOTHING`,
      [`movie:${tmdbId}`, tmdbId, `${prefix} ${index + 1}`],
    );
  return ids.map((tmdbId) => `movie:${tmdbId}`);
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}

// Records browser dialogs, which these prompts must never open.
function dialogs(page: Page) {
  const opened: string[] = [];
  page.on("dialog", (dialog) => {
    opened.push(dialog.message());
    void dialog.dismiss();
  });
  return opened;
}

// Presses the mouse on a poster and moves past the distance that tells a
// drag from a click, leaving the button down.
async function pressAndDrag(page: Page, poster: Locator) {
  const start = await box(poster);
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y, { steps: 3 });
}

// A point over a poster's left or right half, where a drop lands before or
// after it.
async function half(poster: Locator, side: "before" | "after") {
  const bounds = await box(poster);
  return {
    x: bounds.x + bounds.width * (side === "before" ? 0.25 : 0.75),
    y: bounds.y + bounds.height / 2,
  };
}

// Drags a poster to a point and drops it.
async function dragTo(
  page: Page,
  poster: Locator,
  target: { x: number; y: number },
) {
  await pressAndDrag(page, poster);
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
}

// Records the top 10 writes the page sends.
function topTenWrites(page: Page) {
  const sent: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/screenr/top-ten"))
      sent.push(request.postDataJSON());
  });
  return sent;
}

async function expectBothThemes(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expectThemedPage(page, `${name} ${colorScheme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

for (const width of [390, 1366])
  test(`profiles show the top 10 as a scrolling poster row, and edit mode moves and removes entries at ${width}px`, async ({
    page,
    signIn,
    member,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const owner = await signIn(page, `toptenrow${width}`, {
      displayName: "Rowan Owner",
    });
    const ids = await titles(width === 390 ? 997101 : 997201, 10, "Row Pick");
    for (const id of ids) await updateTopTen(owner, id, "add");
    const names = ids.map((_, index) => `Row Pick ${index + 1}`);

    await page.goto(`/people/toptenrow${width}`);
    const section = page.getByRole("region", { name: "Top 10", exact: true });
    const row = section.getByRole("list");
    const links = row.getByRole("link");
    await expect(links).toHaveCount(10);
    await expect(links.first()).toHaveAccessibleName("#1 Row Pick 1");
    await expect(links.first()).toHaveAttribute(
      "href",
      `/titles/movie/${ids[0].slice(6)}`,
    );
    await expect(row.locator(".top-ten-name")).toHaveText(names);
    // Beneath the profile header and above the friends list and activity,
    // about one poster tall, scrolling sideways without widening the page.
    const header = await box(page.locator(".profile-heading"));
    const area = await box(section);
    const friends = await box(page.locator(".profile-friends"));
    expect(area.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(friends.y).toBeGreaterThanOrEqual(area.y + area.height);
    expect(area.height).toBeLessThan(width === 390 ? 260 : 290);
    expect(
      await row.evaluate((list) => list.scrollWidth > list.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await links.last().focus();
    const last = await box(links.last());
    expect(last.x + last.width).toBeLessThanOrEqual(width);
    // Rank numbers have their own fill over the poster.
    await expectTextContrast(row.locator(".top-ten-rank").first());
    await expectBothThemes(page, `top-ten-row-${width}`);
    await page.screenshot({ path: `.cache/top-ten-row-${width}.png` });

    // Edit mode: each change saves at once, focus follows the entry.
    await section.getByRole("button", { name: "Edit top 10" }).click();
    const entries = section.locator(".top-ten-edit .top-ten-name");
    await expect(entries).toHaveText(names);
    await expectBothThemes(page, `top-ten-edit-${width}`);
    await page.screenshot({ path: `.cache/top-ten-edit-${width}.png` });
    await section
      .getByRole("button", { name: "Move Row Pick 2 up", exact: true })
      .click();
    await expect(entries).toHaveText([names[1], names[0], ...names.slice(2)]);
    // At #1, Move up is unavailable, so focus moves to Move down.
    await expect(
      section.getByRole("button", { name: "Move Row Pick 2 up" }),
    ).toBeDisabled();
    await expect(
      section.getByRole("button", { name: "Move Row Pick 2 down" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(entries).toHaveText(names);
    await expect(
      section.getByRole("button", { name: "Move Row Pick 2 down" }),
    ).toBeFocused();
    await expect(
      section.getByRole("button", { name: "Move Row Pick 10 down" }),
    ).toBeDisabled();
    await section
      .getByRole("button", { name: "Remove Row Pick 3 from your top 10" })
      .click();
    const remaining = [...names.slice(0, 2), ...names.slice(3)];
    await expect(entries).toHaveText(remaining);
    await expect(section.locator(".top-ten-rank")).toHaveText(
      remaining.map((_, index) => `#${index + 1}`),
    );
    await expect(
      section.getByRole("button", {
        name: "Remove Row Pick 4 from your top 10",
      }),
    ).toBeFocused();
    await section.getByRole("button", { name: "Done editing top 10" }).click();
    await expect(links).toHaveCount(9);
    await page.reload();
    await expect(row.locator(".top-ten-name")).toHaveText(remaining);
    // Removing keeps the Recommend, and the changes added no entries.
    const actions = await db.query(
      `SELECT title_id FROM feed_item WHERE owner_id=$1 AND active
      AND item_type='recommended'`,
      [owner],
    );
    expect(actions.rows.map((entry) => entry.title_id).sort()).toEqual(
      [...ids].sort(),
    );
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM feed_item WHERE owner_id=$1",
          [owner],
        )
      ).rows[0].count,
    ).toBe(10);

    // Another signed-in member sees the row without Edit or activity. An
    // empty list is hidden on another profile and explained on one's own.
    const visitor = await member(`toptenvisit${width}`);
    await visitor.goto(`/people/toptenrow${width}`);
    const seen = visitor.getByRole("region", { name: "Top 10", exact: true });
    await expect(seen.getByRole("link")).toHaveCount(9);
    await expect(seen.getByRole("button")).toHaveCount(0);
    await expect(
      visitor.getByText("You’ll see their activity after you become friends."),
    ).toBeVisible();
    await expect(visitor.locator("[data-item-id]")).toHaveCount(0);
    await visitor.goto(`/people/toptenvisit${width}`);
    await expect(
      visitor.getByText("Choose Add to top 10 on a title page to start.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      visitor.getByRole("button", { name: "Edit top 10" }),
    ).toHaveCount(0);
    await page.goto(`/people/toptenvisit${width}`);
    await expect(page.getByText("@toptenvisit" + width)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Top 10", exact: true }),
    ).toHaveCount(0);
  });

for (const width of [390, 1366])
  test(`title pages add to the top 10, replace through the full-list prompt, and confirm before a top 10 title loses its Recommend at ${width}px`, async ({
    page,
    signIn,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const opened = dialogs(page);
    const viewer = await signIn(page, `toptenadd${width}`, {
      displayName: "Ada Adder",
    });
    const maya = await person(`toptenmaya${width}`, "Maya Chen");
    await friend(viewer, maya);
    const ids = await titles(width === 390 ? 997301 : 997401, 12, "Add Pick");
    const path = (index: number) => `/titles/movie/${ids[index - 1].slice(6)}`;
    for (const id of ids.slice(0, 8)) await updateTopTen(viewer, id, "add");
    await updateTitleActivity(viewer, ids[8], "want_to_watch", true);
    await updateTopTen(maya, ids[11], "add");
    const mayaEntry = await updateTitleActivity(
      maya,
      ids[3],
      "recommended",
      true,
    );
    const header = page.locator(".title-hero .inline-actions");
    const button = (name: string) =>
      header.getByRole("button", { name, exact: true });

    // Adding recommends the title, which clears Want to watch.
    await page.goto(path(9));
    await expect(statusButton(page)).toHaveText("✓ Want to watch");
    await button("Add to top 10").click();
    await expect(button("✓ #9 in your top 10")).toBeFocused();
    await expect(button("✓ Recommended")).toBeVisible();
    await expect(statusButton(page)).toHaveText("+ Want to watch");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.cache/top-ten-title-${width}.png` });
    await page.goto(path(10));
    await button("Add to top 10").click();
    await expect(button("✓ #10 in your top 10")).toBeVisible();
    await expect(button("✓ Recommended")).toBeVisible();

    // A full list asks which entry to remove. Cancel changes nothing.
    await page.goto(path(11));
    await button("Add to top 10").click();
    const prompt = page.getByRole("group", { name: /^Your top 10 is full\./ });
    await expect(prompt).toContainText("Add Pick 11 joins at #10.");
    const choices = prompt.getByRole("button", { name: /^Remove #/ });
    await expect(choices).toHaveCount(10);
    await expect(choices.nth(2)).toHaveAccessibleName("Remove #3 Add Pick 3");
    await expect(prompt.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await expectBothThemes(page, `top-ten-full-${width}`);
    await page.screenshot({ path: `.cache/top-ten-full-${width}.png` });
    await prompt.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(button("Add to top 10")).toBeFocused();
    await expect(button("Recommend to friends")).toBeVisible();
    // Choosing #3 moves the entries below it up; the new title joins at #10.
    await button("Add to top 10").click();
    await prompt.getByRole("button", { name: "Remove #3 Add Pick 3" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(button("✓ #10 in your top 10")).toBeFocused();
    await expect(button("✓ Recommended")).toBeVisible();
    await page.goto(path(3));
    await expect(button("✓ Recommended")).toBeVisible();
    await expect(button("Add to top 10")).toBeVisible();
    await page.goto(path(4));
    await expect(button("✓ #3 in your top 10")).toBeVisible();

    // Withdrawing a top 10 Recommend asks first.
    await page.goto(path(11));
    await button("✓ Recommended").click();
    const withdraw = page.getByRole("group", {
      name: "Remove your recommendation? Add Pick 11 also leaves your top 10 at #10.",
      exact: true,
    });
    await expect(
      withdraw.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await withdraw.getByRole("button", { name: "Cancel" }).click();
    await expect(withdraw).toHaveCount(0);
    await expect(button("✓ Recommended")).toBeFocused();
    await expect(button("✓ #10 in your top 10")).toBeVisible();
    await button("✓ Recommended").click();
    await withdraw
      .getByRole("button", { name: "Remove recommendation", exact: true })
      .click();
    await expect(withdraw).toHaveCount(0);
    await expect(button("Recommend to friends")).toBeFocused();
    await expect(button("Add to top 10")).toBeVisible();
    // Recommending again does not restore the place.
    await button("Recommend to friends").click();
    await expect(button("✓ Recommended")).toBeVisible();
    await expect(button("Add to top 10")).toBeVisible();

    // Switching to Want to watch from the status menu asks first.
    await page.goto(path(1));
    await statusButton(page).click();
    await page
      .getByRole("menu", { name: "Watch status" })
      .getByRole("menuitemradio", { name: "Want to watch", exact: true })
      .click();
    const switching = page.getByRole("group", {
      name: "Switch to Want to watch? This removes your recommendation, and Add Pick 1 leaves your top 10 at #1.",
      exact: true,
    });
    await expect(
      switching.getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await switching
      .getByRole("button", { name: "Switch to Want to watch", exact: true })
      .click();
    await expect(switching).toHaveCount(0);
    await expect(statusButton(page)).toHaveText("✓ Want to watch");
    await expect(statusButton(page)).toBeFocused();
    await expect(button("Recommend to friends")).toBeVisible();
    await expect(button("Add to top 10")).toBeVisible();

    // The listed state removes the title from the top 10 and keeps Recommend.
    await page.goto(path(2));
    await button("✓ #1 in your top 10").click();
    await expect(button("Add to top 10")).toBeFocused();
    await expect(button("✓ Recommended")).toBeVisible();

    // Full feed entries ask too. Add Pick 4 is now #1.
    await page.goto("/");
    const entry = page.locator(`[data-item-id="${mayaEntry}"]`);
    const action = (name: string) =>
      entry.getByRole("button", { name, exact: true });
    await action("✓ Recommended").click();
    const feedWithdraw = entry.getByRole("group", {
      name: "Remove your recommendation? Add Pick 4 also leaves your top 10 at #1.",
      exact: true,
    });
    await feedWithdraw.getByRole("button", { name: "Cancel" }).click();
    await expect(action("✓ Recommended")).toBeFocused();
    await action("+ Want to watch").click();
    const feedSwitch = entry.getByRole("group", {
      name: "Switch to Want to watch? This removes your recommendation, and Add Pick 4 leaves your top 10 at #1.",
      exact: true,
    });
    await feedSwitch
      .getByRole("button", { name: "Switch to Want to watch", exact: true })
      .click();
    await expect(feedSwitch).toHaveCount(0);
    await expect(action("✓ Want to watch")).toBeFocused();
    await expect(action("+ Recommend")).toBeVisible();
    // Feed entries offer no top 10 control.
    await expect(entry.getByRole("button", { name: /top 10/ })).toHaveCount(0);

    // Ranks appear beside friends' names.
    await page.goto(path(12));
    await expect(page.locator(".friend-activity")).toHaveText(
      "Recommended by Maya Chen (#1)",
    );
    await page.goto("/search");
    await expect(
      page
        .getByRole("region", { name: "Title suggestions", exact: true })
        .getByText("Maya Chen (#1) recommends this.", { exact: true }),
    ).toBeVisible();
    // Friends recommend sorts by the summed weights and shows ranks too.
    await page.goto("/search?tab=friends-recommend");
    await expect(
      page
        .getByRole("region", { name: "Friends recommend", exact: true })
        .locator(".recommenders"),
    ).toHaveText(["Recommended by Maya Chen (#1)", "Recommended by Maya Chen"]);
    expect(opened).toEqual([]);
  });

test("on desktop, dragging a poster in your own row moves it to the dropped rank in one change", async ({
  page,
  signIn,
  member,
}) => {
  await page.setViewportSize({ width: 1366, height: 844 });
  const owner = await signIn(page, "toptendrag", { displayName: "Dana Drag" });
  const ids = await titles(997501, 10, "Drag Pick");
  for (const id of ids) await updateTopTen(owner, id, "add");
  const names = (...indexes: number[]) =>
    indexes.map((index) => `Drag Pick ${index}`);
  const profile = "/people/toptendrag";
  await page.goto(profile);
  const section = page.getByRole("region", { name: "Top 10", exact: true });
  const row = section.getByRole("list");
  const links = row.getByRole("link");
  const shown = row.locator(".top-ten-name");
  const writes = topTenWrites(page);
  // The row is busy until a dropped order saves.
  const saved = () => expect(row).not.toHaveAttribute("aria-busy");
  // Posters drag once the page is interactive.
  const ready = () => expect(links.first()).toHaveCSS("cursor", "grab");
  const scrolled = (end: "start" | "end") =>
    expect
      .poll(() =>
        row.evaluate(
          (list, end) =>
            end === "start"
              ? list.scrollLeft <= 0
              : list.scrollLeft + list.clientWidth >= list.scrollWidth - 1,
          end,
        ),
      )
      .toBe(true);
  await expect(shown).toHaveText(names(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
  // The poster is the handle, and the row scrolls at this width.
  await ready();
  expect(
    await row.evaluate((list) => list.scrollWidth > list.clientWidth),
  ).toBe(true);

  // While dragging, the poster follows the pointer and a marker shows where
  // it will land: dropped on the right half of #5, #2 takes #5 and the
  // entries between move up one.
  const lifted = row.locator("li[data-dragged]");
  const marker = row.locator("li[data-drop]");
  await pressAndDrag(page, links.nth(1));
  const target = await half(links.nth(4), "after");
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(row).toHaveAttribute("data-dragging");
  await expect(lifted.locator(".top-ten-name")).toHaveText("Drag Pick 2");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-drop", "before");
  await expect(marker.locator(".top-ten-name")).toHaveText("Drag Pick 6");
  await expect(links.nth(1)).toHaveCSS("cursor", "grabbing");
  await page.screenshot({ path: ".cache/top-ten-drag-1366.png" });
  await page.mouse.up();
  await expect(shown).toHaveText(names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10));
  await expect(links.nth(4)).toHaveAccessibleName("#5 Drag Pick 2");
  await saved();
  await expect(row).not.toHaveAttribute("data-dragging");
  await expect(lifted.or(marker)).toHaveCount(0);
  expect(page.url()).toMatch(/\/people\/toptendrag$/);
  expect(writes).toEqual([{ title: ids[1], change: "move", rank: 5 }]);
  await page.reload();
  await expect(shown).toHaveText(names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10));
  await ready();

  // Near either edge the row scrolls, so #1 reaches #10 and comes back.
  await pressAndDrag(page, links.first());
  const area = await box(row);
  await page.mouse.move(area.x + area.width - 6, area.y + area.height / 3, {
    steps: 8,
  });
  await scrolled("end");
  const last = await half(links.last(), "after");
  await page.mouse.move(last.x, last.y, { steps: 4 });
  await page.mouse.up();
  await expect(shown).toHaveText(names(3, 4, 5, 2, 6, 7, 8, 9, 10, 1));
  await expect(links.last()).toHaveAccessibleName("#10 Drag Pick 1");
  await saved();
  await pressAndDrag(page, links.last());
  await page.mouse.move(area.x + 6, area.y + area.height / 3, { steps: 8 });
  await scrolled("start");
  const first = await half(links.first(), "before");
  await page.mouse.move(first.x, first.y, { steps: 4 });
  await page.mouse.up();
  await expect(shown).toHaveText(names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10));
  await saved();
  expect(writes.slice(1)).toEqual([
    { title: ids[0], change: "move", rank: 10 },
    { title: ids[0], change: "move", rank: 1 },
  ]);
  await page.reload();
  await expect(shown).toHaveText(names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10));
  await ready();

  // Escape, a drop outside the row, and a drop back in place change nothing
  // and never open the title.
  await pressAndDrag(page, links.nth(2));
  const away = await half(links.nth(6), "after");
  await page.mouse.move(away.x, away.y, { steps: 8 });
  await expect(marker).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveAttribute("data-dragging");
  await expect(lifted.or(marker)).toHaveCount(0);
  await page.mouse.up();
  const below = await box(page.locator(".profile-friends"));
  await dragTo(page, links.nth(2), {
    x: below.x + below.width / 2,
    y: below.y + below.height / 2,
  });
  await dragTo(page, links.nth(2), await half(links.nth(2), "after"));
  await dragTo(page, links.nth(2), await half(links.nth(3), "before"));
  await expect(shown).toHaveText(names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10));
  expect(page.url()).toMatch(/\/people\/toptendrag$/);
  expect(writes).toHaveLength(3);

  // A failed save returns the row to the saved order and shows the error.
  await failAction(page, "top-ten", "Could not save your top 10.");
  await dragTo(page, links.nth(4), await half(links.first(), "before"));
  await expectErrorBeside(page, {
    container: section,
    failed: links.nth(4),
    controls: [row],
    message: "Could not save your top 10.",
    screenshot: "top-ten-drag-error",
  });
  await saved();
  await expect(shown).toHaveText(names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10));
  expect(writes.at(-1)).toEqual({ title: ids[1], change: "move", rank: 1 });
  await page.unroute("**/api/screenr/top-ten");

  // A click without a drag still opens the title page.
  await links.nth(1).click();
  await expect(page).toHaveURL(`/titles/movie/${ids[2].slice(6)}`);
  // Reordering added no feed entries.
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM feed_item WHERE owner_id=$1",
        [owner],
      )
    ).rows[0].count,
  ).toBe(10);

  // Another member's profile has no drag behavior.
  const visitor = await member("toptendragvisit");
  await visitor.setViewportSize({ width: 1366, height: 844 });
  await visitor.goto(profile);
  const seen = visitor
    .getByRole("region", { name: "Top 10", exact: true })
    .getByRole("list");
  // Once the page is interactive, the posters are still plain links.
  await expect(
    visitor.getByRole("button", { name: "Send friend request" }),
  ).toBeEnabled();
  await expect(seen.getByRole("link").first()).toHaveCSS("cursor", "pointer");
  await pressAndDrag(visitor, seen.getByRole("link").first());
  const elsewhere = await half(seen.getByRole("link").nth(3), "after");
  await visitor.mouse.move(elsewhere.x, elsewhere.y, { steps: 8 });
  await expect(seen).not.toHaveAttribute("data-dragging");
  await expect(seen.locator("[data-dragged], [data-drop]")).toHaveCount(0);
  await visitor.mouse.up();
  await expect(seen.locator(".top-ten-name")).toHaveText(
    names(1, 3, 4, 5, 2, 6, 7, 8, 9, 10),
  );
});

test("phones and touch-only devices reorder only through Edit", async ({
  member,
}) => {
  const page = await member("toptendragphone", { hasTouch: true });
  const owner = await userId(page);
  const ids = await titles(997601, 3, "Phone Pick");
  for (const id of ids) await updateTopTen(owner, id, "add");
  const writes = topTenWrites(page);
  await page.goto("/people/toptendragphone");
  const section = page.getByRole("region", { name: "Top 10", exact: true });
  const row = section.getByRole("list");
  const links = row.getByRole("link");
  const edit = section.getByRole("button", { name: "Edit top 10" });
  // Once the page is interactive, the posters are still plain links.
  await expect(edit).toBeEnabled();
  await expect(links.first()).toHaveCSS("cursor", "pointer");
  await pressAndDrag(page, links.first());
  const target = await half(links.last(), "after");
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(row).not.toHaveAttribute("data-dragging");
  await expect(row.locator("[data-dragged], [data-drop]")).toHaveCount(0);
  await page.mouse.up();
  await expect(row.locator(".top-ten-name")).toHaveText([
    "Phone Pick 1",
    "Phone Pick 2",
    "Phone Pick 3",
  ]);
  expect(writes).toEqual([]);
  await edit.click();
  await section
    .getByRole("button", { name: "Move Phone Pick 1 down", exact: true })
    .click();
  await expect(section.locator(".top-ten-edit .top-ten-name")).toHaveText([
    "Phone Pick 2",
    "Phone Pick 1",
    "Phone Pick 3",
  ]);
});

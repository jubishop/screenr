import { expect, type Locator } from "@playwright/test";
import { db } from "./database-fixture";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";
import { friend, person } from "./member-fixture";

const { updateTitleActivity } = await import("../../src/server/title-actions");
const { createTitleComment } = await import("../../src/server/comments");

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}

test("title pages show compact entries, a friend line that moves to each entry, and Start a conversation on the heading row", async ({
  page,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const viewer = await signIn(page, "linetess", { displayName: "Tess Viewer" });
  const [maya, sam, ana, lee, theo, kai, stranger] = [
    await person("linemaya", "Maya Chen"),
    await person("linesam", "Sam Okafor"),
    await person("lineana", "Ana Ruiz"),
    await person("linelee", "Lee Wong"),
    await person("linetheo", "Theo Park"),
    await person("linekai", "Kai Moss"),
    await person("linestranger", "Stranger Danger"),
  ];
  for (const id of [maya, sam, ana, lee, theo, kai]) await friend(viewer, id);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('movie:996090','movie',996090,'Friend Line Movie'),
    ('movie:996091','movie',996091,'Quiet Movie') ON CONFLICT DO NOTHING`);
  await updateTitleActivity(viewer, "movie:996090", "recommended", true);
  for (const id of [maya, sam, ana, lee, stranger])
    await updateTitleActivity(id, "movie:996090", "recommended", true);
  const theoEntry = await updateTitleActivity(
    theo,
    "movie:996090",
    "want_to_watch",
    true,
  );
  const mayaComment = await createTitleComment(
    maya,
    "movie:996090",
    "The ending stayed with me.",
    false,
  );
  const spoiler = await createTitleComment(
    sam,
    "movie:996090",
    "The visitor was the narrator.",
    true,
  );
  const own = await createTitleComment(
    viewer,
    "movie:996090",
    "My own note",
    false,
  );
  const ids = Object.fromEntries(
    (
      await db.query(
        `SELECT owner_id,id::text FROM feed_item
        WHERE title_id='movie:996090' AND item_type='recommended'`,
      )
    ).rows.map((row) => [row.owner_id, row.id]),
  );

  await page.goto("/titles/movie/996090");
  const line = page.locator(".friend-activity");
  // Newest first, three names per group; the viewer and nonfriends are absent.
  await expect(line).toHaveText(
    "Recommended by Lee Wong, Ana Ruiz, Sam Okafor, and 1 more · Theo Park wants to watch",
  );
  const header = page.locator(".title-hero .inline-actions");
  await expect(
    header.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
  const entries = page.locator("[data-item-id]");
  await expect(entries).toHaveCount(9);

  // Compact entries: no poster, title, metadata, or title actions.
  await expect(entries.locator(".poster")).toHaveCount(0);
  await expect(entries.getByRole("heading")).toHaveCount(0);
  await expect(entries.getByText("Movie", { exact: true })).toHaveCount(0);
  for (const name of [
    "+ Want to watch",
    "✓ Want to watch",
    "+ Recommend",
    "✓ Recommended",
  ])
    await expect(
      entries.getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  const mayaItem = page.locator(`[data-item-id="${mayaComment}"]`);
  await expect(mayaItem.locator(".activity-by")).toContainText(
    "Maya Chen commented",
  );
  await expect(mayaItem).not.toContainText("commented on");
  await expect(mayaItem).toContainText("The ending stayed with me.");
  await expect(
    page.getByRole("article", { name: /^Maya Chen commented · / }),
  ).toHaveAttribute("data-item-id", mayaComment);
  const spoilerItem = page.locator(`[data-item-id="${spoiler}"]`);
  await expect(
    spoilerItem.getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
    }),
  ).toBeVisible();
  await expect(spoilerItem).not.toContainText("The visitor was the narrator.");
  await expect(
    page
      .locator(`[data-item-id="${own}"]`)
      .getByRole("button", { name: "Delete", exact: true }),
  ).toBeVisible();
  // Every revealed entry keeps its reactions and discussion.
  const revealed = entries.filter({ hasNot: page.locator(".spoiler") });
  await expect(revealed).toHaveCount(8);
  for (const item of await revealed.all()) {
    await expect(
      item.getByRole("button", { name: "React", exact: true }),
    ).toHaveCount(1);
    await expect(
      item.getByRole("button", { name: "Comment", exact: true }),
    ).toHaveCount(1);
  }

  // Start a conversation sits on the heading row and opens the composer below.
  const heading = page.getByRole("heading", { name: "Around this title" });
  const start = page.getByRole("button", {
    name: "Start a conversation",
    exact: true,
  });
  await expect(page.getByText("Your circle’s conversations")).toHaveCount(0);
  await expect(page.locator(".title-comment-composer")).toHaveCount(0);

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    // The friend line follows the header buttons, before availability.
    const buttons = await box(header);
    const lineBox = await box(line);
    expect(lineBox.y).toBeGreaterThanOrEqual(buttons.y + buttons.height);
    expect(lineBox.y).toBeLessThan(
      (await box(page.getByRole("heading", { name: "Where to watch" }))).y,
    );
    await expectTextContrast(line);
    await expectTextContrast(line.getByRole("link", { name: "Lee Wong" }));
    // The heading and its button share a row.
    const headingBox = await box(heading);
    const startBox = await box(start);
    expect(startBox.y).toBeLessThan(headingBox.y + headingBox.height);
    expect(startBox.y + startBox.height).toBeGreaterThan(headingBox.y);
    expect(startBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
    // The copy link ends the author line, at the card's right edge.
    const leeItem = page.locator(`[data-item-id="${ids[lee]}"]`);
    const author = await box(leeItem.locator(".activity-by"));
    const copy = await box(
      leeItem.getByRole("button", { name: "Copy link to discussion" }),
    );
    const card = await box(leeItem.locator(".activity-card"));
    expect(copy.y).toBeLessThan(author.y + author.height);
    expect(copy.y + copy.height).toBeGreaterThan(author.y);
    expect(copy.x).toBeGreaterThan(author.x);
    expect(card.x + card.width - (copy.x + copy.width)).toBeLessThan(20);
    await page.screenshot({
      path: `.cache/title-page-${width}.png`,
      fullPage: true,
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await start.click();
  const composer = page.getByRole("form", { name: "New title comment" });
  await expect(composer.getByLabel("Your comment")).toBeFocused();
  expect((await box(composer)).y).toBeGreaterThan(
    (await box(heading)).y + (await box(heading)).height,
  );
  await composer.getByRole("button", { name: "Cancel" }).click();
  await expect(composer).toHaveCount(0);
  await expect(start).toBeFocused();

  // A name moves to that friend's entry and focuses it, clear of the
  // phone header, without changing the address.
  const url = page.url();
  await line.getByRole("link", { name: "Theo Park" }).click();
  const theoItem = page.locator(`[data-item-id="${theoEntry}"]`);
  await expect(theoItem).toBeFocused();
  await expect(theoItem).toBeInViewport();
  const headerBottom = await page
    .locator(".sidebar")
    .evaluate((element) => element.getBoundingClientRect().bottom);
  expect((await box(theoItem)).y).toBeGreaterThanOrEqual(headerBottom);
  expect(page.url()).toBe(url);
  await line.getByRole("link", { name: "Sam Okafor" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-item-id="${ids[sam]}"]`)).toBeFocused();
  await expect(page.locator(`[data-item-id="${ids[sam]}"]`)).toBeInViewport();

  // New friend activity updates the line at once. Choosing the new name
  // shows the entry waiting behind New activity.
  const kaiEntry = await updateTitleActivity(
    kai,
    "movie:996090",
    "want_to_watch",
    true,
  );
  await expect(line).toContainText("Kai Moss and Theo Park want to watch");
  await expect(
    page.getByRole("button", { name: "New activity (1)" }),
  ).toBeVisible();
  const kaiItem = page.locator(`[data-item-id="${kaiEntry}"]`);
  await expect(kaiItem).toHaveCount(0);
  await line.getByRole("link", { name: "Kai Moss" }).click();
  await expect(kaiItem).toBeFocused();
  await expect(kaiItem).toBeInViewport();
  await expect(page.getByRole("button", { name: /^New activity/ })).toHaveCount(
    0,
  );

  // Friends and profile feeds keep full entries.
  await page.goto("/");
  const full = page.locator(`[data-item-id="${ids[lee]}"]`);
  await expect(
    full.getByRole("heading", { name: "Friend Line Movie" }),
  ).toBeVisible();
  await expect(
    full.getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  await expect(full.locator(".activity-by")).toContainText(
    "Lee Wong recommends",
  );

  // With no friend's action, only the viewer's own and a nonfriend's, the
  // line is hidden.
  await updateTitleActivity(viewer, "movie:996091", "recommended", true);
  await updateTitleActivity(stranger, "movie:996091", "recommended", true);
  await page.goto("/titles/movie/996091");
  await expect(
    page.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-item-id]")).toHaveCount(1);
  await expect(line).toHaveCount(0);
});

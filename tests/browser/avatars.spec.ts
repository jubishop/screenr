import { expect, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "./database-fixture";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";

const { addComment, changeRelationship, updateProfile, updateTitleActivity } =
  await import("../../src/server/social");

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
const background = (avatar: Locator) =>
  avatar.evaluate((element) => getComputedStyle(element).backgroundColor);
async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}

test("avatars mark every person with a whole initial and a color that survives renaming", async ({
  page,
  signIn,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const viewer = await signIn(page, "avatarviewer", {
    displayName: "Avery Viewer",
  });
  const film = await person("avatarfilm", "🎬 Film Friend");
  const theo = await person("avatartheo", "Theo Third");
  const quinn = await person("avatarquinn", "Quinn Quiet");
  await friend(viewer, film);
  await friend(viewer, quinn);
  await friend(film, theo);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:996070','movie',996070,'Avatar Movie') ON CONFLICT DO NOTHING",
  );
  const post = await updateTitleActivity(
    viewer,
    "movie:996070",
    "recommended",
    true,
  );
  const filmEntry = await updateTitleActivity(
    film,
    "movie:996070",
    "want_to_watch",
    true,
  );
  // Quinn's comment stays as context for Film's reply after Quinn leaves.
  const quiet = await addComment(quinn, post, "Quinn's comment", false);
  await addComment(film, post, "Film reply to Quinn", false, quiet);
  await addComment(film, post, "Film direct comment", false);
  await changeRelationship(viewer, quinn, "remove");

  await page.goto("/");
  const own = page.locator(`[data-item-id="${post}"]`);
  const filmItem = page.locator(`[data-item-id="${filmEntry}"]`);
  const filmAuthor = filmItem.locator(".activity-by .avatar");
  await expect(filmAuthor).toHaveText("🎬");
  await expect(own.locator(".activity-by .avatar")).toHaveText("A");
  await expectTextContrast(own.locator(".activity-by .avatar"));
  const filmColor = await background(filmAuthor);
  const direct = own
    .locator(".comment")
    .filter({ hasText: "Film direct comment" });
  await expect(direct.locator(".avatar")).toHaveText("🎬");
  expect(await background(direct.locator(".avatar"))).toBe(filmColor);
  const unavailable = own
    .locator(".comment")
    .filter({ hasText: "Comment unavailable" });
  await expect(unavailable.locator(".avatar-placeholder")).toBeVisible();
  await expect(unavailable.locator(".avatar")).toHaveText("");
  await expect(unavailable.getByRole("link")).toHaveCount(0);

  // The phone header links the viewer's own profile with their avatar.
  const header = page.getByRole("banner");
  const profileLink = header.getByRole("link", {
    name: "Your profile",
    exact: true,
  });
  await expect(profileLink).toBeVisible();
  await expect(profileLink).toHaveAttribute("href", "/people/avatarviewer");
  await expect(profileLink.locator(".avatar")).toHaveText("A");
  const headerBox = await box(header);
  expect(headerBox.height).toBeLessThanOrEqual(60);
  await page.screenshot({ path: ".cache/avatars-feed-390.png" });

  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  const notice = panel
    .locator(".notification-item")
    .filter({ hasText: "🎬 Film Friend commented" })
    .first();
  await expect(notice.locator(".avatar")).toHaveText("🎬");
  expect(await background(notice.locator(".avatar"))).toBe(filmColor);
  await page.keyboard.press("Escape");

  await profileLink.click();
  await expect(page).toHaveURL(/\/people\/avatarviewer$/);
  for (const [path, initial, name, username] of [
    ["/people/avatarviewer", "A", "Avery Viewer", "@avatarviewer"],
    ["/people/avatarfilm", "🎬", "🎬 Film Friend", "@avatarfilm"],
  ]) {
    if (!page.url().endsWith(path)) await page.goto(path);
    const heading = page.locator(".profile-heading");
    const avatar = heading.locator(".avatar");
    const title = heading.getByRole("heading", { level: 1 });
    const handle = heading.getByText(username, { exact: true });
    await expect(avatar).toHaveText(initial);
    await expect(title).toHaveText(name);
    // The avatar sits beside the name, with @username in normal text below.
    const [avatarBox, titleBox, handleBox] = [
      await box(avatar),
      await box(title),
      await box(handle),
    ];
    expect(avatarBox.x + avatarBox.width).toBeLessThan(titleBox.x);
    expect(handleBox.y).toBeGreaterThanOrEqual(
      titleBox.y + titleBox.height - 1,
    );
    await expect(handle).toHaveCSS("letter-spacing", "normal");
    await expect(handle).toHaveCSS("font-size", "15px");
    await expectTextContrast(handle);
  }
  await expect(page.locator("main .eyebrow")).toHaveCount(0);
  await page.screenshot({ path: ".cache/avatars-profile-390.png" });

  await page.goto("/people");
  const filmRow = page
    .getByRole("region", { name: "Friends", exact: true })
    .getByRole("article")
    .filter({ hasText: "Film Friend" });
  await expect(filmRow.locator(".avatar")).toHaveText("🎬");
  expect(await background(filmRow.locator(".avatar"))).toBe(filmColor);
  await expect(
    page
      .getByRole("region", { name: "People you may know", exact: true })
      .getByRole("article")
      .locator(".avatar"),
  ).toHaveText("T");

  await page.goto("/watch-together?with=avatarfilm");
  await expect(page.locator(".participants .avatar")).toHaveText(["A", "🎬"]);

  // Desktop keeps the sidebar profile link and hides the header copy.
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(page.locator(".sidebar-bottom .avatar")).toHaveText("A");
  await expect(page.locator(".sidebar-bottom .avatar")).toBeVisible();
  await expect(profileLink).toBeHidden();
  await page.goto("/");
  await page.screenshot({ path: ".cache/avatars-feed-1366.png" });

  // Renaming changes the initial but not the color.
  await updateProfile(film, "Zed Film", "avatarfilmnew");
  await page.goto("/people");
  const renamed = page
    .getByRole("region", { name: "Friends", exact: true })
    .getByRole("link", { name: "Zed Film @avatarfilmnew", exact: true });
  await expect(renamed.locator(".avatar")).toHaveText("Z");
  expect(await background(renamed.locator(".avatar"))).toBe(filmColor);
  await page.goto("/");
  await expect(filmAuthor).toHaveText("Z");
  expect(await background(filmAuthor)).toBe(filmColor);
  // Every avatar is decorative beside its visible name.
  await expect(page.locator(".avatar:not([aria-hidden='true'])")).toHaveCount(
    0,
  );
});

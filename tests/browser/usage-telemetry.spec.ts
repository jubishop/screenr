import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { nextAccountRefreshForPath } from "./refresh-helpers";

const { changeRelationship, updateTitleActivity } =
  await import("../../src/server/social");

async function person(username: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES($1,$2,$3,true,now(),now())`,
    [id, username, `${username}@example.test`],
  );
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES($1,$2,$2)",
    [id, username],
  );
  return id;
}

test("page loads and navigation count as active days, background refreshes do not, and saves report their surface", async ({
  page,
  signIn,
}) => {
  const viewer = await signIn(page, "usageviewer");
  const activeDays = async () =>
    (
      await db.query("SELECT 1 FROM member_active_day WHERE user_id=$1", [
        viewer,
      ])
    ).rowCount;
  expect(await activeDays()).toBe(1);

  await db.query("DELETE FROM member_active_day WHERE user_id=$1", [viewer]);
  await nextAccountRefreshForPath(page, "/");
  await Promise.all([
    nextAccountRefreshForPath(page, "/"),
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
  ]);
  expect(await activeDays()).toBe(0);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: /^Find/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Find a title", exact: true }),
  ).toBeVisible();
  expect(await activeDays()).toBe(1);

  await db.query(`INSERT INTO title(id,kind,tmdb_id,name,overview) VALUES
    ('movie:987654','movie',987654,'The Lantern Room','A fictional coastal story.'),
    ('tv:998001','tv',998001,'The Harbor Signal','A fictional mystery.')
    ON CONFLICT(id) DO NOTHING`);
  const friend = await person("usagefriend");
  await changeRelationship(viewer, friend, "request");
  await changeRelationship(friend, viewer, "accept");
  await updateTitleActivity(friend, "movie:987654", "recommended", true);
  await updateTitleActivity(friend, "tv:998001", "want_to_watch", true);
  await page.goto("/");
  for (const action of ["recommends", "wants to watch"]) {
    const entry = page
      .locator(".feed-entry")
      .filter({ hasText: `usagefriend ${action}` });
    await entry
      .getByRole("button", { name: "+ Want to watch", exact: true })
      .click();
    await expect(
      entry.getByRole("button", { name: "✓ Want to watch", exact: true }),
    ).toBeVisible();
  }
  await page.goto("/titles/tv/998001");
  const hero = page.locator(".title-hero");
  await hero
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await hero
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(
    hero.getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  expect(
    (
      await db.query(
        `SELECT title_id,surface,friend_recommending FROM want_to_watch_save
        WHERE user_id=$1 ORDER BY id`,
        [viewer],
      )
    ).rows,
  ).toEqual([
    {
      title_id: "movie:987654",
      surface: "friend_recommendation",
      friend_recommending: true,
    },
    {
      title_id: "tv:998001",
      surface: "friend_entry",
      friend_recommending: false,
    },
    { title_id: "tv:998001", surface: "title", friend_recommending: false },
  ]);
});

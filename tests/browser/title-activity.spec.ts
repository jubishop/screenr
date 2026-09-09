import { expect, type Page, type Locator } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, db } from "./database-fixture";
import { browserConfig } from "../../scripts/browser-config";

const { updateTitleActivity, changeRelationship, addComment } =
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

async function signIn(page: Page, username: string) {
  const email = `${username}@example.test`;
  const headers = { Origin: browserConfig.baseURL };
  expect(
    (
      await page.request.post("/api/auth/email-otp/send-verification-otp", {
        headers,
        data: { email, type: "sign-in" },
      })
    ).ok(),
  ).toBe(true);
  const filename = createHash("sha256").update(email).digest("hex");
  const { otp } = JSON.parse(
    await readFile(`.cache/mail/${filename}.json`, "utf8"),
  );
  expect(
    (
      await page.request.post("/api/auth/sign-in/email-otp", {
        headers,
        data: { email, otp },
      })
    ).ok(),
  ).toBe(true);
}

test("title and feed actions switch exclusively and restore each original discussion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Trailer fixture" }),
  );
  const owner = await person("exclusiveowner");
  const viewer = await person("exclusiveviewer");
  await changeRelationship(owner, viewer, "request");
  await changeRelationship(viewer, owner, "accept");
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('movie:987654','movie',987654,'The Lantern Room') ON CONFLICT DO NOTHING`);
  const friendItem = await updateTitleActivity(
    owner,
    "movie:987654",
    "recommended",
    true,
  );
  const recommendation = await updateTitleActivity(
    viewer,
    "movie:987654",
    "recommended",
    true,
  );
  const recommendationReply = await addComment(
    owner,
    recommendation,
    "Recommendation discussion",
    false,
  );
  const wanted = await updateTitleActivity(
    viewer,
    "movie:987654",
    "want_to_watch",
    true,
  );
  const wantedReply = await addComment(
    owner,
    wanted,
    "Watch discussion",
    false,
  );
  await updateTitleActivity(viewer, "movie:987654", "recommended", true);
  await signIn(page, "exclusiveviewer");
  await page.setViewportSize({ width: 390, height: 900 });

  const button = (scope: Locator, name: string) =>
    scope.getByRole("button", { name, exact: true });
  async function states(
    scope: Locator,
    recommended: boolean,
    want: boolean,
    title = false,
  ) {
    await expect(
      button(
        scope,
        recommended
          ? "✓ Recommended"
          : title
            ? "Recommend to friends"
            : "+ Recommend",
      ),
    ).toBeVisible();
    await expect(
      button(scope, want ? "✓ Want to watch" : "+ Want to watch"),
    ).toBeVisible();
    await expect(
      button(
        scope,
        recommended
          ? title
            ? "Recommend to friends"
            : "+ Recommend"
          : "✓ Recommended",
      ),
    ).toHaveCount(0);
    await expect(
      button(scope, want ? "+ Want to watch" : "✓ Want to watch"),
    ).toHaveCount(0);
  }
  for (const path of ["/people/exclusiveowner", "/", "/titles/movie/987654"]) {
    await page.goto(path);
    const entry = page.locator(`[data-item-id="${friendItem}"]`);
    await states(entry, true, false);
    await button(entry, "+ Want to watch").click();
    await states(entry, false, true);
    await page.reload();
    await states(entry, false, true);
    await button(entry, "+ Recommend").click();
    await states(entry, true, false);
    await button(entry, "✓ Recommended").click();
    await states(entry, false, false);
    await button(entry, "+ Recommend").click();
    await states(entry, true, false);
    await page.reload();
    await states(entry, true, false);
  }

  const header = page.locator(".title-hero .inline-actions");
  await states(header, true, false, true);
  await button(header, "+ Want to watch").click();
  await states(header, false, true, true);
  const recEntry = page.locator(`[data-item-id="${recommendation}"]`);
  const watchEntry = page.locator(`[data-item-id="${wanted}"]`);
  await expect(recEntry).toContainText("removed their recommendation");
  await expect(
    recEntry.locator(`[data-comment-id="${recommendationReply}"]`),
  ).toContainText("Recommendation discussion");
  await expect(
    watchEntry.locator(`[data-comment-id="${wantedReply}"]`),
  ).toContainText("Watch discussion");
  await button(header, "✓ Want to watch").click();
  await states(header, false, false, true);
  await button(header, "+ Want to watch").click();
  await states(header, false, true, true);
  await expect(watchEntry).toContainText("wants to watch");
  await button(header, "Recommend to friends").click();
  await states(header, true, false, true);
  await expect(recEntry).toContainText("recommends");
  await expect(
    recEntry.locator(`[data-comment-id="${recommendationReply}"]`),
  ).toContainText("Recommendation discussion");
  await expect(watchEntry).toContainText("removed Want to watch");
  await page.reload();
  await states(header, true, false, true);
  await expect(
    watchEntry.locator(`[data-comment-id="${wantedReply}"]`),
  ).toContainText("Watch discussion");

  const friendEntry = page.locator(`[data-item-id="${friendItem}"]`);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await friendEntry.scrollIntoViewIfNeeded();
    const watchBounds = await button(
      friendEntry,
      "+ Want to watch",
    ).boundingBox();
    const recommendBounds = await button(
      friendEntry,
      "✓ Recommended",
    ).boundingBox();
    expect(recommendBounds!.y).toBeGreaterThanOrEqual(watchBounds!.y);
    if (recommendBounds!.y === watchBounds!.y)
      expect(recommendBounds!.x).toBeGreaterThan(watchBounds!.x);
    expect(recommendBounds!.x + recommendBounds!.width).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: `.cache/exclusive-actions-${width}.png`,
      fullPage: true,
    });
  }
  // The friend's own choice is unaffected by the viewer's changes.
  await signIn(page, "exclusiveowner");
  await page.goto("/people/exclusiveviewer");
  await states(page.locator(`[data-item-id="${recommendation}"]`), true, false);
  expect(errors).toEqual([]);
});

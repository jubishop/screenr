import { expect, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { confirmAction } from "./journey-helpers";

async function noOverflow(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    width,
  );
}

test("members start conversations without a title from Your circle, and friends reply, react, and follow links to the post", async ({
  member,
}) => {
  test.setTimeout(120_000);
  const owner = await member("postowner");
  const reader = await member("postreader");
  const outsider = await member("postoutsider");
  await prepareFriendship(owner, reader);

  // The compact button shares the Your circle heading row on a phone.
  const heading = owner.getByRole("heading", {
    name: "Your circle",
    exact: true,
  });
  const start = owner.getByRole("button", {
    name: "Start a conversation",
    exact: true,
  });
  await expect(owner.locator(".heading-row")).toContainText("Your circle");
  await expect(owner.locator(".heading-row").getByRole("button")).toHaveText(
    "Start a conversation",
  );
  const [headingBox, startBox] = await Promise.all([
    heading.boundingBox(),
    start.boundingBox(),
  ]);
  expect(startBox!.y).toBeGreaterThanOrEqual(headingBox!.y);
  expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(
    headingBox!.y + headingBox!.height,
  );
  const composer = owner.getByRole("form", { name: "New post" });
  await expect(composer).toHaveCount(0);
  await expect(start).toHaveAttribute("aria-expanded", "false");
  await start.click();
  await expect(start).toHaveAttribute("aria-expanded", "true");
  const field = composer.getByLabel("Your post", { exact: true });
  await expect(field).toBeFocused();
  await expect(composer.getByLabel("Season")).toHaveCount(0);
  await field.fill("Kept while closed");
  await composer.getByLabel("Contains spoilers").check();
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(start).toBeFocused();
  await start.click();
  await expect(field).toHaveValue("Kept while closed");
  await expect(composer.getByLabel("Contains spoilers")).toBeChecked();
  await composer.getByLabel("Contains spoilers").uncheck();
  await field.fill("Any good comedies for tonight?");
  await noOverflow(owner, 320);
  await owner.screenshot({ path: ".cache/post-composer-320.png" });
  await noOverflow(owner, 390);
  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(field).toHaveValue("");
  const entry = owner
    .locator("[data-item-id]")
    .filter({ hasText: "Any good comedies for tonight?" });
  await expect(entry).toBeVisible();
  const id = await entry.getAttribute("data-item-id");
  // A post without a title shows no title, poster, or title actions.
  await expect(entry.locator(".activity-by")).toContainText("postowner posted");
  await expect(entry).toHaveAccessibleName(/postowner posted/);
  await expect(entry.getByRole("heading")).toHaveCount(0);
  await expect(entry.locator(".poster-link")).toHaveCount(0);
  await expect(
    entry.getByRole("button", { name: /Want to watch/ }),
  ).toHaveCount(0);
  await expect(entry.getByRole("button", { name: /Recommend/ })).toHaveCount(0);
  await owner.goto("/people/postowner");
  await expect(owner.locator(`[data-item-id="${id}"]`)).toBeVisible();

  // Friends read, react, and reply on the friends feed and the profile.
  await reader.goto("/titles/movie/987654");
  await expect(
    reader.getByRole("heading", { name: "Around this title" }),
  ).toBeVisible();
  await expect(reader.locator("[data-item-id]")).toHaveCount(0);
  await reader.goto("/people/postowner");
  const onProfile = reader.locator(`[data-item-id="${id}"]`);
  await expect(onProfile).toContainText("Any good comedies for tonight?");
  await reader.goto("/");
  const post = reader.locator(`[data-item-id="${id}"]`);
  await expect(post).toContainText("Any good comedies for tonight?");
  const reactions = post.getByRole("group", { name: "Reactions to entry" });
  await reactions.getByRole("button", { name: "React", exact: true }).click();
  await post
    .getByRole("group", { name: "Choose a reaction" })
    .getByRole("button", { name: "Haha", exact: true })
    .click();
  await expect(
    reactions.getByRole("button", { name: "Haha: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await post.getByRole("button", { name: "Comment", exact: true }).click();
  await post.getByLabel("Add your reply").fill("Try The Lantern Room");
  await post.getByRole("button", { name: "Post reply", exact: true }).click();
  const reply = post
    .locator("[data-comment-id]")
    .filter({ hasText: "Try The Lantern Room" });
  await expect(reply).toBeVisible();
  const replyId = await reply.getAttribute("data-comment-id");
  await reader
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"]);
  await post
    .getByRole("button", { name: "Copy link to discussion", exact: true })
    .click();
  await expect(post.getByRole("status")).toHaveText("Link copied.");
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(
    `${browserConfig.baseURL}/?item=${id}`,
  );
  await noOverflow(reader, 320);
  await reader.screenshot({ path: ".cache/post-feed-320.png", fullPage: true });
  await reader.setViewportSize({ width: 1366, height: 900 });
  await reader.screenshot({ path: ".cache/post-feed-1366.png" });

  // People outside the author's circle see nothing, even through the link.
  await outsider.goto(`/?item=${id}`);
  await expect(
    outsider.getByText("This activity is unavailable."),
  ).toBeVisible();
  await expect(outsider.locator(`[data-item-id="${id}"]`)).toHaveCount(0);
  const denied = await outsider.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "No access", spoiler: false },
  });
  expect(denied.status()).toBe(404);

  // The notification opens the friends feed at the reply.
  await owner.goto("/");
  await owner.getByRole("button", { name: /^Notifications/ }).click();
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: /postreader commented on your post/ })
    .click();
  await expect(owner).toHaveURL(
    `${browserConfig.baseURL}/?item=${id}&reply=${replyId}`,
  );
  await expect(
    owner.locator(`[data-comment-id="${replyId}"]`),
  ).toBeInViewport();

  // Deleting the post erases its text and keeps the reply.
  const own = owner.locator(`[data-item-id="${id}"]`);
  await confirmAction(own, "Delete");
  await expect(own.getByText("Post removed", { exact: true })).toBeVisible();
  await expect(own).not.toContainText("Any good comedies for tonight?");
  await reader.goto("/");
  await expect(post.getByText("Post removed", { exact: true })).toBeVisible();
  await expect(post.getByText("Try The Lantern Room")).toBeVisible();
});

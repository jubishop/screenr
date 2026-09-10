import { expect, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { join, befriend } from "./journey-helpers";

test("invited friends discover, save, and share inline discussions with live access enforcement", async ({
  browser,
}) => {
  const alice = await join(browser, "alice"),
    ben = await join(browser, "ben"),
    cam = await join(browser, "cam"),
    outsider = await join(browser, "outsider");
  await befriend(alice, ben, "ben", "alice");
  await befriend(alice, cam, "cam", "alice");
  await alice.goto("/search");
  await alice.getByLabel("Movie or show title").fill("Lantern");
  await alice.getByRole("button", { name: "Search", exact: true }).click();
  await alice
    .getByRole("heading", { name: "The Lantern Room", exact: true })
    .click();
  await alice
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  await expect(
    alice.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
  await alice.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const titleURL = alice.url();
  await alice
    .getByRole("button", { name: "Copy link to discussion", exact: true })
    .click();
  await expect(alice.getByRole("status")).toHaveText("Link copied.");
  await expect(alice).toHaveURL(titleURL);
  const conversationURL = await alice.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(new URL(conversationURL).origin).toBe(browserConfig.baseURL);
  expect(
    new URL(conversationURL).pathname + new URL(conversationURL).search,
  ).toMatch(/^\/titles\/movie\/987654\?item=[0-9a-f-]+$/);
  const id = new URL(conversationURL).searchParams.get("item")!;
  const item = (page: Page) => page.locator(`[data-item-id="${id}"]`);
  await ben.goto("/");
  await item(ben)
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(ben.locator("[data-item-id]")).toHaveCount(2);
  await item(ben).getByRole("button", { name: "Comment", exact: true }).click();
  await item(ben)
    .getByLabel("Add your reply")
    .fill("This looks like our kind of movie.");
  await item(ben)
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    item(ben).getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await expect(
    alice.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(
    item(alice).getByText("This looks like our kind of movie.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await alice.getByRole("button", { name: /New activity/ }).click();
  await item(alice).getByRole("button", { name: "Reply", exact: true }).click();
  const nestedComposer = item(alice).getByRole("form", {
    name: "Replying to @ben",
    exact: true,
  });
  await nestedComposer.getByRole("textbox").fill("The ending surprised me.");
  await nestedComposer.getByLabel("Contains spoilers", { exact: true }).check();
  await nestedComposer
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(ben.getByRole("button", { name: /New activity/ })).toBeVisible();
  await ben.getByRole("button", { name: /New activity/ }).click();
  await expect(
    item(ben).getByText("The ending surprised me.", { exact: true }),
  ).toHaveCount(0);
  await item(ben)
    .getByRole("button", { name: "View 1 reply", exact: true })
    .click();
  await item(ben)
    .getByRole("button", { name: /Reveal comment/ })
    .click();
  await expect(
    item(ben).getByText("The ending surprised me.", { exact: true }),
  ).toBeVisible();
  await expect(
    item(ben).getByText("Replying to @ben", { exact: true }),
  ).toBeVisible();
  await ben.reload();
  await expect(
    item(ben).getByText("The ending surprised me.", { exact: true }),
  ).toHaveCount(0);
  const denied = await outsider.request.get(
    `/api/screenr/screen?path=/conversations/${id}`,
  );
  expect(denied.status()).toBe(404);
  const write = (page: Page, body: string, replyTo?: string) =>
    page.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: { conversation: id, body, spoiler: false, replyTo },
    });
  expect((await write(outsider, "Unauthorized")).status()).toBe(404);
  await outsider.goto(conversationURL);
  await expect(outsider.getByRole("status")).toHaveText(
    "This activity is unavailable.",
  );
  await expect(item(outsider)).toHaveCount(0);
  await cam.goto(conversationURL);
  await expect(
    item(cam).getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await expect(
    item(cam).getByRole("button", { name: /^(Delete|Remove)$/ }),
  ).toHaveCount(0);
  await alice.goto("/people/ben");
  await alice.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(item(ben)).toHaveCount(0);
  await expect(
    item(cam).getByText("This looks like our kind of movie.", { exact: true }),
  ).toHaveCount(0);
  await befriend(alice, ben, "ben", "alice");
  await ben.goto(conversationURL);
  await expect(
    item(ben).getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await ben.goto("/people/cam");
  await ben.getByRole("button", { name: "Block", exact: true }).click();
  await item(cam).getByRole("button", { name: "Comment", exact: true }).click();
  await item(cam).getByLabel("Add your reply").fill("Cam’s view of the film.");
  await item(cam)
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await ben.goto(conversationURL);
  await expect(
    item(ben).getByText("Cam’s view of the film.", { exact: true }),
  ).toHaveCount(0);
  await alice.goto(conversationURL);
  const camComment = item(alice)
    .locator("[data-comment-id]")
    .filter({ hasText: "Cam’s view of the film." });
  const camReply = await camComment.getAttribute("data-comment-id");
  const reply = await write(alice, "The host can reply to Cam", camReply!);
  expect(reply.status()).toBe(200);
  await alice.reload();
  await camComment.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    item(alice)
      .locator(`[data-comment-id="${camReply}"]`)
      .getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await item(alice)
    .getByRole("button", { name: "View 1 reply", exact: true })
    .last()
    .click();
  await expect(
    item(alice).getByText("Replying to @cam", { exact: true }),
  ).toBeVisible();
  const ownComment = (page: Page) =>
    item(page).locator("[data-comment-id]").filter({
      hasText: "This looks like our kind of movie.",
    });
  for (const path of ["/", "/people/alice", conversationURL]) {
    await ben.goto(path);
    await expect(
      ownComment(ben).getByRole("button", { name: "Delete", exact: true }),
    ).toBeVisible();
    await expect(
      item(ben).getByRole("button", { name: "Remove", exact: true }),
    ).toHaveCount(0);
  }
  const ownId = await ownComment(ben).getAttribute("data-comment-id");
  for (const page of [cam, outsider]) {
    const deniedRemoval = await page.request.post(
      "/api/screenr/remove-comment",
      {
        headers: { Origin: browserConfig.baseURL },
        data: { id: ownId },
      },
    );
    expect(deniedRemoval.status()).toBe(404);
  }
  await ben.route(
    "**/api/screenr/remove-comment",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Deletion failed. Please try again." },
      }),
    { times: 1 },
  );
  await ownComment(ben)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(item(ben).getByRole("alert")).toHaveText(
    "Deletion failed. Please try again.",
  );
  await expect(ownComment(ben)).toBeVisible();
  await ownComment(ben)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(item(ben).getByRole("alert")).toHaveCount(0);
  for (const page of [ben, alice]) {
    await expect(
      item(page).locator(`[data-comment-id="${ownId}"]`),
    ).toContainText("Comment removed");
    await expect(
      item(page).getByText("This looks like our kind of movie.", {
        exact: true,
      }),
    ).toHaveCount(0);
    const group = item(page)
      .locator(".comment-group")
      .filter({
        has: page.locator(`[data-comment-id="${ownId}"]`),
      });
    const expansion = group.getByRole("button", {
      name: "View 1 reply",
      exact: true,
    });
    if ((await expansion.getAttribute("aria-expanded")) !== "true")
      await expansion.click();
    await expect(
      item(page).getByText("Replying to @ben", { exact: true }),
    ).toBeVisible();
  }
  await ben.reload();
  await expect(item(ben).locator(`[data-comment-id="${ownId}"]`)).toContainText(
    "Comment removed",
  );
  await expect(
    item(ben).getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  await alice.goto("/invites");
  await alice.getByLabel("Maximum signups").selectOption("2");
  await alice
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(alice.getByLabel("Invitation link")).toHaveValue(/\/join\//);
  await alice.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(alice.getByLabel("Invitation link")).toHaveCount(0);
  await expect(
    alice.getByText("No active invitations.", { exact: true }),
  ).toBeVisible();
  for (const page of [alice, ben, cam, outsider]) await page.context().close();
});

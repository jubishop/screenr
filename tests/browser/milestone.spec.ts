import { test, expect, type Page, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

async function join(browser: Browser, name: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const token = (await readFile(".cache/browser-invite.txt", "utf8")).trim();
  const email = `${name}.browser@example.test`;
  await page.goto(`/join/${token}`);
  await page.getByLabel("Email address").fill(email);
  await page
    .getByRole("button", { name: "Send sign-in code", exact: true })
    .click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  const filename = createHash("sha256").update(email).digest("hex");
  const { otp } = JSON.parse(
    await readFile(`.cache/mail/${filename}.json`, "utf8"),
  );
  await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Username", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Join Screenr", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
  return page;
}
async function befriend(a: Page, b: Page, bName: string, aName: string) {
  await a.goto(`/people/${bName}`);
  await a
    .getByRole("button", { name: "Send friend request", exact: true })
    .click();
  await expect(
    a.getByRole("button", { name: "Cancel friend request", exact: true }),
  ).toBeVisible();
  await b.goto(`/people/${aName}`);
  await b
    .getByRole("button", { name: "Accept friend request", exact: true })
    .click();
  await expect(
    b.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeVisible();
}

test("invited friends discover, save, and share a persistent conversation with live access enforcement", async ({
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
  await alice.getByRole("link", { name: /Open conversation/ }).click();
  await expect(alice).toHaveURL(/\/conversations\/[0-9a-f-]+$/);
  const conversationURL = alice.url();
  const conversationId = conversationURL.split("/").at(-1)!;
  await ben.goto("/");
  await expect(
    ben.getByText("The Lantern Room", { exact: true }),
  ).toBeVisible();
  await ben
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await ben.goto("/titles/movie/987654");
  await expect(
    ben
      .locator(".title-hero")
      .getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  const original = ben.locator(".activity-card").filter({ hasText: "alice" });
  await original.getByRole("link", { name: /Open conversation/ }).click();
  await expect(ben).toHaveURL(conversationURL);
  await ben
    .getByLabel("Add your reply")
    .fill("This looks like our kind of movie.");
  await ben.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    ben.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await expect(
    alice.getByRole("button", { name: /New replies/ }),
  ).toBeVisible();
  await expect(
    alice.getByText("This looks like our kind of movie.", { exact: true }),
  ).not.toBeVisible();
  await alice.getByRole("button", { name: /New replies/ }).click();
  await expect(
    alice.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await alice.getByRole("button", { name: "Reply", exact: true }).click();
  await alice.getByLabel("Add your reply").fill("The ending surprised me.");
  await alice.getByLabel("Contains spoilers", { exact: true }).check();
  await alice.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(ben.getByRole("button", { name: /New replies/ })).toBeVisible();
  await ben.getByRole("button", { name: /New replies/ }).click();
  await expect(
    ben.getByText("The ending surprised me.", { exact: true }),
  ).not.toBeVisible();
  await ben
    .getByRole("button", {
      name: "Contains spoilers · Reveal comment",
      exact: true,
    })
    .click();
  await expect(
    ben.getByText("The ending surprised me.", { exact: true }),
  ).toBeVisible();
  await ben.reload();
  await expect(
    ben.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  const denied = await outsider.request.get(
    `/api/screenr/screen?path=/conversations/${conversationId}`,
  );
  expect(denied.status()).toBe(404);
  const deniedWrite = await outsider.request.post("/api/screenr/comment", {
    headers: { Origin: "http://localhost:3055" },
    data: {
      conversation: conversationId,
      body: "Unauthorized",
      spoiler: false,
    },
  });
  expect(deniedWrite.status()).toBe(404);
  await outsider.goto(conversationURL);
  await expect(
    outsider.getByText("Conversation not found.", { exact: false }),
  ).toBeVisible();
  await expect(
    outsider.getByText("This looks like our kind of movie.", { exact: true }),
  ).not.toBeVisible();
  await cam.goto(conversationURL);
  await expect(
    cam.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await alice.goto("/people/ben");
  await alice.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(
    ben.getByText("Conversation not found.", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    cam.getByText("This looks like our kind of movie.", { exact: true }),
  ).not.toBeVisible({ timeout: 10000 });
  await befriend(alice, ben, "ben", "alice");
  await ben.goto(conversationURL);
  await expect(
    ben.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await ben.goto("/people/cam");
  await ben.getByRole("button", { name: "Block", exact: true }).click();
  await cam.getByLabel("Add your reply").fill("Cam’s view of the film.");
  await cam.getByRole("button", { name: "Post reply", exact: true }).click();
  await ben.goto(conversationURL);
  await expect(
    ben.getByText("Cam’s view of the film.", { exact: true }),
  ).not.toBeVisible();
  await alice.goto(conversationURL);
  await expect(
    alice.getByText("Cam’s view of the film.", { exact: true }),
  ).toBeVisible();
  await alice.goto("/invites");
  await alice.getByLabel("Maximum signups").selectOption("2");
  await alice
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(alice.getByLabel("Invitation link")).toHaveValue(/\/join\//);
  await alice.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(alice.getByText("Revoked", { exact: true })).toBeVisible();
  await ben.goto("/");
  await ben.screenshot({ path: ".cache/screenr-mobile.png", fullPage: true });
  await alice.setViewportSize({ width: 1400, height: 1000 });
  await alice.goto("/");
  await alice.screenshot({
    path: ".cache/screenr-desktop.png",
    fullPage: true,
  });
  for (const page of [alice, ben, cam, outsider]) await page.context().close();
});

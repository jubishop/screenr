import { expect } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

test("discussion links copy from every feed without navigating or losing drafts and recover from clipboard failures", async ({
  member,
}) => {
  const owner = await member("copyowner");
  const reader = await member("copyreader", { hasTouch: true });
  await prepareFriendship(owner, reader);
  await owner.goto("/titles/tv/987657");
  await owner
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  const recommendation = owner.locator("[data-item-id]");
  const recommendationId = await recommendation.getAttribute("data-item-id");
  const keepDiscussion = await owner.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: {
      conversation: recommendationId,
      body: "A retained recommendation discussion",
      spoiler: false,
    },
  });
  expect(keepDiscussion.status()).toBe(200);
  await owner
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  const composer = owner.getByRole("form", { name: "New title comment" });
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("An independent discussion to share");
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(owner.locator("[data-item-id]")).toHaveCount(3);
  const discussion = owner.locator("[data-item-id]").filter({
    hasText: "An independent discussion to share",
  });
  await discussion
    .getByRole("button", { name: "Comment", exact: true })
    .click();
  await discussion.getByLabel("Add your reply").fill("A direct comment");
  await discussion
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  const directComment = discussion.locator("[data-comment-id]").filter({
    hasText: "A direct comment",
  });
  await directComment
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const nestedComposer = discussion.getByRole("form", {
    name: "Replying to @copyowner",
    exact: true,
  });
  await nestedComposer
    .getByLabel("Your nested reply")
    .fill("A reply to that comment");
  await nestedComposer
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    discussion
      .locator("[data-comment-id]")
      .getByText("A reply to that comment"),
  ).toBeVisible();
  await reader
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"]);

  for (const path of ["/titles/tv/987657", "/", "/people/copyowner"]) {
    await reader.goto(path);
    const entries = reader.locator("[data-item-id]");
    await expect(entries).toHaveCount(3);
    const comments = entries.locator("[data-comment-id]");
    await expect(comments).toHaveCount(2);
    await entries
      .getByRole("button", { name: "View 1 reply", exact: true })
      .click();
    await expect(comments).toHaveCount(3);
    await expect(
      comments.getByRole("link", { name: "Link to reply" }),
    ).toHaveCount(0);
    await expect(comments.getByText("↗", { exact: true })).toHaveCount(0);
    for (const comment of await comments.all()) {
      await expect(comment.getByRole("link")).toHaveAttribute(
        "href",
        "/people/copyowner",
      );
      await expect(
        comment.getByRole("button", { name: "Reply", exact: true }),
      ).toBeVisible();
    }
    for (const entry of await entries.all()) {
      const id = await entry.getAttribute("data-item-id");
      const expectedURL = `${browserConfig.baseURL}/titles/tv/987657?item=${id}`;
      await entry.getByRole("button", { name: "Comment", exact: true }).click();
      const draft = entry.getByLabel("Add your reply");
      await draft.fill("Keep this reply draft.");
      const copy = entry.getByRole("button", {
        name: "Copy link to discussion",
        exact: true,
      });
      await expect(copy).toBeVisible();
      await expect(entry.getByRole("status")).toBeEmpty();
      await copy.tap();
      await expect(entry.getByRole("status")).toHaveText("Link copied.");
      expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(
        expectedURL,
      );
      await expect(reader).toHaveURL(`${browserConfig.baseURL}${path}`);
      await expect(draft).toHaveValue("Keep this reply draft.");
      await reader.evaluate(() =>
        navigator.clipboard.writeText("Before keyboard copy"),
      );
      await copy.focus();
      await reader.keyboard.press("Enter");
      await expect(copy).toBeFocused();
      await expect(reader).toHaveURL(`${browserConfig.baseURL}${path}`);
      await expect
        .poll(() => reader.evaluate(() => navigator.clipboard.readText()))
        .toBe(expectedURL);
    }
  }

  const entry = reader.locator("[data-item-id]").first();
  const copy = entry.getByRole("button", {
    name: "Copy link to discussion",
    exact: true,
  });
  for (const unavailable of [false, true]) {
    await reader.evaluate((unavailable) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: unavailable
          ? undefined
          : {
              writeText: async () => {
                throw new DOMException("Clipboard denied", "NotAllowedError");
              },
            },
      });
    }, unavailable);
    await copy.tap();
    await expect(entry.getByRole("status")).toHaveText(
      "Could not copy the link. Please try again.",
    );
    await expect(reader).toHaveURL(`${browserConfig.baseURL}/people/copyowner`);
    await expect(entry.getByLabel("Add your reply")).toHaveValue(
      "Keep this reply draft.",
    );
  }
  await reader.evaluate(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });
  await copy.tap();
  await expect(entry.getByRole("status")).toHaveText("Link copied.");
  const sharedURL = await reader.evaluate(() => navigator.clipboard.readText());
  await owner.goto(sharedURL);
  await expect(
    owner.locator(
      `[data-item-id="${new URL(sharedURL).searchParams.get("item")}"]`,
    ),
  ).toBeInViewport();
  await reader.setViewportSize({ width: 320, height: 844 });
  expect(
    await reader.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(320);
  await reader.screenshot({
    path: ".cache/discussion-copy-mobile.png",
    fullPage: true,
  });
  await owner.context().close();
  await reader.context().close();
});

test("feed poster links name their titles and support keyboard navigation with and without artwork", async ({
  member,
}) => {
  const owner = await member("posterowner");
  const reader = await member("posterreader");
  await prepareFriendship(owner, reader);
  for (const page of [owner, reader]) {
    await page.route("**/_next/image?**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoIAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
  }
  await owner.goto("/search");
  await owner.getByLabel("Movie or show title").fill("Lantern");
  await owner.getByRole("button", { name: "Search", exact: true }).click();
  const result = owner.locator(".search-result");
  await expect(result).toHaveAccessibleName("The Lantern Room Movie · 2026");
  await result.click();
  await expect(owner).toHaveURL(/\/titles\/movie\/987654$/);

  for (const [id, name, hasArtwork] of [
    [987654, "The Lantern Room", false],
    [987658, "The Painted Sky", true],
  ] as const) {
    const titlePath = `/titles/movie/${id}`;
    await owner.goto(titlePath);
    await owner
      .getByRole("button", { name: "Recommend to friends", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "✓ Recommended", exact: true }),
    ).toBeVisible();
    for (const path of ["/", "/people/posterowner", titlePath]) {
      await reader.goto(path);
      const entry = reader.locator(".feed-entry").filter({
        has: reader.getByRole("heading", { name, exact: true }),
      });
      const poster = entry.locator(".poster-link");
      await expect(poster.getByRole("img")).toHaveCount(hasArtwork ? 1 : 0);
      await expect(poster).toHaveAccessibleName(name);
      await poster.focus();
      await expect(poster).toBeFocused();
      await reader.keyboard.press("Enter");
      await expect(reader).toHaveURL(new RegExp(`${titlePath}$`));
      await expect(
        reader.getByRole("heading", { name, level: 1, exact: true }),
      ).toBeVisible();

      await reader.goto(path);
      const titleLink = entry
        .getByRole("heading", { name, exact: true })
        .getByRole("link", { name, exact: true });
      await titleLink.click();
      await expect(reader).toHaveURL(new RegExp(`${titlePath}$`));
      await expect(
        reader.getByRole("heading", { name, level: 1, exact: true }),
      ).toBeVisible();
    }
  }
  await reader.context().close();
  await owner.context().close();
});

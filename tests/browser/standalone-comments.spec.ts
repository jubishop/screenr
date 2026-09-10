import { expect, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

test("standalone title comments persist and share replies across all three mobile feeds", async ({
  member,
}) => {
  test.setTimeout(120_000);
  const owner = await member("commentowner");
  const reader = await member("commentreader");
  const outsider = await member("commentoutsider");
  await prepareFriendship(owner, reader);
  await owner.goto("/titles/movie/987654");
  const composer = owner.getByRole("form", { name: "New title comment" });
  const start = owner.getByRole("button", {
    name: "Start a conversation",
    exact: true,
  });
  await expect(composer).toHaveCount(0);
  await expect(start).toHaveAttribute("aria-expanded", "false");
  await start.focus();
  await owner.keyboard.press("Enter");
  await expect(start).toHaveAttribute("aria-expanded", "true");
  await expect(composer.getByRole("textbox")).toBeFocused();
  await expect(
    composer.getByRole("button", { name: "Post comment", exact: true }),
  ).toBeDisabled();
  await composer.getByRole("textbox").fill("Saved for later");
  await composer.getByLabel("Contains spoilers").check();
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await expect(start).toBeFocused();
  await start.click();
  await expect(composer.getByRole("textbox")).toHaveValue("Saved for later");
  await expect(composer.getByLabel("Contains spoilers")).toBeChecked();
  await owner.setViewportSize({ width: 320, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await owner.screenshot({
    path: ".cache/title-composer-mobile.png",
    fullPage: true,
  });
  await owner.setViewportSize({ width: 390, height: 844 });
  await composer.getByLabel("Contains spoilers").uncheck();
  for (const body of [
    "First independent thought",
    "Second independent thought",
  ]) {
    await composer.getByLabel("Your comment", { exact: true }).fill(body);
    await composer
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(owner.getByText(body, { exact: true })).toBeVisible();
    await expect(
      composer.getByLabel("Your comment", { exact: true }),
    ).toHaveValue("");
  }
  const first = owner
    .locator("[data-item-id]")
    .filter({ hasText: "First independent thought" });
  const id = await first.getAttribute("data-item-id");
  await owner.reload();
  await expect(owner.locator("[data-item-id]")).toHaveCount(2);
  await expect(
    owner.getByRole("button", { name: "Recommend to friends", exact: true }),
  ).toBeVisible();
  await expect(
    owner
      .locator(".title-hero")
      .getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  for (const [index, path] of [
    "/titles/movie/987654",
    "/",
    "/people/commentowner",
  ].entries()) {
    await reader.goto(path);
    await expect(
      reader.getByRole("button", { name: "Start a conversation", exact: true }),
    ).toHaveCount(index === 0 ? 1 : 0);
    await expect(
      reader.getByRole("form", { name: "New title comment" }),
    ).toHaveCount(0);
    const item = reader.locator(`[data-item-id="${id}"]`);
    await item.getByRole("button", { name: "Comment", exact: true }).click();
    await item
      .getByLabel("Add your reply")
      .fill(`Standalone reply from view ${index}`);
    await item.getByRole("button", { name: "Post reply", exact: true }).click();
    await expect(
      item
        .locator("[data-comment-id]")
        .getByText(`Standalone reply from view ${index}`, { exact: true }),
    ).toBeVisible();
    await reader.reload();
    await expect(item.locator("[data-comment-id]")).toHaveCount(index + 1);
    await expect(
      reader
        .locator("[data-item-id]")
        .filter({ hasText: "Second independent thought" })
        .locator("[data-comment-id]"),
    ).toHaveCount(0);
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await reader.screenshot({
      path: `.cache/standalone-view-${index}.png`,
      fullPage: true,
    });
  }
  // The same stored replies appear in every view after reload.
  for (const path of ["/titles/movie/987654", "/", "/people/commentowner"]) {
    await reader.goto(path);
    await expect(
      reader.locator(`[data-item-id="${id}"] [data-comment-id]`),
    ).toHaveCount(3);
  }
  await owner.goto("/titles/movie/987654");
  await first.getByRole("button", { name: "Comment", exact: true }).click();
  await first.getByLabel("Add your reply").fill("Fourth reply from the host");
  await first.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    first
      .locator("[data-comment-id]")
      .getByText("Fourth reply from the host", { exact: true }),
  ).toBeVisible();
  for (const path of ["/titles/movie/987654", "/", "/people/commentowner"]) {
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${id}"]`);
    await expect(item.locator("[data-comment-id]")).toHaveCount(3);
    await expect(
      item.getByText("Standalone reply from view 0", { exact: true }),
    ).toHaveCount(0);
    await item
      .getByRole("button", { name: "Show earlier comments (1)", exact: true })
      .click();
    await expect(item.locator("[data-comment-id]")).toHaveCount(4);
    await expect(
      item.getByText("Standalone reply from view 0", { exact: true }),
    ).toBeVisible();
  }
  await reader.goto("/people/commentreader");
  await expect(reader.locator("[data-item-id]")).toHaveCount(0);
  await expect(
    reader.getByRole("form", { name: "New title comment" }),
  ).toHaveCount(0);
  const denied = await outsider.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "No access", spoiler: false },
  });
  expect(denied.status()).toBe(404);
  await outsider.goto(`/titles/movie/987654?item=${id}`);
  await expect(
    outsider.getByText("First independent thought", { exact: true }),
  ).toHaveCount(0);
  await expect(
    outsider.getByText("This activity is unavailable.", { exact: true }),
  ).toBeVisible();
  await owner.goto("/titles/tv/987654");
  await owner
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("A show spoiler");
  await composer.getByLabel("Contains spoilers").check();
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(
    owner.getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    }),
  ).toBeVisible();
  await owner.reload();
  await owner
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  const spoilerItem = owner
    .locator("[data-item-id]")
    .filter({ hasText: "A show spoiler" });
  const spoilerId = await spoilerItem.getAttribute("data-item-id");
  await spoilerItem
    .getByRole("button", { name: "Comment", exact: true })
    .click();
  await spoilerItem
    .getByLabel("Add your reply")
    .fill("Thread inherits the spoiler flag");
  await spoilerItem
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    spoilerItem
      .locator("[data-comment-id]")
      .getByText("Thread inherits the spoiler flag", { exact: true }),
  ).toBeVisible();
  for (const path of [
    `/titles/tv/987654?item=${spoilerId}`,
    "/",
    "/people/commentowner",
  ]) {
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${spoilerId}"]`);
    await expect(item.getByText("A show spoiler", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      item.getByText("Thread inherits the spoiler flag", { exact: true }),
    ).toHaveCount(0);
    await item
      .getByRole("button", {
        name: "Contains spoilers · Reveal discussion",
        exact: true,
      })
      .click();
    await expect(
      item.getByText("A show spoiler", { exact: true }),
    ).toBeVisible();
    await expect(
      item.getByText("Thread inherits the spoiler flag", { exact: true }),
    ).toBeVisible();
  }
  await owner.context().close();
  await reader.context().close();
  await outsider.context().close();
});

test("standalone deletion preserves discussions across feeds, keeps spoilers hidden, and removes empty entries", async ({
  member,
}) => {
  test.setTimeout(150_000);
  const owner = await member("deleteowner");
  const reader = await member("deletereader");
  await prepareFriendship(owner, reader);
  const headers = { Origin: browserConfig.baseURL };
  const create = async (body: string, spoiler = false) => {
    const response = await owner.request.post("/api/screenr/title-comment", {
      headers,
      data: { title: "tv:987654", body, spoiler },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const reply = async (id: string, body: string) => {
    const response = await reader.request.post("/api/screenr/comment", {
      headers,
      data: { conversation: id, body, spoiler: false },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const item = (page: Page, id: string) =>
    page.locator(`[data-item-id="${id}"]`);
  const heading = (page: Page, id: string) =>
    page.locator(`[data-item-heading="${id}"]`);
  for (const [index, path] of [
    "/titles/tv/987654",
    "/",
    "/people/deleteowner",
  ].entries()) {
    const body = `Starting comment from view ${index}`;
    const id = await create(body);
    const replyId = await reply(id, `Retained reply ${index}`);
    await owner.goto(path);
    await reader.goto(`/titles/tv/987654?item=${id}`);
    await expect(
      heading(reader, id).getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await reader.request.post("/api/screenr/remove-comment", {
          headers,
          data: { id },
        })
      ).status(),
    ).toBe(404);
    const button = heading(owner, id).getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await expect(button).toBeVisible();
    if (index === 0) {
      await owner.route(
        "**/api/screenr/remove-comment",
        (route) =>
          route.fulfill({
            status: 503,
            json: { error: "Deletion failed. Please try again." },
          }),
        { times: 1 },
      );
      await button.click();
      await expect(heading(owner, id).getByRole("alert")).toHaveText(
        "Deletion failed. Please try again.",
      );
      await expect(
        heading(owner, id).getByText(body, { exact: true }),
      ).toBeVisible();
    }
    await button.click();
    for (const page of [owner, reader]) {
      await expect(
        heading(page, id).getByText("Comment removed", { exact: true }),
      ).toBeVisible();
      await expect(item(page, id).getByText(body, { exact: true })).toHaveCount(
        0,
      );
      await expect(
        item(page, id).getByText(`Retained reply ${index}`, { exact: true }),
      ).toBeVisible();
    }
    await expect(heading(owner, id).getByRole("alert")).toHaveCount(0);
    await expect(button).toHaveCount(0);
    await owner.reload();
    await expect(
      heading(owner, id).getByText("Comment removed", { exact: true }),
    ).toBeVisible();
    if (index === 0) {
      await item(reader, id)
        .getByRole("button", { name: "Comment", exact: true })
        .click();
      await item(reader, id)
        .getByLabel("Add your reply")
        .fill("Continue after deletion");
      await item(reader, id)
        .getByRole("button", { name: "Post reply", exact: true })
        .click();
      await expect(
        item(reader, id).getByText("Continue after deletion", { exact: true }),
      ).toBeVisible();
      await owner.screenshot({
        path: ".cache/deleted-standalone-mobile.png",
        fullPage: true,
      });
      expect(
        await owner.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(390);
    } else {
      await item(reader, id)
        .locator(`[data-comment-id="${replyId}"]`)
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(item(reader, id)).toHaveCount(0);
      await expect(item(owner, id)).toHaveCount(0);
    }
  }
  const spoilerId = await create("Remove this hidden spoiler", true);
  await reply(spoilerId, "Still protected by the discussion spoiler");
  for (const page of [owner, reader])
    await page.goto(`/titles/tv/987654?item=${spoilerId}`);
  await heading(owner, spoilerId)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    heading(reader, spoilerId).getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await expect(
    item(reader, spoilerId).getByText(
      "Still protected by the discussion spoiler",
      { exact: true },
    ),
  ).toHaveCount(0);
  await item(reader, spoilerId)
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  await expect(
    item(reader, spoilerId).getByText(
      "Still protected by the discussion spoiler",
      { exact: true },
    ),
  ).toBeVisible();
  await reader.reload();
  await expect(
    item(reader, spoilerId).getByText(
      "Still protected by the discussion spoiler",
      { exact: true },
    ),
  ).toHaveCount(0);

  const emptyId = await create("Remove this empty entry");
  for (const page of [owner, reader])
    await page.goto(`/titles/tv/987654?item=${emptyId}`);
  await heading(owner, emptyId)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  for (const page of [owner, reader]) {
    await expect(item(page, emptyId)).toHaveCount(0);
    await expect(
      page.getByText("This activity is unavailable.", { exact: true }),
    ).toBeVisible();
  }
  for (const path of [
    "/",
    "/people/deleteowner",
    `/titles/tv/987654?item=${emptyId}`,
  ]) {
    await owner.goto(path);
    await expect(item(owner, emptyId)).toHaveCount(0);
  }
  await owner.context().close();
  await reader.context().close();
});

test("standalone composition retains drafts through posting and refresh failures", async ({
  member,
}) => {
  const page = await member("commentdrafts");
  await page.goto("/titles/movie/987655");
  await page
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  const composer = page.getByRole("form", { name: "New title comment" });
  const input = composer.getByLabel("Your comment", { exact: true });
  const submit = composer.getByRole("button", {
    name: "Post comment",
    exact: true,
  });
  await input.fill("Keep my standalone draft");
  await composer.getByLabel("Contains spoilers").check();
  await page.route("**/api/screenr/title-comment", (route) =>
    route.fulfill({ status: 503, json: { error: "Posting unavailable" } }),
  );
  await submit.click();
  await expect(composer.getByRole("alert")).toHaveText("Posting unavailable");
  await expect(input).toHaveValue("Keep my standalone draft");
  await expect(composer.getByLabel("Contains spoilers")).toBeChecked();
  await page.route("**/api/screenr/screen?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Refresh unavailable" } }),
  );
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Refresh unavailable",
  );
  await expect(composer).toHaveCount(0);
  await page.unroute("**/api/screenr/screen?**");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(input).toHaveValue("Keep my standalone draft");
  await expect(composer.getByLabel("Contains spoilers")).toBeChecked();
  await page.unroute("**/api/screenr/title-comment");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/screenr/title-comment", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await submit.click();
  await input.fill("A later thought typed while saving");
  await composer.getByLabel("Contains spoilers").uncheck();
  release();
  await expect(submit).toBeEnabled();
  await expect(input).toHaveValue("A later thought typed while saving");
  await page.unroute("**/api/screenr/title-comment");
  await submit.click();
  await expect(
    page.getByText("A later thought typed while saving", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(page.locator("[data-item-id]")).toHaveCount(2);
  await page
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Keep my standalone draft", { exact: true }),
  ).toBeVisible();
  await page.context().close();
});

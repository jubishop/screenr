import { nextAccountRefreshForPath } from "./refresh-helpers";
import { expect } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { browserConfig } from "../../scripts/browser-config";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { befriend } from "./journey-helpers";

test("unified feeds show separate entries and support inline replies on title, friends, and profile", async ({
  member,
}) => {
  const owner = await member("feedowner");
  const reader = await member("feedreader");
  await prepareFriendship(owner, reader);
  await owner.goto("/titles/movie/987654");
  await owner
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  const separate = await owner.request.post("/api/screenr/title-comment", {
    headers: { Origin: browserConfig.baseURL },
    data: {
      title: "movie:987654",
      body: "A separate title discussion",
      spoiler: false,
    },
  });
  expect(separate.status()).toBe(200);
  const separateId = (await separate.json()).id as string;
  await expect(owner.getByLabel("Add your reply")).toHaveCount(0);
  await expect(
    owner
      .locator("[data-item-id]")
      .getByRole("button", { name: "Comment", exact: true }),
  ).toHaveCount(2);
  const recommendation = owner
    .locator("[data-item-id]")
    .filter({ hasText: "feedowner recommends" });
  const id = await recommendation.getAttribute("data-item-id");
  for (const path of ["/titles/movie/987654", "/", "/people/feedowner"]) {
    await reader.goto(path);
    const items = reader.locator("[data-item-id]");
    await expect(items).toHaveCount(2);
    await expect
      .soft(items.getByRole("heading", { name: "Conversation", exact: true }))
      .toHaveCount(0);
    await expect
      .soft(items.getByText("Be the first to reply.", { exact: true }))
      .toHaveCount(0);
    for (const width of [390, 1440]) {
      await reader.setViewportSize({ width, height: 900 });
      await expectTextContrast(items.getByText("recommends", { exact: true }));
      await expectTextContrast(items.first().locator(".activity-content time"));
      await expect(items.getByRole("textbox")).toHaveCount(0);
      for (const item of await items.all()) {
        const trigger = item.getByRole("button", {
          name: "Comment",
          exact: true,
        });
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await trigger.focus();
        await reader.keyboard.press("Enter");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const reply = item.getByLabel("Add your reply");
        await expect(reply).toBeFocused();
        const visibleLines = await reply.evaluate((element) => {
          const style = getComputedStyle(element);
          const contentHeight =
            element.clientHeight -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom);
          return contentHeight / parseFloat(style.lineHeight);
        });
        expect.soft(visibleLines).toBeCloseTo(3, 1);
        await reply.fill("Draft to keep after cancelling");
        await item.getByLabel("Contains spoilers").check();
        const cancel = item.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        await cancel.click();
        await expect(reply).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(reply).toHaveValue("Draft to keep after cancelling");
        await expect(item.getByLabel("Contains spoilers")).toBeChecked();
        await cancel.click();
      }
      if (path === "/titles/movie/987654")
        await reader.screenshot({
          path: `.cache/empty-conversation-${width}.png`,
          fullPage: true,
        });
    }
  }
  await reader.setViewportSize({ width: 390, height: 844 });
  for (const [index, path] of [
    "/titles/movie/987654",
    "/",
    "/people/feedowner",
  ].entries()) {
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${id}"]`);
    await item.getByRole("button", { name: "Comment", exact: true }).click();
    await item.getByLabel("Add your reply").fill(`Reply from surface ${index}`);
    await item.getByRole("button", { name: "Post reply", exact: true }).click();
    await expect(
      item.getByText(`Reply from surface ${index}`, { exact: true }),
    ).toBeVisible();
    await expect(
      item.getByRole("heading", { name: "Conversation", exact: true }),
    ).toBeVisible();
    await expect(
      item.getByText(`${index + 1} replies`, { exact: true }),
    ).toBeVisible();
    await reader.reload();
    await expect(
      item.getByText(`Reply from surface ${index}`, { exact: true }),
    ).toBeVisible();
    await expect(
      reader.locator(`[data-item-id="${separateId}"] [data-comment-id]`),
    ).toHaveCount(0);
  }
  for (const width of [1440, 390, 320]) {
    await reader.setViewportSize({ width, height: 900 });
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(
      reader.locator(`[data-item-id="${id}"] [data-comment-id]`),
    ).toHaveCount(3);
    const comment = reader
      .locator(`[data-item-id="${id}"] [data-comment-id]`)
      .first();
    await expectTextContrast(comment.getByText("@feedreader", { exact: true }));
    await expectTextContrast(comment.locator("time"));
  }
  await reader.evaluate(() => window.scrollTo(0, 0));
  await reader.screenshot({ path: ".cache/feed-phone.png", fullPage: true });
  await reader.setViewportSize({ width: 1440, height: 1000 });
  await reader.evaluate(() => window.scrollTo(0, 0));
  await reader.screenshot({ path: ".cache/feed-desktop.png", fullPage: true });
  await reader.context().close();
  await owner.context().close();
});

test("every feed holds incoming activity, preserves drafts and position, and expands reply links safely", async ({
  member,
}) => {
  const owner = await member("incomingowner");
  const reader = await member("incomingreader");
  await prepareFriendship(owner, reader);
  async function action(field: string, value: boolean) {
    const result = await owner.request.post("/api/screenr/activity", {
      headers: { Origin: browserConfig.baseURL },
      data: { title: "movie:987654", field, value },
    });
    expect(result.status()).toBe(200);
    return (await result.json()).id as string;
  }
  const id = await action("recommended", true);
  const replies: string[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await owner.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: {
        conversation: id,
        body: `Preview reply ${index}`,
        spoiler: index === 0,
      },
    });
    expect(response.status()).toBe(200);
    replies.push((await response.json()).id);
  }
  const saved = await action("want_to_watch", true);
  for (const [index, path] of [
    "/",
    "/titles/movie/987654",
    "/people/incomingowner",
  ].entries()) {
    await action("recommended", true);
    await action("want_to_watch", false);
    await action("want_to_watch", true);
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${id}"]`);
    const ids = () =>
      reader
        .locator("[data-item-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-item-id")),
        );
    expect(await ids()).toEqual([saved, id]);
    await expect(item.locator("[data-comment-id]")).toHaveCount(3);
    await expect(
      item.getByText("Preview reply 0", { exact: true }),
    ).toHaveCount(0);
    await item.getByRole("button", { name: /Show earlier comments/ }).click();
    await expect(item.locator("[data-comment-id]")).toHaveCount(5 + index);
    await expect(
      item.getByText("Preview reply 0", { exact: true }),
    ).toHaveCount(0);
    await item.getByRole("button", { name: "Comment", exact: true }).click();
    const draft = item.getByLabel("Add your reply");
    await draft.fill(`Draft on surface ${index}`);
    await item.getByLabel("Contains spoilers", { exact: true }).check();
    const added = await owner.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: {
        conversation: id,
        body: `Incoming on surface ${index}`,
        spoiler: false,
      },
    });
    expect(added.status()).toBe(200);
    await expect(
      reader.getByRole("button", { name: /New activity/ }),
    ).toBeVisible();
    await expect(
      item.getByText(`Incoming on surface ${index}`, { exact: true }),
    ).toHaveCount(0);
    expect(await ids()).toEqual([saved, id]);
    await action("recommended", false);
    await expect(
      item.getByText("removed their recommendation", { exact: true }),
    ).toBeVisible();
    expect(await ids()).toEqual([saved, id]);
    const anchor = item.getByText("Preview reply 3", { exact: true });
    await anchor.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    const before = (await anchor.boundingBox())!.y;
    await reader.getByRole("button", { name: /New activity/ }).click();
    await expect(
      item.getByText(`Incoming on surface ${index}`, { exact: true }),
    ).toBeVisible();
    expect(await ids()).toEqual([id, saved]);
    await expect
      .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
      .toBeLessThan(3);
    await expect(draft).toHaveValue(`Draft on surface ${index}`);
    await expect(
      item.getByLabel("Contains spoilers", { exact: true }),
    ).toBeChecked();
    await expect(
      item.getByText("Preview reply 0", { exact: true }),
    ).toHaveCount(0);
  }
  await reader.goto(`/titles/movie/987654?item=${id}&reply=${replies[0]}`);
  const target = reader.locator(`[data-comment-id="${replies[0]}"]`);
  await expect(target).toBeVisible();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toHaveCount(0);
  const bounds = (await target.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(
    (await reader.locator(".sidebar").boundingBox())!.height,
  );
  expect(bounds.y).toBeLessThan(844);
  await target.getByRole("button", { name: /Reveal comment/ }).click();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toBeVisible();
  await reader.reload();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toHaveCount(0);
  await reader.goto(`/conversations/${id}?reply=${replies[0]}`);
  await expect(reader).toHaveURL(new RegExp(`item=${id}&reply=${replies[0]}`));
  await expect(target).toBeVisible();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toHaveCount(0);
  await reader.context().close();
  await owner.context().close();
});

test("loading activity retains the visible three-reply preview and its reading anchor", async ({
  member,
}) => {
  const owner = await member("previewowner");
  const reader = await member("previewreader");
  await prepareFriendship(owner, reader);
  const activity = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await activity.json();
  async function reply(body: string) {
    const response = await owner.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: { conversation: id, body, spoiler: false },
    });
    expect(response.status()).toBe(200);
  }
  for (let index = 0; index < 3; index++) await reply(`Reading reply ${index}`);
  await reader.goto("/");
  await expect(reader.locator("[data-comment-id]")).toHaveCount(3);
  const anchor = reader.getByText("Reading reply 0", { exact: true });
  await anchor.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const beforeArrival = (await anchor.boundingBox())!.y;
  await reply("New reply after the preview");
  const incomingItem = await owner.request.post("/api/screenr/title-comment", {
    headers: { Origin: browserConfig.baseURL },
    data: {
      title: "movie:987654",
      body: "A newly started discussion",
      spoiler: false,
    },
  });
  expect(incomingItem.status()).toBe(200);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(reader.locator("[data-item-id]")).toHaveCount(1);
  expect(
    Math.abs((await anchor.boundingBox())!.y - beforeArrival),
  ).toBeLessThan(3);
  await anchor.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const before = (await anchor.boundingBox())!.y;
  await reader.getByRole("button", { name: /New activity/ }).click();
  await expect(anchor).toBeVisible();
  await expect(reader.locator("[data-item-id]")).toHaveCount(2);
  await expect(
    reader.getByText("New reply after the preview", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
    .toBeLessThan(3);
  await reader.reload();
  await expect(reader.locator("[data-comment-id]")).toHaveCount(3);
  await expect(anchor).toHaveCount(0);
  await reader.context().close();
  await owner.context().close();
});

test("slow and failed refreshes enforce access while preserving reply drafts", async ({
  member,
}) => {
  const page = await member("draftrefresh");
  const activity = await page.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await activity.json();
  await page.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: {
      conversation: id,
      body: "Visible conversation content",
      spoiler: false,
    },
  });
  await page.goto(`/conversations/${id}`);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const draft = page.getByLabel("Add your reply");
  const replySpoiler = page
    .getByRole("region", { name: "Conversation", exact: true })
    .getByLabel("Contains spoilers", { exact: true });
  await draft.fill("Keep this unsent reply");
  await replySpoiler.check();
  await page.route("**/api/screenr/screen?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Refresh unavailable." } }),
  );
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Refresh unavailable.",
  );
  await expect(
    page.getByText("Visible conversation content", { exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/screenr/screen?**");
  await expect(draft).toHaveValue("Keep this unsent reply");
  await expect(replySpoiler).toBeChecked();
  await page.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(draft).toHaveValue("");
  await page.getByRole("button", { name: /Reveal comment/ }).click();
  await expect(
    page.getByText("Keep this unsent reply", { exact: true }),
  ).toBeVisible();
  const invitation = await page.request.post("/api/screenr/invite", {
    headers: { Origin: browserConfig.baseURL },
    data: { limit: 1 },
  });
  const viewer = await member("slowviewer", {
    token: (await invitation.json()).token,
  });
  await page.goto("/people/slowviewer");
  await expect(
    page.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeVisible();
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByRole("button", { name: "Comment", exact: true }).click();
  await viewer.getByLabel("Add your reply").fill("Keep my slow-network draft");
  await viewer.route("**/api/screenr/screen?**", async (route) => {
    // Delay the real HTTP boundary beyond the polling interval. Application
    // authorization and database reads still determine the returned content.
    await delay(4000);
    await route.continue();
  });
  await page.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "A slow incoming reply", spoiler: false },
  });
  await expect(
    viewer.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: /New activity/ }).click();
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(viewer.getByRole("status")).toContainText(
    "This activity is unavailable.",
  );
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toHaveCount(0);
  await viewer.unrouteAll({ behavior: "wait" });
  await befriend(page, viewer, "slowviewer", "draftrefresh");
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByRole("button", { name: "Comment", exact: true }).click();
  await viewer.getByLabel("Add your reply").fill("Retain this timed-out draft");
  let requestStarted!: () => void;
  const delayedRequest = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await viewer.route("**/api/screenr/screen?**", async (route) => {
    requestStarted();
    await delay(15000);
    await route.continue();
  });
  await viewer.bringToFront();
  // Measure the refresh deadline from an actual intercepted request, not
  // from navigation or a background tab's next polling opportunity.
  await delayedRequest;
  await expect(viewer.getByRole("main").getByRole("alert")).toContainText(
    "Refresh timed out. Please try again.",
    { timeout: 12000 },
  );
  await expect(
    viewer.getByText("Visible conversation content", { exact: true }),
  ).toHaveCount(0);
  await viewer.unrouteAll({ behavior: "wait" });
  await expect(viewer.getByLabel("Add your reply")).toHaveValue(
    "Retain this timed-out draft",
  );
  await viewer.context().close();
  await page.context().close();
});

test("posting preserves later typing and background refresh preserves action errors", async ({
  member,
}) => {
  const page = await member("draftposting");
  const response = await page.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await response.json();
  await page.goto(`/conversations/${id}`);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const draft = page.getByLabel("Add your reply");
  await draft.fill("First submitted reply");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/screenr/comment",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.getByRole("button", { name: "Post reply", exact: true }).click();
    await draft.fill("Second unsent reply");
  } finally {
    release();
  }
  await expect(
    page.getByText("First submitted reply", { exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue("Second unsent reply");
  await page.goto("/search");
  await page.route("**/api/screenr/search?**", (route) =>
    route.fulfill({
      status: 502,
      json: { error: "Catalog temporarily unavailable." },
    }),
  );
  await page.getByLabel("Movie or show title").fill("Lantern");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("Catalog temporarily unavailable.");
  await nextAccountRefreshForPath(page, "/search");
  await expect(alert).toContainText("Catalog temporarily unavailable.");
  await page.unroute("**/api/screenr/search?**");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await page.context().close();
});

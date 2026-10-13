import { nextAccountRefreshForPath } from "./refresh-helpers";
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { confirmProfileAction } from "./journey-helpers";
import { expectErrorBeside, failAction, press } from "./action-errors";

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
      item.getByText(index === 0 ? "1 reply" : `${index + 1} replies`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      item.getByRole("heading", { name: "Conversation", exact: true }),
    ).toHaveCount(0);
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

test("feed entries lay out actions in full-width rows with an icon copy link and a reply count", async ({
  member,
}) => {
  const owner = await member("actionsowner");
  const reader = await member("actionsreader");
  await prepareFriendship(owner, reader);
  await reader
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"]);
  const post = async (page: Page, action: string, data: object) => {
    const response = await page.request.post(`/api/screenr/${action}`, {
      headers: { Origin: browserConfig.baseURL },
      data,
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const id = await post(owner, "activity", {
    title: "movie:987654",
    field: "recommended",
    value: true,
  });
  const parent = await post(owner, "comment", {
    conversation: id,
    body: "Worth a weekend",
    spoiler: false,
  });
  const nested = await post(reader, "comment", {
    conversation: id,
    body: "Agreed",
    spoiler: false,
    replyTo: parent,
  });
  await post(reader, "reaction", { item: id, kind: "like" });
  await post(reader, "reaction", { item: id, reply: parent, kind: "love" });
  await post(owner, "reaction", { item: id, reply: nested, kind: "haha" });
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const center = (bounds: { y: number; height: number }) =>
    bounds.y + bounds.height / 2;
  // Count distinct visual lines by vertical center, allowing subpixel rounding.
  const lines = (boxes: { y: number; height: number }[]) =>
    boxes
      .map(center)
      .sort((a, b) => a - b)
      .filter((value, index, all) => index === 0 || value - all[index - 1] > 3)
      .length;
  const entry = reader.locator(`[data-item-id="${id}"]`);
  const header = reader.locator(`[data-item-heading="${id}"]`);
  const want = header.getByRole("button", {
    name: "+ Want to watch",
    exact: true,
  });
  const recommend = header.getByRole("button", {
    name: "+ Recommend",
    exact: true,
  });
  const copy = header.getByRole("button", {
    name: "Copy link to discussion",
    exact: true,
  });
  const like = header.getByRole("button", { name: "Like: 1", exact: true });
  const react = header.getByRole("button", { name: "React", exact: true });
  const copiedURL = async () => {
    const copied = new URL(
      await reader.evaluate(() => navigator.clipboard.readText()),
    );
    expect(copied.origin).toBe(browserConfig.baseURL);
    expect(copied.pathname + copied.search).toBe(
      `/titles/movie/987654?item=${id}`,
    );
  };
  // Title page entries are compact and checked below.
  for (const path of ["/", "/people/actionsowner"]) {
    await reader.goto(path);
    await expect(want).toBeEnabled();
    await entry
      .getByRole("button", { name: "View 1 reply", exact: true })
      .click();
    for (const width of [390, 1366]) {
      await reader.setViewportSize({ width, height: 844 });
      const poster = await box(header.locator(".poster-link"));
      const actions = await Promise.all(
        [want, recommend, copy, like, react].map(box),
      );
      const [wantBox, recommendBox, copyBox, likeBox, reactBox] = actions;
      // Actions sit beneath the poster block and start at the card's edge.
      for (const action of actions)
        expect(action.y).toBeGreaterThanOrEqual(poster.y + poster.height);
      expect(Math.abs(wantBox.x - poster.x)).toBeLessThanOrEqual(1);
      expect(lines(actions)).toBe(width === 390 ? 2 : 1);
      expect(lines([wantBox, recommendBox, copyBox])).toBe(1);
      expect(copyBox.x).toBeGreaterThan(recommendBox.x);
      expect(lines([likeBox, reactBox])).toBe(1);
      expect(center(likeBox)).toBeGreaterThanOrEqual(center(wantBox));
      // No empty status line is reserved beneath the actions.
      const card = await box(header);
      const padding = await header.evaluate((element) =>
        parseFloat(getComputedStyle(element).paddingBottom),
      );
      expect(
        card.y +
          card.height -
          Math.max(...actions.map((action) => action.y + action.height)),
      ).toBeLessThanOrEqual(padding + 1);
      for (const [comment, names] of [
        [parent, ["Reply", "Love: 1", "React"]],
        [nested, ["Reply", "Delete", "Haha: 1", "React"]],
      ] as const) {
        const scope = entry.locator(`[data-comment-id="${comment}"]`);
        const controls = await Promise.all(
          names.map((name) =>
            box(scope.getByRole("button", { name, exact: true })),
          ),
        );
        expect(lines(controls)).toBe(1);
      }
      await expect(entry.getByText("2 replies", { exact: true })).toBeVisible();
      await expectTextContrast(entry.getByText("2 replies", { exact: true }));
      await expect(
        entry.getByRole("heading", { name: "Conversation" }),
      ).toHaveCount(0);
      await expect(
        entry.getByRole("region", { name: "Conversation", exact: true }),
      ).toBeVisible();
      await reader.evaluate(() => window.scrollTo(0, 0));
      await reader.screenshot({
        path: `.cache/feed-actions-${width}${path.replaceAll("/", "-")}.png`,
        fullPage: true,
      });
    }
  }
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(copy).toHaveAttribute("title", "Copy link to discussion");
  await expect(copy).toHaveText("");
  await expect(copy.locator("svg")).toHaveCount(1);
  // Keyboard order follows the visual order of both rows.
  await want.focus();
  for (const next of [recommend, copy, like, react]) {
    await reader.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  await copy.focus();
  await reader.keyboard.press("Enter");
  const status = header.getByRole("status");
  await expect(status).toHaveText("Link copied.");
  await expect(copy).toBeFocused();
  await expect(reader).toHaveURL(/\/people\/actionsowner$/);
  await copiedURL();
  const statusBox = await box(status);
  const copyBox = await box(copy);
  expect(statusBox.x).toBeGreaterThanOrEqual(copyBox.x + copyBox.width);
  expect(lines([statusBox, copyBox])).toBe(1);

  // On the title page, the copy link ends the compact entry's author line
  // and the reactions keep one row, with no space reserved beneath it.
  await reader.goto("/titles/movie/987654");
  const author = header.getByRole("link", {
    name: "actionsowner",
    exact: true,
  });
  await expect(want).toHaveCount(0);
  await entry
    .getByRole("button", { name: "View 1 reply", exact: true })
    .click();
  for (const width of [390, 1366]) {
    await reader.setViewportSize({ width, height: 844 });
    const [authorBox, copyBox, likeBox, reactBox] = await Promise.all(
      [author, copy, like, react].map(box),
    );
    expect(center(copyBox)).toBeGreaterThan(authorBox.y);
    expect(center(copyBox)).toBeLessThan(authorBox.y + authorBox.height);
    expect(copyBox.x).toBeGreaterThan(authorBox.x + authorBox.width);
    expect(lines([likeBox, reactBox])).toBe(1);
    expect(likeBox.y).toBeGreaterThanOrEqual(authorBox.y + authorBox.height);
    const card = await box(header);
    const padding = await header.evaluate((element) =>
      parseFloat(getComputedStyle(element).paddingBottom),
    );
    expect(
      card.y +
        card.height -
        Math.max(likeBox.y + likeBox.height, reactBox.y + reactBox.height),
    ).toBeLessThanOrEqual(padding + 1);
  }
  await reader.setViewportSize({ width: 390, height: 844 });
  await author.focus();
  for (const next of [copy, like, react]) {
    await reader.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  await reader.evaluate(() => navigator.clipboard.writeText(""));
  await copy.focus();
  await reader.keyboard.press("Enter");
  await expect(status).toHaveText("Link copied.");
  await expect(copy).toBeFocused();
  await expect(reader).toHaveURL(/\/titles\/movie\/987654$/);
  await copiedURL();
  // The status shares the author line, just before the icon.
  const compactStatus = await box(status);
  const compactCopy = await box(copy);
  expect(compactStatus.x + compactStatus.width).toBeLessThanOrEqual(
    compactCopy.x,
  );
  expect(center(compactStatus)).toBeGreaterThan(compactCopy.y);
  expect(center(compactStatus)).toBeLessThan(
    compactCopy.y + compactCopy.height,
  );
  // The reaction picker opens beneath the whole comment line.
  const reply = entry.locator(`[data-comment-id="${nested}"]`);
  const trigger = reply.getByRole("button", { name: "React", exact: true });
  await trigger.click();
  const picker = reply.getByRole("group", {
    name: "Choose a reaction",
    exact: true,
  });
  const pickerBox = await box(picker);
  const replyBox = await box(
    reply.getByRole("button", { name: "Reply", exact: true }),
  );
  expect(Math.abs(pickerBox.x - replyBox.x)).toBeLessThanOrEqual(1);
  expect(pickerBox.y).toBeGreaterThan(replyBox.y + replyBox.height);
  await reader.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("a failed entry, comment, or title action shows its error beside that control", async ({
  member,
}) => {
  const owner = await member("erroractionowner");
  const reader = await member("erroractionreader");
  await prepareFriendship(owner, reader);
  const post = async (page: Page, action: string, data: object) => {
    const response = await page.request.post(`/api/screenr/${action}`, {
      headers: { Origin: browserConfig.baseURL },
      data,
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const [id, otherId] = [
    await post(owner, "activity", {
      title: "movie:987654",
      field: "recommended",
      value: true,
    }),
    await post(owner, "activity", {
      title: "movie:987655",
      field: "recommended",
      value: true,
    }),
  ];
  const ownComment = await post(reader, "comment", {
    conversation: otherId,
    body: "A reply to remove",
    spoiler: false,
  });
  const header = reader.locator(`[data-item-heading="${id}"]`);
  const otherHeader = reader.locator(`[data-item-heading="${otherId}"]`);
  const want = header.getByRole("button", {
    name: "+ Want to watch",
    exact: true,
  });
  const recommend = header.getByRole("button", {
    name: "+ Recommend",
    exact: true,
  });
  const react = header.getByRole("button", { name: "React", exact: true });
  const message = "Could not save. Please try again.";
  await reader.goto("/");
  await expect(want).toBeEnabled();
  await failAction(reader, "activity", message);
  await press(want);
  for (const width of [390, 1366]) {
    await reader.setViewportSize({ width, height: 844 });
    await expectErrorBeside(reader, {
      container: header,
      failed: want,
      controls: [want, recommend, react],
      message,
      screenshot: "action-error-entry",
    });
    await expect(recommend).toHaveAccessibleDescription("");
  }
  await expect(otherHeader.getByRole("alert")).toHaveCount(0);
  await expect(
    otherHeader.getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeEnabled();
  // Refreshes keep the message; the entry's next action replaces it.
  await nextAccountRefreshForPath(reader, "/");
  await expect(header.getByRole("alert")).toHaveText(message);
  await reader.unroute("**/api/screenr/activity");
  await press(recommend);
  await expect(
    header.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
  await expect(header.getByRole("alert")).toHaveCount(0);
  await expect(want).toHaveAccessibleDescription("");

  // A comment's removal error stays in its confirmation, inside the comment.
  const comment = reader.locator(`[data-comment-id="${ownComment}"]`);
  const confirmation = comment.getByRole("group", {
    name: /^Delete this comment\?/,
  });
  const remove = confirmation.getByRole("button", {
    name: "Delete",
    exact: true,
  });
  await failAction(reader, "remove-comment", "Removal unavailable.");
  await press(comment.getByRole("button", { name: "Delete", exact: true }));
  await press(remove);
  for (const width of [390, 1366]) {
    await reader.setViewportSize({ width, height: 844 });
    await expect(comment).toContainText(
      "Delete this comment? Its text will be erased.",
    );
    await expectErrorBeside(reader, {
      container: confirmation,
      failed: remove,
      controls: [
        remove,
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ],
      message: "Removal unavailable.",
      screenshot: "action-error-comment",
    });
  }
  await reader.unroute("**/api/screenr/remove-comment");
  await press(remove);
  await expect(
    reader.getByText("A reply to remove", { exact: true }),
  ).toHaveCount(0);
  await expect(reader.getByRole("main").getByRole("alert")).toHaveCount(0);

  // The title page header shows its own actions' errors beneath them.
  await reader.goto("/titles/movie/987655");
  const hero = reader.locator(".title-hero");
  const titleWant = hero.getByRole("button", {
    name: "+ Want to watch",
    exact: true,
  });
  const titleRecommend = hero.getByRole("button", {
    name: "Recommend to friends",
    exact: true,
  });
  await expect(titleWant).toBeEnabled();
  await failAction(reader, "watch-status", message);
  await press(titleWant);
  await reader
    .getByRole("menuitemradio", { name: "Want to watch", exact: true })
    .click();
  for (const width of [390, 1366]) {
    await reader.setViewportSize({ width, height: 844 });
    await expectErrorBeside(reader, {
      container: hero,
      failed: titleWant,
      controls: [titleRecommend, titleWant],
      message,
      screenshot: "action-error-title",
    });
  }
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
    page.getByRole("link", { name: "Watch together", exact: true }),
  ).toBeVisible();
  // Paused timers poll only when the test advances the viewer's clock, and
  // each read of the conversation's title page waits until the test
  // continues it. A read can then stay pending past the 3-second polling
  // interval or the 10-second refresh deadline without real waiting.
  // Application authorization and database reads still determine the
  // returned content. The page load brings the first screen, so the first
  // read is the first poll.
  await viewer.clock.install();
  await viewer.clock.pauseAt(Date.now() + 1000);
  const conversationRead = (url: URL) =>
    url.pathname === "/api/screenr/screen" &&
    url.searchParams.get("path") === `/titles/movie/987654?item=${id}`;
  const reads: Route[] = [];
  await viewer.route(conversationRead, (route) => {
    reads.push(route);
  });
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByRole("button", { name: "Comment", exact: true }).click();
  await viewer.getByLabel("Add your reply").fill("Keep my slow-network draft");
  await viewer.clock.runFor(3000);
  await expect.poll(() => reads.length).toBe(1);
  await page.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "A slow incoming reply", spoiler: false },
  });
  // Two polls come due while the first read is pending. A poll that replaced
  // it would leave its own read held, so New activity would never appear.
  await viewer.clock.runFor(6000);
  await reads[0].continue();
  await expect(
    viewer.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: /New activity/ }).click();
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toBeVisible();
  await confirmProfileAction(page, "Unfriend");
  await expect(
    page.getByRole("button", { name: "Send friend request", exact: true }),
  ).toBeVisible();
  // The next poll reads after the unfriend, and another poll comes due
  // before that read returns.
  await viewer.clock.runFor(3000);
  await expect.poll(() => reads.length).toBe(2);
  await viewer.clock.runFor(3000);
  await reads[1].continue();
  await expect(viewer.getByRole("status")).toContainText(
    "This activity is unavailable.",
  );
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toHaveCount(0);
  await prepareFriendship(page, viewer);
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByRole("button", { name: "Comment", exact: true }).click();
  await viewer.getByLabel("Add your reply").fill("Retain this timed-out draft");
  await viewer.clock.runFor(3000);
  await expect.poll(() => reads.length).toBe(3);
  // The deadline counts from the held read, which started with the first
  // poll on the paused clock.
  await viewer.clock.runFor(10_000);
  await expect(viewer.getByRole("main").getByRole("alert")).toContainText(
    "Refresh timed out. Please try again.",
  );
  await expect(
    viewer.getByText("Visible conversation content", { exact: true }),
  ).toHaveCount(0);
  await reads[2].continue();
  await viewer.unroute(conversationRead);
  await viewer.clock.runFor(3000);
  await expect(
    viewer.getByText("Visible conversation content", { exact: true }),
  ).toBeVisible();
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

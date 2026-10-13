import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { browserConfig } from "../../scripts/browser-config";
import { openWithoutPolling } from "./refresh-helpers";

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status()).toBe(200);
  return response.json();
}
const bell = (page: Page) =>
  page.getByRole("button", { name: /^Notifications/ });

test("desktop dropdown and mobile panel preserve drafts, scroll, and unread state with keyboard dismissal", async ({
  member,
}) => {
  const owner = await member("panelowner");
  const reader = await member("panelreader");
  await prepareFriendship(owner, reader);
  const { id } = await post(owner, "activity", {
    title: "tv:987657",
    field: "recommended",
    value: true,
  });
  for (let i = 0; i < 5; i++)
    await post(reader, "comment", {
      conversation: id,
      body: `Panel comment ${i}`,
      spoiler: false,
    });
  await owner.goto("/titles/tv/987657");
  const item = owner.locator(`[data-item-id="${id}"]`);
  await item.getByRole("button", { name: "Comment", exact: true }).click();
  const draft = item.getByLabel("Add your reply");
  await draft.fill("Keep my unfinished comment.");
  const originalURL = owner.url();
  for (const width of [1440, 390, 320]) {
    await owner.setViewportSize({ width, height: 844 });
    await draft.scrollIntoViewIfNeeded();
    const scroll = await owner.evaluate(() => window.scrollY);
    await bell(owner).click();
    const panel = owner.getByRole("dialog", { name: "Notifications" });
    await expect(
      panel.getByRole("button", { name: /Panelreader|panelreader/ }).first(),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "All", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "All", exact: true }).click();
    await expect(panel.locator(".notification-item")).toHaveCount(6);
    // Notifications share the feed's relative times, with the full date on hover.
    const time = panel.locator(".notification-item time").first();
    await expect(time).toHaveText(/^(now|\d+m)$/);
    await expect(time).toHaveAttribute(
      "title",
      /^\w{3} \d+, \d{4}, \d+:\d{2} [AP]M$/,
    );
    const rect = await panel.boundingBox();
    expect(rect!.width).toBe(width <= 560 ? width : 420);
    if (width <= 560) {
      expect(rect!.height).toBe(844);
      expect(rect!.x).toBe(0);
      expect(rect!.y).toBe(0);
    }
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await owner.screenshot({ path: `.cache/notifications-${width}.png` });
    if (width === 1440) await owner.keyboard.press("Escape");
    else
      await panel.getByRole("button", { name: "Close notifications" }).click();
    await expect(panel).not.toBeVisible();
    await expect(bell(owner)).toBeFocused();
    await expect(bell(owner)).toHaveAccessibleName("Notifications, 6 unread");
    expect(owner.url()).toBe(originalURL);
    expect(await owner.evaluate(() => window.scrollY)).toBe(scroll);
    await expect(draft).toHaveValue("Keep my unfinished comment.");
  }
  await owner.setViewportSize({ width: 1440, height: 844 });
  await bell(owner).click();
  await owner.mouse.click(1000, 100);
  await expect(owner.getByRole("dialog")).not.toBeVisible();
  await expect(draft).toHaveValue("Keep my unfinished comment.");
});

test("notification selection opens the exact older reply, with read filters and mark all", async ({
  member,
}) => {
  const owner = await member("noticeowner");
  const reader = await member("noticereader");
  await prepareFriendship(owner, reader);
  const { id } = await post(owner, "activity", {
    title: "tv:987657",
    field: "recommended",
    value: true,
  });
  const first = await post(reader, "comment", {
    conversation: id,
    body: "Notification target outside initial preview",
    spoiler: false,
  });
  for (let i = 0; i < 5; i++)
    await post(reader, "comment", {
      conversation: id,
      body: `Later reply ${i}`,
      spoiler: false,
    });
  await owner.goto("/");
  await bell(owner).click();
  let panel = owner.getByRole("dialog");
  await expect(panel.locator(".notification-item")).toHaveCount(7);
  await panel
    .getByRole("button", { name: /noticereader commented/ })
    .last()
    .click();
  await expect(owner).toHaveURL(
    `${browserConfig.baseURL}/titles/tv/987657?item=${id}&reply=${first.id}`,
  );
  await expect(owner.locator(`[data-comment-id="${first.id}"]`)).toBeVisible();
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 6 unread");
  await owner.evaluate(() => window.scrollTo(0, 0));
  await expect(
    owner.locator(`[data-comment-id="${first.id}"]`),
  ).not.toBeInViewport();
  await bell(owner).click();
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: /noticereader commented/ })
    .last()
    .click();
  await expect(
    owner.locator(`[data-comment-id="${first.id}"]`),
  ).toBeInViewport();
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 6 unread");
  await bell(owner).click();
  panel = owner.getByRole("dialog");
  await panel.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(panel.locator(".notification-item")).toHaveCount(6);
  await panel.getByRole("button", { name: "Mark all as read" }).click();
  await expect(panel.getByText("You're all caught up.")).toBeVisible();
  await panel.getByRole("button", { name: "Close notifications" }).click();
  await expect(bell(owner)).toHaveAccessibleName("Notifications");
  await owner.reload();
  await expect(bell(owner)).toHaveAccessibleName("Notifications");
});

test("open panel removes blocked activity, recovers from failed reads, and activity-email settings persist", async ({
  member,
}) => {
  const owner = await member("noticeprivacy");
  const reader = await member("noticeblocked");
  await prepareFriendship(owner, reader);
  const session = await (
    await reader.request.get("/api/auth/get-session")
  ).json();
  // A poll could clear the panel's failure before Try again is clicked.
  await openWithoutPolling(owner, "/account");
  const setting = owner.getByRole("checkbox", {
    name: "Email me about new activity",
  });
  await expect(setting).not.toBeChecked();
  const failure = owner
    .getByRole("region", { name: "Activity emails" })
    .getByRole("alert");
  // The checkbox shows the choice while it saves, and a failed save
  // restores the saved setting.
  const hold = async (fail: boolean) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await owner.route(
      "**/api/screenr/activity-email",
      async (route) => {
        await gate;
        if (fail) await route.abort("failed");
        else await route.continue();
      },
      { times: 1 },
    );
    return release;
  };
  let release = await hold(true);
  await setting.click();
  await expect(setting).toHaveAttribute("aria-disabled", "true");
  await expect(setting).toBeChecked();
  release();
  await expect(failure).toBeVisible();
  await expect(setting).not.toBeChecked();
  release = await hold(false);
  await setting.click();
  await expect(setting).toHaveAttribute("aria-disabled", "true");
  await expect(setting).toBeChecked();
  await expect(failure).toHaveCount(0);
  release();
  await expect(setting).toHaveAttribute("aria-disabled", "false");
  await expect(setting).toBeChecked();
  await expect(setting).toBeEnabled();
  await owner.reload();
  await expect(setting).toBeChecked();
  await owner.route(
    "**/api/screenr/notifications?**",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await bell(owner).click();
  const panel = owner.getByRole("dialog");
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(
    panel.getByText("noticeblocked became your friend."),
  ).toBeVisible();
  await post(owner, "relationship", {
    target: session.user.id,
    action: "block",
  });
  // The open panel's next poll removes the blocked activity.
  await owner.clock.runFor(3000);
  await expect(panel.getByText("No notifications yet.")).toBeVisible();
  await expect(panel.getByText(/noticeblocked/)).toHaveCount(0);
});

test("mark all on a polled older page preserves new arrivals until Latest is displayed", async ({
  member,
}) => {
  const owner = await member("olderowner");
  const reader = await member("olderreader");
  await prepareFriendship(owner, reader);
  const { id } = await post(owner, "activity", {
    title: "tv:987657",
    field: "recommended",
    value: true,
  });
  for (let i = 0; i < 34; i++)
    await post(reader, "comment", {
      conversation: id,
      body: `Older notification ${i}`,
      spoiler: false,
    });
  await owner.goto("/");
  await bell(owner).click();
  const panel = owner.getByRole("dialog");
  await panel.getByRole("button", { name: "Earlier notifications" }).click();
  await expect(panel.locator(".notification-item")).toHaveCount(5);
  await post(reader, "comment", {
    conversation: id,
    body: "A new arrival while browsing an older page",
    spoiler: false,
  });
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 36 unread");
  await panel.getByRole("button", { name: "Mark all as read" }).click();
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 1 unread");
  await expect(
    panel.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Latest notifications" }).click();
  await expect(
    panel.getByRole("img", { name: "Unread", exact: true }),
  ).toHaveCount(1);
  await panel.getByRole("button", { name: "Mark all as read" }).click();
  await expect(bell(owner)).toHaveAccessibleName("Notifications");
});

test("pending friend-request notifications accept or confirm Decline in the panel by keyboard", async ({
  member,
}) => {
  const owner = await member("requestowner");
  const maya = await member("requestmaya", { displayName: "Maya Chen" });
  const sam = await member("requestsam", { displayName: "Sam Okafor" });
  const ownerId = (
    await (await owner.request.get("/api/auth/get-session")).json()
  ).user.id;
  for (const requester of [maya, sam])
    await post(requester, "relationship", {
      target: ownerId,
      action: "request",
    });
  await owner.goto("/people");
  const requests = owner.getByRole("region", { name: "Requests", exact: true });
  await expect(requests.getByRole("article")).toHaveCount(2);
  await bell(owner).click();
  const panel = owner.getByRole("dialog", { name: "Notifications" });
  const item = (text: string) =>
    panel.locator(".notification-item").filter({ hasText: text });
  const mayaItem = item("Maya Chen sent you a friend request.");
  const samItem = item("Sam Okafor sent you a friend request.");
  for (const request of [mayaItem, samItem])
    await expect(
      request.getByRole("button", { name: /^(Accept|Decline)$/ }),
    ).toHaveText(["Accept", "Decline"]);
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 2 unread");
  for (const width of [390, 1440]) {
    await owner.setViewportSize({ width, height: 844 });
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await owner.screenshot({
      path: `.cache/notification-requests-${width}.png`,
    });
  }

  // Accept by keyboard: the result replaces the buttons and takes focus.
  await mayaItem.getByRole("button", { name: "Accept", exact: true }).focus();
  await owner.keyboard.press("Enter");
  const accepted = mayaItem.getByText("Friend request accepted.", {
    exact: true,
  });
  await expect(accepted).toBeFocused();
  await expect(
    mayaItem.getByRole("button", { name: /^(Accept|Decline)$/ }),
  ).toHaveCount(0);
  await expect(mayaItem.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 1 unread");
  await expect(requests.getByRole("article")).toHaveCount(1);
  // The answered request stays with its result through the panel's polling.
  await owner.waitForResponse((response) =>
    response.url().includes("/api/screenr/notifications?"),
  );
  await expect(accepted).toBeVisible();

  // Decline asks first; Cancel returns to Decline with the request intact.
  const decline = samItem.getByRole("button", { name: "Decline", exact: true });
  await decline.click();
  const confirm = samItem.getByRole("group", {
    name: "Decline Sam Okafor’s friend request? The request will be removed.",
    exact: true,
  });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(confirm).toHaveCount(0);
  await expect(decline).toBeFocused();
  await expect(bell(owner)).toHaveAccessibleName("Notifications, 1 unread");
  await owner.keyboard.press("Enter");
  await owner.keyboard.press("Shift+Tab");
  await expect(
    confirm.getByRole("button", { name: "Decline", exact: true }),
  ).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(
    samItem.getByText("Friend request declined.", { exact: true }),
  ).toBeFocused();
  await expect(bell(owner)).toHaveAccessibleName("Notifications");
  await expect(requests).toHaveCount(0);

  // Selecting the rest of an answered notification still opens the person.
  await mayaItem
    .getByRole("button", { name: /Maya Chen sent you a friend request/ })
    .click();
  await expect(owner).toHaveURL(/\/people\/requestmaya$/);
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toBeVisible();
  await sam.goto("/people/requestowner");
  await expect(
    sam.getByRole("button", { name: "Send friend request", exact: true }),
  ).toBeVisible();
  // Reopened, the panel lists neither answered request.
  await bell(owner).click();
  await expect(panel.getByText("No notifications yet.")).toBeVisible();
});

import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";
import { browserConfig } from "../../scripts/browser-config";

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
  await owner.goto("/account");
  const setting = owner.getByRole("checkbox", {
    name: "Email me about new activity",
  });
  await expect(setting).not.toBeChecked();
  await owner.route(
    "**/api/screenr/activity-email",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await setting.click();
  await expect(
    owner.getByRole("region", { name: "Activity emails" }).getByRole("alert"),
  ).toBeVisible();
  await expect(setting).not.toBeChecked();
  await setting.click();
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

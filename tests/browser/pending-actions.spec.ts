import { expect, type Locator, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status()).toBe(200);
  return (await response.json()).id as string;
}

async function userId(page: Page) {
  const response = await page.request.get("/api/auth/get-session");
  return (await response.json()).user.id as string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

// Activate a control from the keyboard while its write is held. It keeps
// focus, reports itself unavailable, and ignores repeated Enter and Space
// presses. The write then completes, or fails with `fail`. The returned
// `pressed` locator follows the same element through label changes. A menu
// button opens with `key`, and `choose` picks the menu item that writes.
// Chromium leaves focus on a control that becomes disabled, but other
// browsers can move it to the page, so the pending control stays focusable:
// never `disabled`, but `aria-disabled`, or read-only for a text field.
async function pressWhilePending(
  page: Page,
  control: Locator,
  action: string,
  {
    key = "Enter",
    fail,
    screenshot,
    choose,
  }: { key?: string; fail?: string; screenshot?: string; choose?: string } = {},
) {
  const started = deferred();
  const gate = deferred();
  const handled = deferred();
  let requests = 0;
  const url = `**/api/screenr/${action}`;
  await page.route(url, async (route) => {
    requests++;
    started.resolve();
    await gate.promise;
    if (fail) await route.fulfill({ status: 503, json: { error: fail } });
    else await route.continue();
    handled.resolve();
  });
  await control.evaluate((element) => {
    document.querySelector("[data-pressed]")?.removeAttribute("data-pressed");
    element.setAttribute("data-pressed", "");
    element.scrollIntoView({ block: "center" });
  });
  const pressed = page.locator("[data-pressed]");
  await control.focus();
  await page.keyboard.press(key);
  if (choose)
    await page
      .getByRole("menuitemradio", { name: choose, exact: true })
      .press("Enter");
  await started.promise;
  await expect(pressed).toBeFocused();
  await expect(pressed).not.toHaveAttribute("disabled");
  if (await pressed.evaluate((element) => element.matches("input:not([type])")))
    await expect(pressed).not.toBeEditable();
  else await expect(pressed).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.press(" ");
  await expect(pressed).toBeFocused();
  if (screenshot) {
    const { width } = page.viewportSize()!;
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.cache/${screenshot}-${width}.png` });
  }
  gate.resolve();
  await handled.promise;
  await page.unroute(url);
  return { pressed, requests: () => requests };
}

test("feed entry and title actions keep keyboard focus while their writes are pending", async ({
  member,
}) => {
  const owner = await member("pendingfeedowner");
  const reader = await member("pendingfeedreader");
  await prepareFriendship(owner, reader);
  const id = await post(owner, "activity", {
    title: "movie:987654",
    field: "recommended",
    value: true,
  });
  const own = await post(reader, "title-comment", {
    title: "movie:987655",
    body: "A comment to delete",
    spoiler: false,
  });
  await reader.goto("/");
  const header = reader.locator(`[data-item-heading="${id}"]`);
  const want = header.getByRole("button", { name: /Want to watch$/ });
  const recommend = header.getByRole("button", { name: /Recommend(ed)?$/ });
  await expect(want).toHaveText("+ Want to watch");
  let pending = await pressWhilePending(reader, want, "activity", {
    screenshot: "pending-entry",
  });
  await expect(want).toHaveText("✓ Want to watch");
  await expect(want).toHaveAttribute("aria-disabled", "false");
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);

  await reader.setViewportSize({ width: 1366, height: 844 });
  pending = await pressWhilePending(reader, recommend, "activity", {
    screenshot: "pending-entry",
  });
  await expect(recommend).toHaveText("✓ Recommended");
  await expect(want).toHaveText("+ Want to watch");
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);

  // Delete keeps focus while pending and after a failure, with its message.
  const mine = reader.locator(`[data-item-heading="${own}"]`);
  const remove = mine.getByRole("button", { name: /^(Delete|Deleting…)$/ });
  const message = "Removal unavailable.";
  pending = await pressWhilePending(reader, remove, "remove-comment", {
    fail: message,
  });
  await expect(mine.getByRole("alert")).toHaveText(message);
  await expect(remove).toHaveText("Delete");
  await expect(pending.pressed).toBeFocused();
  await expect(pending.pressed).toHaveAccessibleDescription(message);
  expect(pending.requests()).toBe(1);

  await reader.goto("/titles/movie/987655");
  const hero = reader.locator(".title-hero");
  const titleRecommend = hero.getByRole("button", {
    name: /^(Recommend to friends|✓ Recommended)$/,
  });
  // The status menu returns focus to its button, which keeps it while the
  // chosen status saves.
  const titleStatus = hero.getByRole("button", { name: /Want to watch$/ });
  for (const [width, control, done, action, choose] of [
    [390, titleRecommend, "✓ Recommended", "activity", undefined],
    [1366, titleStatus, "✓ Want to watch", "watch-status", "Want to watch"],
  ] as const) {
    await reader.setViewportSize({ width, height: 844 });
    pending = await pressWhilePending(reader, control, action, {
      screenshot: "pending-title",
      choose,
    });
    await expect(control).toHaveText(done);
    await expect(pending.pressed).toBeFocused();
    expect(pending.requests()).toBe(1);
  }
});

test("posting a comment or reply keeps keyboard focus on Post while pending and after the draft clears", async ({
  member,
}) => {
  const page = await member("pendingposter");
  await page.goto("/titles/movie/987654");
  await page
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  const composer = page.getByRole("form", { name: "New title comment" });
  await composer.getByRole("textbox").fill("A pending title comment");
  let pending = await pressWhilePending(
    page,
    composer.getByRole("button", { name: /^(Post comment|Posting…)$/ }),
    "title-comment",
    { screenshot: "pending-post" },
  );
  const entry = page
    .locator("[data-item-id]")
    .filter({ hasText: "A pending title comment" });
  await expect(entry).toBeVisible();
  await expect(composer.getByRole("textbox")).toHaveValue("");
  await expect(pending.pressed).toHaveText("Post comment");
  await expect(pending.pressed).toBeFocused();
  // An empty draft leaves Post focusable but unavailable.
  await expect(pending.pressed).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);

  await page.setViewportSize({ width: 1366, height: 844 });
  await entry.getByRole("button", { name: "Comment", exact: true }).click();
  const reply = entry.getByRole("form", { name: "Reply to feed item" });
  await reply.getByRole("textbox").fill("A pending reply");
  pending = await pressWhilePending(
    page,
    reply.getByRole("button", { name: /^(Post reply|Posting…)$/ }),
    "comment",
    { screenshot: "pending-reply" },
  );
  await expect(
    entry.getByText("A pending reply", { exact: true }),
  ).toBeVisible();
  await expect(reply.getByRole("textbox")).toHaveValue("");
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);
});

test("profile relationship actions keep keyboard focus while pending, then stay on or move to their result", async ({
  member,
}) => {
  const viewer = await member("pendingprofileviewer");
  const other = await member("pendingprofileother", {
    displayName: "Opal Pending",
  });
  await viewer.goto("/people/pendingprofileother");
  const actions = viewer.locator(".profile-actions");
  const request = actions.getByRole("button", { name: /friend request$/ });
  let pending = await pressWhilePending(viewer, request, "relationship", {
    screenshot: "pending-profile",
  });
  await expect(request).toHaveText("Cancel friend request");
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);
  await viewer.setViewportSize({ width: 1366, height: 844 });
  pending = await pressWhilePending(viewer, request, "relationship", {
    screenshot: "pending-profile",
  });
  await expect(request).toHaveText("Send friend request");
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);

  // Accepting replaces the button with Watch together, which takes focus.
  await post(other, "relationship", {
    target: await userId(viewer),
    action: "request",
  });
  await viewer.reload();
  await viewer.setViewportSize({ width: 390, height: 844 });
  pending = await pressWhilePending(
    viewer,
    actions.getByRole("button", { name: "Accept friend request" }),
    "relationship",
  );
  await expect(
    actions.getByRole("link", { name: "Watch together", exact: true }),
  ).toBeFocused();
  expect(pending.requests()).toBe(1);

  // A confirmed Unfriend keeps focus while pending, then returns to the menu.
  const more = actions.getByRole("button", {
    name: "More actions for Opal Pending",
  });
  await more.focus();
  await viewer.keyboard.press("Enter");
  await expect(
    viewer.getByRole("menuitem", { name: "Unfriend", exact: true }),
  ).toBeFocused();
  await viewer.keyboard.press("Enter");
  const confirmation = viewer.getByRole("group", { name: /^Unfriend Opal/ });
  pending = await pressWhilePending(
    viewer,
    confirmation.getByRole("button", { name: "Unfriend", exact: true }),
    "relationship",
    { screenshot: "pending-confirmation" },
  );
  await expect(confirmation).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(
    actions.getByRole("button", { name: "Send friend request" }),
  ).toBeVisible();
  expect(pending.requests()).toBe(1);
});

test("Friends rows, notification answers, invitations, and Account settings keep keyboard focus while pending", async ({
  member,
}) => {
  const viewer = await member("pendingotherviewer");
  const viewerId = await userId(viewer);
  const maya = await member("pendingothermaya", { displayName: "Maya P" });
  const sam = await member("pendingothersam", { displayName: "Sam P" });
  for (const requester of [maya, sam])
    await post(requester, "relationship", {
      target: viewerId,
      action: "request",
    });

  // A failed row action leaves focus on its button beside the message.
  await viewer.goto("/people");
  const row = viewer
    .getByRole("region", { name: "Requests", exact: true })
    .getByRole("article")
    .filter({ hasText: "Sam P" });
  const message = "Friends are temporarily unavailable.";
  let pending = await pressWhilePending(
    viewer,
    row.getByRole("button", { name: "Accept", exact: true }),
    "relationship",
    { fail: message, screenshot: "pending-row" },
  );
  await expect(row.getByRole("alert")).toHaveText(message);
  await expect(pending.pressed).toBeFocused();
  await expect(pending.pressed).toHaveAttribute("aria-disabled", "false");
  expect(pending.requests()).toBe(1);

  // A notification answer keeps focus until its result replaces it.
  await viewer.getByRole("button", { name: /^Notifications/ }).click();
  const item = viewer
    .getByRole("dialog", { name: "Notifications" })
    .locator(".notification-item")
    .filter({ hasText: "Maya P sent you a friend request." });
  pending = await pressWhilePending(
    viewer,
    item.getByRole("button", { name: "Accept", exact: true }),
    "respond-friend-request",
  );
  await expect(
    item.getByText("Friend request accepted.", { exact: true }),
  ).toBeFocused();
  expect(pending.requests()).toBe(1);
  await viewer.keyboard.press("Escape");

  await viewer.goto("/invites");
  const create = viewer.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  pending = await pressWhilePending(viewer, create, "invite");
  await expect(
    viewer.getByText("0 of 1 signups", { exact: true }),
  ).toBeVisible();
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);

  // Submitting the profile with Enter keeps focus in the field while saving.
  await viewer.goto("/account");
  await viewer
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  const name = viewer.getByLabel("Display name");
  await name.fill("Pending Viewer");
  pending = await pressWhilePending(viewer, name, "profile");
  await expect(
    viewer.getByRole("button", { name: "Edit profile", exact: true }),
  ).toBeFocused();
  expect(pending.requests()).toBe(1);

  const setting = viewer.getByRole("checkbox", {
    name: "Email me about new activity",
  });
  await expect(setting).not.toBeChecked();
  pending = await pressWhilePending(viewer, setting, "activity-email", {
    key: " ",
  });
  await expect(setting).toBeChecked();
  await expect(pending.pressed).toBeFocused();
  expect(pending.requests()).toBe(1);
});

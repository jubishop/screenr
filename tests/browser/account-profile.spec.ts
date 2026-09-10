import { nextAccountRefresh } from "./refresh-helpers";
import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

async function earlyAnimationFrames(page: Page) {
  return page.evaluateHandle(() => {
    const original = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    const pending = new Set<number>();
    // After an async save, a frame can precede React's queued render. Exercise
    // that ordering at the browser scheduling boundary, without changing React.
    window.requestAnimationFrame = (callback) => {
      const id = original(() => {});
      pending.add(id);
      queueMicrotask(() => {
        if (pending.delete(id)) callback(performance.now());
      });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      cancel(id);
    };
    return () => {
      pending.clear();
      window.requestAnimationFrame = original;
      window.cancelAnimationFrame = cancel;
    };
  });
}

test("account profile editing saves both names, preserves drafts, and updates profile links", async ({
  member,
}, testInfo) => {
  const owner = await member("accountowner");
  const friend = await member("accountfriend");
  await prepareFriendship(owner, friend);
  await owner.goto("/account?item=ignored");
  const edit = owner.getByRole("button", { name: "Edit profile", exact: true });
  await expect(edit).toBeVisible();
  await owner.goto("/account");
  await expect(edit).toBeEnabled();
  await expect(edit).not.toBeFocused();
  const profileLink = owner.getByRole("link", {
    name: "View your profile",
    exact: true,
  });
  await profileLink.focus();
  await nextAccountRefresh(owner);
  await expect(profileLink).toBeFocused();
  await edit.click();
  const name = owner.getByLabel("Display name", { exact: true });
  const username = owner.getByLabel("Username", { exact: true });
  const save = owner.getByRole("button", { name: "Save", exact: true });
  const cancel = owner.getByRole("button", { name: "Cancel", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("accountowner");
  await expect(username).toHaveValue("accountowner");
  await expect(username).toHaveAttribute("maxlength", "24");
  await expect(name).toHaveAttribute("maxlength", "60");
  await expect
    .soft(username)
    .toHaveAccessibleDescription(
      /Old links will no longer lead to your profile\. Someone else can use your old username\./,
    );
  const profileStatus = owner
    .getByRole("region", { name: "Your profile", exact: true })
    .getByRole("status");
  await expect(profileStatus).toHaveText("");
  const liveRegion = await profileStatus.elementHandle();
  let writes = 0;
  owner.on("request", (request) => {
    if (
      request.url().endsWith("/api/screenr/profile") &&
      request.method() === "POST"
    )
      writes++;
  });
  await name.fill("Unsaved name");
  await username.fill("unsaved_handle");
  await nextAccountRefresh(owner);
  await expect(name).toHaveValue("Unsaved name");
  await expect(username).toHaveValue("unsaved_handle");
  await owner.route(
    "**/api/screenr/screen?**",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Temporary refresh failure" },
      }),
    { times: 1 },
  );
  await owner.waitForResponse(
    (response) =>
      response.url().includes("/api/screenr/screen?") &&
      response.status() === 503,
  );
  await expect(name).toHaveValue("Unsaved name");
  await expect(username).toHaveValue("unsaved_handle");
  await cancel.click();
  await expect(edit).toBeFocused();
  await expect(profileStatus).toHaveText("");
  expect(writes).toBe(0);
  await edit.click();
  await expect(name).toHaveValue("accountowner");
  await expect(username).toHaveValue("accountowner");
  await name.fill("   ");
  await expect(save).toBeDisabled();
  await name.fill("Renée Movie Fan 🎬");
  await username.fill("ab");
  await expect(save).toBeDisabled();
  await username.fill("ACCOUNTFRIEND");
  await save.click();
  await expect(
    owner
      .getByRole("alert")
      .filter({ hasText: "That username is already taken." }),
  ).toBeVisible();
  await expect(name).toHaveValue("Renée Movie Fan 🎬");
  await expect(owner.locator(".sidebar-bottom")).toContainText("@accountowner");
  await username.fill("Account_New");
  await owner.route(
    "**/api/screenr/profile",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Could not save. Try again." },
      }),
    { times: 1 },
  );
  await save.click();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Could not save" }),
  ).toBeVisible();
  await expect(username).toHaveValue("Account_New");
  await expect(profileStatus).toHaveText("");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await owner.route(
    "**/api/screenr/profile",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  await save.click();
  const restoreFrames = await earlyAnimationFrames(owner);
  try {
    await expect(
      owner.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect(name).toBeDisabled();
    await expect(username).toBeDisabled();
    await expect(cancel).toBeDisabled();
  } finally {
    release();
  }
  await expect(edit).toBeVisible();
  await expect(profileStatus).toHaveText("Profile saved.");
  expect(
    await liveRegion!.evaluate(
      (element) =>
        element.isConnected && element.textContent === "Profile saved.",
    ),
  ).toBe(true);
  await expect(edit).toBeFocused();
  await restoreFrames.evaluate((restore) => restore());
  await restoreFrames.dispose();
  await profileLink.focus();
  await nextAccountRefresh(owner);
  await expect(profileLink).toBeFocused();
  await edit.click();
  await expect(profileStatus).toHaveText("");
  await cancel.click();
  await expect(profileStatus).toHaveText("");
  await expect(owner.locator(".sidebar-bottom")).toContainText(
    "Renée Movie Fan 🎬",
  );
  await expect(owner.locator(".sidebar-bottom a").first()).toHaveAttribute(
    "href",
    "/people/account_new",
  );
  await expect(
    owner.getByRole("link", { name: "View your profile", exact: true }),
  ).toHaveAttribute("href", "/people/account_new");
  await owner.reload();
  await expect(profileStatus).toHaveText("");
  await edit.click();
  await expect(name).toHaveValue("Renée Movie Fan 🎬");
  await expect(username).toHaveValue("account_new");
  for (const width of [390, 1280]) {
    await owner.setViewportSize({ width, height: 900 });
    await expect(name).toBeVisible();
    await expect(username).toBeVisible();
    expect(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await owner.screenshot({
      path: testInfo.outputPath(`account-edit-${width}.png`),
      fullPage: true,
    });
  }
  await cancel.click();
  await owner
    .getByRole("link", { name: "View your profile", exact: true })
    .click();
  await expect(owner).toHaveURL(/\/people\/account_new$/);
  await expect(
    owner.getByRole("heading", { name: "Renée Movie Fan 🎬", exact: true }),
  ).toBeVisible();
  await expect(
    owner.getByRole("button", { name: "Edit display name", exact: true }),
  ).toBeVisible();
  await friend.goto("/people");
  await friend
    .getByRole("link", { name: "Renée Movie Fan 🎬 @account_new", exact: true })
    .click();
  await expect(
    friend.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeVisible();
  await expect(
    friend.getByRole("button", { name: "Edit profile", exact: true }),
  ).toHaveCount(0);
  await owner.context().close();
  await friend.context().close();
});

test("profile display name editing preserves drafts, saves, and updates existing authors", async ({
  member,
}) => {
  const owner = await member("renameowner");
  const friend = await member("renamefriend");
  await prepareFriendship(owner, friend);
  await owner.goto("/titles/movie/987654");
  await owner
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  await owner.getByRole("button", { name: "Comment", exact: true }).click();
  await owner
    .getByLabel("Add your reply", { exact: true })
    .fill("An earlier reply");
  await owner.getByRole("button", { name: "Post reply", exact: true }).click();
  await owner.goto("/account");
  await owner
    .getByRole("link", { name: "View your profile", exact: true })
    .click();
  const edit = owner.getByRole("button", {
    name: "Edit display name",
    exact: true,
  });
  await expect(edit).toBeVisible();
  await expect(edit).toBeEnabled();
  await expect(edit).not.toBeFocused();
  await expect(owner.getByText("Friends (1)", { exact: true })).toBeVisible();
  const otherTab = await owner.context().newPage();
  await otherTab.goto("/account");
  await owner.bringToFront();
  let writes = 0;
  owner.on("request", (request) => {
    if (
      request.url().endsWith("/api/screenr/display-name") &&
      request.method() === "POST"
    )
      writes++;
  });
  await edit.click();
  const input = owner.getByLabel("Display name", { exact: true });
  const save = owner.getByRole("button", { name: "Save", exact: true });
  const cancel = owner.getByRole("button", { name: "Cancel", exact: true });
  await expect(input).toHaveValue("renameowner");
  await expect(input).toBeFocused();
  await input.fill("Unsaved name");
  await owner.waitForResponse(
    (response) =>
      response.url().includes("/api/screenr/screen?") && response.ok(),
  );
  await expect(input).toHaveValue("Unsaved name");
  await owner.route(
    "**/api/screenr/screen?**",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Temporary refresh failure" },
      }),
    { times: 1 },
  );
  await owner.waitForResponse(
    (response) =>
      response.url().includes("/api/screenr/screen?") &&
      response.status() === 503,
  );
  await expect(input).toHaveValue("Unsaved name");
  await cancel.click();
  await expect(input).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(writes).toBe(0);
  await edit.click();
  await expect(input).toHaveValue("renameowner");
  await input.fill("   ");
  await expect(save).toBeDisabled();
  await expect(input).toHaveAttribute("maxlength", "60");
  await input.fill("  Renée Movie Fan 🎬  ");
  await owner.route(
    "**/api/screenr/display-name",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Could not save. Try again." },
      }),
    { times: 1 },
  );
  await save.click();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Could not save" }),
  ).toBeVisible();
  await expect(input).toHaveValue("  Renée Movie Fan 🎬  ");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await owner.route(
    "**/api/screenr/display-name",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  await save.click();
  const restoreFrames = await earlyAnimationFrames(owner);
  try {
    await expect(
      owner.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect(input).toBeDisabled();
    await expect(cancel).toBeDisabled();
  } finally {
    release();
  }
  await expect(input).toHaveCount(0);
  await expect(edit).toBeFocused();
  await restoreFrames.evaluate((restore) => restore());
  await restoreFrames.dispose();
  const friends = owner.getByRole("link", { name: "Friends", exact: true });
  await friends.focus();
  await owner.waitForResponse(
    (response) =>
      response.url().includes("/api/screenr/screen?") && response.ok(),
  );
  await expect(friends).toBeFocused();
  await expect(
    owner.getByRole("heading", { name: "Renée Movie Fan 🎬", exact: true }),
  ).toBeVisible();
  await expect(owner.locator(".sidebar-bottom")).toContainText(
    "Renée Movie Fan 🎬",
  );
  await expect(owner.locator(".avatar")).toHaveText("R");
  await expect(owner.locator(".activity-by")).toContainText(
    "Renée Movie Fan 🎬",
  );
  await expect(
    owner.getByRole("region", { name: "Conversation", exact: true }),
  ).toContainText("Renée Movie Fan 🎬");
  await expect(owner).toHaveURL(/\/people\/renameowner$/);
  expect(writes).toBe(2);
  await otherTab.bringToFront();
  await expect(otherTab.locator(".sidebar-bottom")).toContainText(
    "Renée Movie Fan 🎬",
  );
  await otherTab.close();
  await owner.reload();
  await expect(
    owner.getByRole("heading", { name: "Renée Movie Fan 🎬", exact: true }),
  ).toBeVisible();
  await friend.goto("/people/renameowner");
  await expect(
    friend.getByRole("button", { name: "Edit display name", exact: true }),
  ).toHaveCount(0);
  await expect(
    friend.getByRole("heading", { name: "Renée Movie Fan 🎬", exact: true }),
  ).toBeVisible();
  await expect(
    friend.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeVisible();
  await expect(friend.locator(".activity-by")).toContainText(
    "Renée Movie Fan 🎬",
  );
  await expect(
    friend.getByRole("region", { name: "Conversation", exact: true }),
  ).toContainText("Renée Movie Fan 🎬");
  await owner.context().close();
  await friend.context().close();
});

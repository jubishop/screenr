import { expect, type Locator, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status()).toBe(200);
  return (await response.json()).id as string;
}

// Counts the writes a page sends for each action, and records browser
// dialogs, which destructive actions must never open.
function watch(page: Page) {
  const actions: string[] = [];
  const dialogs: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && pathname.startsWith("/api/screenr/"))
      actions.push(pathname.slice("/api/screenr/".length));
  });
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return {
    writes: (action: string) =>
      actions.filter((name) => name === action).length,
    dialogs,
  };
}

// Pressing a destructive action opens its confirmation inside `container`,
// with the question as the group's name and Cancel focused. The confirmation
// fits the page width. The screen is saved to `.cache/<screenshot>-<width>.png`.
async function expectConfirmation(
  page: Page,
  container: Locator,
  question: string,
  screenshot: string,
) {
  const group = container.getByRole("group", { name: question, exact: true });
  await expect(group).toBeVisible();
  await expect(group).toContainText(question);
  await expect(group.getByRole("button", { name: "Cancel" })).toBeFocused();
  const { width } = page.viewportSize()!;
  const bounds = (await group.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
  await group.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await page.screenshot({ path: `.cache/${screenshot}-${width}.png` });
  return group;
}

test("Delete and Remove on comments ask for an in-page confirmation first", async ({
  member,
}) => {
  const host = await member("confirmhost", { displayName: "Hana Host" });
  const guest = await member("confirmguest", { displayName: "Gus Guest" });
  await prepareFriendship(host, guest);
  const entry = await post(host, "activity", {
    title: "movie:987654",
    field: "recommended",
    value: true,
  });
  const guestReply = await post(guest, "comment", {
    conversation: entry,
    body: "A guest reply to remove",
    spoiler: false,
  });
  const hostReply = await post(host, "comment", {
    conversation: entry,
    body: "A host reply to delete",
    spoiler: false,
  });
  const standalone = await post(guest, "title-comment", {
    title: "movie:987655",
    body: "A standalone comment to delete",
    spoiler: false,
  });
  const hostWatch = watch(host);
  const guestWatch = watch(guest);
  const question = "Delete this comment? Its text will be erased.";

  // Keyboard on a phone: Cancel has focus, so Enter keeps the comment.
  await host.goto("/");
  const own = host.locator(`[data-comment-id="${hostReply}"]`);
  const remove = own.getByRole("button", { name: "Delete", exact: true });
  await remove.focus();
  await host.keyboard.press("Enter");
  let group = await expectConfirmation(
    host,
    own,
    question,
    "confirm-comment-delete",
  );
  await host.keyboard.press("Enter");
  await expect(group).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(own).toContainText("A host reply to delete");

  // Shift+Tab reaches Delete, which erases the comment's text.
  await host.keyboard.press("Enter");
  await expect(group).toBeVisible();
  await host.keyboard.press("Shift+Tab");
  await expect(
    group.getByRole("button", { name: "Delete", exact: true }),
  ).toBeFocused();
  expect(hostWatch.writes("remove-comment")).toBe(0);
  await host.keyboard.press("Enter");
  // A comment without replies leaves no placeholder.
  await expect(own).toHaveCount(0);
  await expect(host.getByText("A host reply to delete")).toHaveCount(0);
  expect(hostWatch.writes("remove-comment")).toBe(1);

  // The host removes someone else's comment with the same confirmation.
  const theirs = host.locator(`[data-comment-id="${guestReply}"]`);
  await theirs.getByRole("button", { name: "Remove", exact: true }).click();
  group = await expectConfirmation(
    host,
    theirs,
    "Remove this comment? Its text will be erased.",
    "confirm-comment-remove",
  );
  await group.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(theirs).toContainText("A guest reply to remove");
  await theirs.getByRole("button", { name: "Remove", exact: true }).click();
  await group.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(host.getByText("A guest reply to remove")).toHaveCount(0);
  expect(hostWatch.writes("remove-comment")).toBe(2);

  // A standalone title comment's Delete confirms on desktop too.
  await guest.setViewportSize({ width: 1366, height: 844 });
  await guest.goto("/titles/movie/987655");
  const heading = guest.locator(`[data-item-heading="${standalone}"]`);
  await heading.getByRole("button", { name: "Delete", exact: true }).click();
  group = await expectConfirmation(
    guest,
    heading,
    question,
    "confirm-entry-delete",
  );
  await group.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    heading.getByRole("button", { name: "Delete", exact: true }),
  ).toBeFocused();
  await expect(heading).toContainText("A standalone comment to delete");
  expect(guestWatch.writes("remove-comment")).toBe(0);
  await guest.keyboard.press("Enter");
  await guest.keyboard.press("Shift+Tab");
  await guest.keyboard.press("Enter");
  await expect(guest.locator(`[data-item-id="${standalone}"]`)).toHaveCount(0);
  expect(guestWatch.writes("remove-comment")).toBe(1);
  expect([...hostWatch.dialogs, ...guestWatch.dialogs]).toEqual([]);
});

test("Decline on the Friends page and Revoke invitation ask for an in-page confirmation first", async ({
  member,
}) => {
  const viewer = await member("confirmdecliner");
  const maya = await member("confirmmaya", { displayName: "Maya Chen" });
  await post(maya, "relationship", {
    target: await userId(viewer),
    action: "request",
  });
  const seen = watch(viewer);
  await viewer.goto("/people");
  const requests = viewer.getByRole("region", {
    name: "Requests",
    exact: true,
  });
  const row = requests.getByRole("article").filter({ hasText: "Maya Chen" });
  const decline = row.getByRole("button", { name: "Decline", exact: true });
  const question =
    "Decline Maya Chen’s friend request? The request will be removed.";
  for (const width of [390, 1366]) {
    await viewer.setViewportSize({ width, height: 844 });
    await decline.focus();
    await viewer.keyboard.press("Enter");
    const group = await expectConfirmation(
      viewer,
      row,
      question,
      "confirm-decline",
    );
    await viewer.keyboard.press("Enter");
    await expect(group).toHaveCount(0);
    await expect(decline).toBeFocused();
  }
  expect(seen.writes("relationship")).toBe(0);
  await decline.click();
  await viewer.keyboard.press("Shift+Tab");
  await viewer.keyboard.press("Enter");
  await expect(requests).toHaveCount(0);
  expect(seen.writes("relationship")).toBe(1);
  await viewer.reload();
  await expect(viewer.getByText("Maya Chen")).toHaveCount(0);

  await post(viewer, "invite", { limit: 1 });
  await viewer.goto("/invites");
  const card = viewer.locator(".invite-card");
  const revoke = card.getByRole("button", { name: "Revoke", exact: true });
  for (const width of [390, 1366]) {
    await viewer.setViewportSize({ width, height: 844 });
    await revoke.click();
    const group = await expectConfirmation(
      viewer,
      card,
      "Revoke this invitation? Its link will stop working.",
      "confirm-revoke",
    );
    await group.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(group).toHaveCount(0);
    await expect(revoke).toBeFocused();
  }
  await expect(card.getByLabel("Invitation link")).toHaveValue(/\/join\//);
  expect(seen.writes("revoke-invite")).toBe(0);
  await viewer.keyboard.press("Enter");
  await viewer.keyboard.press("Shift+Tab");
  await viewer.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  await expect(
    viewer.getByText("No active invitations.", { exact: true }),
  ).toBeVisible();
  expect(seen.writes("revoke-invite")).toBe(1);
  expect(seen.dialogs).toEqual([]);
});

import { expect, type Locator, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { person, friend, userId } from "./member-fixture";

const { changeRelationship } = await import("../../src/server/relationships");
const { addComment } = await import("../../src/server/comments");

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status()).toBe(200);
  return (await response.json()).id as string;
}

// Press `control` from the keyboard. A destructive action first opens its
// in-page confirmation with Cancel focused; Shift+Tab and Enter confirm it.
// Once the action succeeds, its control is gone and `target` has focus.
async function pressAndExpectFocus(
  page: Page,
  control: Locator,
  target: Locator,
  confirmation?: string,
) {
  await control.focus();
  await page.keyboard.press("Enter");
  if (confirmation) {
    const group = page.getByRole("group", { name: confirmation });
    await expect(
      group.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(group).toHaveCount(0);
  }
  await expect(control).toHaveCount(0);
  await expect(target).toBeFocused();
}

const removal = "Delete this comment? Its text will be erased.";

for (const width of [390, 1366]) {
  test(`Delete on an entry moves focus to its placeholder, the next or previous entry, or the feed at ${width}px`, async ({
    member,
  }) => {
    const owner = await member(`focusentry${width}`);
    await owner.setViewportSize({ width, height: 844 });
    const bea = await person(`focusentrybea${width}`, "Bea Friend");
    await friend(await userId(owner), bea);
    const comment = (title: string, body: string) =>
      post(owner, "title-comment", { title, body, spoiler: false });
    const replied = await comment("movie:996301", "An entry with a reply");
    const oldest = await comment("movie:996302", "The oldest entry");
    const newest = await comment("movie:996303", "The newest entry");
    const reply = await addComment(bea, replied, "Bea's reply", false);
    const entry = (id: string) => owner.locator(`[data-item-id="${id}"]`);
    const remove = (id: string) =>
      owner
        .locator(`[data-item-heading="${id}"]`)
        .getByRole("button", { name: "Delete", exact: true });

    // The reply moves its entry to the top of Your circle.
    await owner.goto("/");
    await expect(owner.locator("[data-item-id]")).toHaveText([
      /An entry with a reply/,
      /The newest entry/,
      /The oldest entry/,
    ]);
    await pressAndExpectFocus(owner, remove(newest), entry(oldest), removal);
    await expect(entry(newest)).toBeHidden();
    // The last entry passes focus to the one before it.
    await pressAndExpectFocus(owner, remove(oldest), entry(replied), removal);
    // An entry with replies stays, and its placeholder takes focus.
    await pressAndExpectFocus(
      owner,
      remove(replied),
      entry(replied).getByText("Comment removed", { exact: true }),
      removal,
    );
    await expect(entry(replied)).toContainText("Bea's reply");
    // Removing the last reply takes the entry with it, which leaves the feed
    // empty and focused.
    const feed = owner.getByRole("region", {
      name: "Activity feed",
      exact: true,
    });
    await pressAndExpectFocus(
      owner,
      owner
        .locator(`[data-comment-id="${reply}"]`)
        .getByRole("button", { name: "Remove", exact: true }),
      feed,
      "Remove this comment? Its text will be erased.",
    );
    await expect(entry(replied)).toBeHidden();

    // On a title page, Delete on the last entry also focuses the empty feed.
    const first = await comment("movie:996304", "The first title entry");
    const second = await comment("movie:996304", "The second title entry");
    await owner.goto("/titles/movie/996304");
    await pressAndExpectFocus(owner, remove(second), entry(first), removal);
    await pressAndExpectFocus(owner, remove(first), feed, removal);
    await expect(feed).toContainText(
      "Your entries and friends’ discussions will appear here.",
    );
  });

  test(`Delete and Remove on comments move focus to the placeholder, the next or previous comment, or the entry at ${width}px`, async ({
    member,
  }) => {
    const host = await member(`focuscomment${width}`);
    await host.setViewportSize({ width, height: 844 });
    const hostId = await userId(host);
    const gus = await person(`focuscommentgus${width}`, "Gus Guest");
    await friend(hostId, gus);
    const entry = await post(host, "activity", {
      title: "movie:996310",
      field: "recommended",
      value: true,
    });
    const parent = await addComment(gus, entry, "Gus's comment", false);
    const nested = await addComment(
      hostId,
      entry,
      "The host's nested reply",
      false,
      parent,
    );
    const middle = await addComment(hostId, entry, "The middle one", false);
    const last = await addComment(gus, entry, "Gus's last comment", false);
    const comment = (id: string) => host.locator(`[data-comment-id="${id}"]`);
    const action = (id: string, name: string) =>
      comment(id).getByRole("button", { name, exact: true });

    await host.goto("/");
    await pressAndExpectFocus(
      host,
      action(middle, "Delete"),
      comment(last),
      removal,
    );
    // The last comment passes focus to the one before it.
    await pressAndExpectFocus(
      host,
      action(last, "Remove"),
      comment(parent),
      "Remove this comment? Its text will be erased.",
    );
    // A comment with replies stays, and its placeholder takes focus.
    await pressAndExpectFocus(
      host,
      action(parent, "Remove"),
      comment(parent).getByText("Comment removed", { exact: true }),
      "Remove this comment? Its text will be erased.",
    );
    // Removing the last reply empties the conversation, so its entry takes
    // focus.
    const replies = host.getByRole("button", {
      name: "View 1 reply",
      exact: true,
    });
    await replies.focus();
    await host.keyboard.press("Enter");
    await pressAndExpectFocus(
      host,
      action(nested, "Delete"),
      host.locator(`[data-item-id="${entry}"]`),
      removal,
    );
    await expect(comment(parent)).toHaveCount(0);
  });

  test(`Friends row actions move focus to the person's new row, the next or previous row, or the nearest section heading at ${width}px`, async ({
    member,
  }) => {
    const viewer = await member(`focusrows${width}`);
    await viewer.setViewportSize({ width, height: 844 });
    const viewerId = await userId(viewer);
    // Usernames order the rows in each section.
    const named = (suffix: string, name: string) =>
      person(`focusrow${width}${suffix}`, name);
    const ada = await named("a", "Ada Request");
    const ben = await named("b", "Ben Request");
    const cy = await named("c", "Cy Request");
    for (const requester of [ada, ben, cy])
      await changeRelationship(requester, viewerId, "request");
    const fran = await named("f", "Fran Friend");
    await friend(viewerId, fran);
    await friend(fran, await named("s", "Sue Suggested"));
    for (const sent of [
      await named("u", "Uma Sent"),
      await named("v", "Val Sent"),
    ])
      await changeRelationship(viewerId, sent, "request");
    for (const blocked of [
      await named("w", "Wes Blocked"),
      await named("x", "Xia Blocked"),
    ])
      await changeRelationship(viewerId, blocked, "block");
    const region = (name: string) =>
      viewer.getByRole("region", { name, exact: true });
    const row = (section: string, name: string) =>
      region(section).getByRole("article").filter({ hasText: name });
    const button = (section: string, name: string, label: string) =>
      row(section, name).getByRole("button", { name: label, exact: true });
    const heading = (name: string) =>
      viewer.getByRole("heading", { name, exact: true, level: 2 });

    await viewer.goto("/people");
    // Accept moves the person to Friends, and focus follows them.
    await pressAndExpectFocus(
      viewer,
      button("Requests", "Ben Request", "Accept"),
      region("Friends").getByRole("article", {
        name: `Ben Request @focusrow${width}b`,
        exact: true,
      }),
    );
    await pressAndExpectFocus(
      viewer,
      button("Requests", "Ada Request", "Decline"),
      row("Requests", "Cy Request"),
      "Decline Ada Request’s friend request? The request will be removed.",
    );
    // The last request removes its section; the next section's heading
    // takes focus.
    await pressAndExpectFocus(
      viewer,
      button("Requests", "Cy Request", "Decline"),
      heading("Friends"),
      "Decline Cy Request’s friend request? The request will be removed.",
    );
    await expect(region("Requests")).toHaveCount(0);
    await pressAndExpectFocus(
      viewer,
      button("People you may know", "Sue Suggested", "Send friend request"),
      region("Sent requests").getByRole("article", {
        name: `Sue Suggested @focusrow${width}s`,
        exact: true,
      }),
    );
    // The last row passes focus to the one before it.
    await pressAndExpectFocus(
      viewer,
      button("Sent requests", "Val Sent", "Cancel"),
      row("Sent requests", "Uma Sent"),
    );
    await pressAndExpectFocus(
      viewer,
      button("Blocked people", "Wes Blocked", "Unblock"),
      region("Blocked people").getByRole("article", {
        name: "Xia Blocked",
        exact: true,
      }),
    );
    // Blocked people is the last section, so the heading before it takes
    // focus.
    await pressAndExpectFocus(
      viewer,
      button("Blocked people", "Xia Blocked", "Unblock"),
      heading("People you may know"),
    );
    await expect(region("Blocked people")).toHaveCount(0);
  });

  test(`Revoke moves focus to the next or previous invitation, or the empty list at ${width}px`, async ({
    member,
  }) => {
    const viewer = await member(`focusinvites${width}`);
    await viewer.setViewportSize({ width, height: 844 });
    for (const limit of [1, 2, 3]) await post(viewer, "invite", { limit });
    const card = (uses: string) =>
      viewer.getByRole("article", { name: new RegExp(`^${uses} signups`) });
    const revoke = (uses: string) =>
      card(uses).getByRole("button", { name: "Revoke", exact: true });
    const question = "Revoke this invitation? Its link will stop working.";

    // The newest invitation comes first.
    await viewer.goto("/invites");
    await expect(viewer.locator(".invite-card strong")).toHaveText([
      "0 of 3 signups",
      "0 of 2 signups",
      "0 of 1 signups",
    ]);
    await pressAndExpectFocus(
      viewer,
      revoke("0 of 2"),
      card("0 of 1"),
      question,
    );
    // The last invitation passes focus to the one before it.
    await pressAndExpectFocus(
      viewer,
      revoke("0 of 1"),
      card("0 of 3"),
      question,
    );
    await pressAndExpectFocus(
      viewer,
      revoke("0 of 3"),
      viewer.getByText("No active invitations.", { exact: true }),
      question,
    );
  });
}

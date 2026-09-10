import { expect, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test, monitorErrors } from "./monitored-test";
import { prepareFriendship, type Member } from "./member-fixture";

async function nestedDiscussion(member: Member, suffix: string) {
  const owner = await member(`nestowner${suffix}`);
  const reader = await member(`nestreader${suffix}`);
  const other = await member(`nestother${suffix}`);
  await prepareFriendship(owner, reader);
  await prepareFriendship(owner, other);
  const response = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  async function write(
    page: Page,
    body: string,
    replyTo?: string,
    spoiler = false,
  ) {
    const result = await page.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: { conversation: id, body, replyTo, spoiler },
    });
    expect(result.status()).toBe(200);
    return (await result.json()).id as string;
  }
  const item = reader.locator(`[data-item-id="${id}"]`);
  const comment = (id: string) => item.locator(`[data-comment-id="${id}"]`);
  return { owner, reader, other, id, write, item, comment };
}

test("own nested replies keep their parent when another tab has not accepted new activity", async ({
  member,
}) => {
  const owner = await member("pendingparentowner");
  const reader = await member("pendingparentreader");
  await prepareFriendship(owner, reader);
  const response = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  await reader.goto(`/titles/movie/987654?item=${id}`);
  const item = reader.locator(`[data-item-id="${id}"]`);
  await expect(
    item.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect(item.locator("[data-comment-id]")).toHaveCount(0);
  const parentResponse = await owner.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "Pending parent", spoiler: false },
  });
  expect(parentResponse.status()).toBe(200);
  const { id: parent } = await parentResponse.json();
  const unrelated = await owner.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "Still pending", spoiler: false },
  });
  expect(unrelated.status()).toBe(200);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(item.getByText("Pending parent", { exact: true })).toHaveCount(
    0,
  );

  const otherTab = await reader.context().newPage();
  monitorErrors(otherTab);
  await otherTab.goto(`/titles/movie/987654?item=${id}`);
  await otherTab
    .locator(`[data-comment-id="${parent}"]`)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const composer = otherTab.getByRole("form", {
    name: "Replying to @pendingparentowner",
  });
  await composer.getByRole("textbox").fill("My reply from another tab");
  await composer
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    otherTab.getByText("My reply from another tab", { exact: true }),
  ).toBeVisible();
  await reader.bringToFront();
  await expect(item.getByText("Pending parent", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "View 1 reply", exact: true }).click();
  await expect(
    item.getByText("My reply from another tab", { exact: true }),
  ).toBeVisible();
  await expect(item.getByText("Be the first to reply.")).toHaveCount(0);
  await expect(item.getByText("Still pending", { exact: true })).toHaveCount(0);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await owner.context().close();
  await reader.context().close();
});

test("nested discussions group stored replies, preview direct comments, and keep two composer destinations", async ({
  member,
}) => {
  test.setTimeout(180_000);
  const { owner, reader, other, id, write, item, comment } =
    await nestedDiscussion(member, "layout");
  const first = await write(other, "Old direct comment");
  const root = await write(other, "Parent comment");
  const second = await write(owner, "Unrelated direct comment");
  const child = await write(owner, "Nested spoiler", root, true);
  const third = await write(owner, "Newest direct comment");
  const grandchild = await write(other, "Reply to the nested comment", child);
  for (const [index, path] of [
    "/titles/movie/987654",
    "/",
    "/people/nestownerlayout",
  ].entries()) {
    await reader.setViewportSize(
      index === 1 ? { width: 1280, height: 900 } : { width: 390, height: 844 },
    );
    await reader.goto(path);
    await expect(item.locator("[data-comment-id]")).toHaveCount(3);
    await expect(comment(first)).toHaveCount(0);
    expect(
      await item
        .locator("[data-comment-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-comment-id")),
        ),
    ).toEqual([root, second, third]);
    const expand = item.getByRole("button", {
      name: "View 2 replies",
      exact: true,
    });
    await expand.focus();
    await reader.keyboard.press("Enter");
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(comment(grandchild)).toBeVisible();
    expect((await comment(child).boundingBox())!.x).toBeGreaterThan(
      (await comment(root).boundingBox())!.x + 10,
    );
    expect((await comment(child).boundingBox())!.x).toBe(
      (await comment(grandchild).boundingBox())!.x,
    );
    expect(
      await item
        .locator("[data-comment-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-comment-id")),
        ),
    ).toEqual([root, child, grandchild, second, third]);
    await expect(
      comment(child).getByText("Nested spoiler", { exact: true }),
    ).toHaveCount(0);
    await expect(
      comment(grandchild).getByText("Replying to @nestownerlayout", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(index === 1 ? 1280 : 390);
    await reader.screenshot({
      path: `.cache/nested-layout-${index}.png`,
      fullPage: true,
    });
  }
  await item.getByRole("button", { name: "Comment", exact: true }).click();
  const direct = item.getByRole("form", {
    name: "Reply to feed item",
    exact: true,
  });
  await direct
    .getByLabel("Add your reply", { exact: true })
    .fill("Direct draft");
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const nested = () => item.getByRole("form", { name: /^Replying to @/ });
  await expect(nested().getByRole("textbox")).toBeFocused();
  expect((await nested().boundingBox())!.y).toBeGreaterThan(
    (await comment(root).boundingBox())!.y,
  );
  expect((await nested().boundingBox())!.y).toBeLessThan(
    (await comment(child).boundingBox())!.y,
  );
  await nested().getByRole("textbox").fill("Draft for parent");
  await comment(child)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested()).toHaveAccessibleName("Replying to @nestownerlayout");
  await expect(nested().getByRole("textbox")).toHaveValue("");
  await nested().getByRole("textbox").fill("Draft for child");
  await nested().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(nested()).toHaveCount(0);
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for parent");
  await reader.route("**/api/screenr/comment", (route) =>
    route.fulfill({ status: 503, json: { error: "Try this reply again" } }),
  );
  await nested()
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(nested().getByRole("alert")).toHaveText("Try this reply again");
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for parent");
  await reader.unroute("**/api/screenr/comment");
  await direct.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    item
      .locator("[data-comment-id]")
      .getByText("Direct draft", { exact: true }),
  ).toBeVisible();
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for parent");
  // Removing a comment must still report errors with its composer closed.
  await direct.getByRole("button", { name: "Cancel", exact: true }).click();
  await reader.route("**/api/screenr/remove-comment", (route) =>
    route.fulfill({ status: 503, json: { error: "Removal unavailable" } }),
  );
  await item
    .locator("[data-comment-id]")
    .filter({ hasText: "Direct draft" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(direct).toHaveCount(0);
  await expect(
    item.getByRole("alert").filter({ hasText: "Removal unavailable" }),
  ).toBeVisible();
  await reader.unroute("**/api/screenr/remove-comment");
  const groupToggle = item.getByRole("button", {
    name: "View 2 replies",
    exact: true,
  });
  await groupToggle.click();
  await expect(comment(child)).toHaveCount(0);
  await nested()
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(comment(child)).toBeVisible();
  await expect(
    item
      .locator("[data-comment-id]")
      .getByText("Draft for parent", { exact: true }),
  ).toBeVisible();
  await comment(child)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for child");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await reader.route("**/api/screenr/comment", async (route) => {
    await gate;
    await route.continue();
  });
  await nested()
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    nested().getByRole("button", { name: "Posting…", exact: true }),
  ).toBeDisabled();
  await nested().getByRole("textbox").fill("Later typing for child");
  await nested().getByRole("button", { name: "Cancel", exact: true }).click();
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await nested().getByRole("textbox").fill("Unsent next reply to parent");
  release();
  await expect(
    item
      .locator("[data-comment-id]")
      .getByText("Draft for child", { exact: true }),
  ).toBeVisible();
  await reader.unroute("**/api/screenr/comment");
  await expect(nested().getByRole("textbox")).toHaveValue(
    "Unsent next reply to parent",
  );
  await comment(child)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested().getByRole("textbox")).toHaveValue(
    "Later typing for child",
  );
  await reader.setViewportSize({ width: 320, height: 844 });
  expect(
    await reader.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(320);
  await reader.screenshot({
    path: ".cache/nested-composer-mobile.png",
    fullPage: true,
  });
  const saved = await reader.request.get(
    `/api/screenr/screen?path=${encodeURIComponent(`/titles/movie/987654?item=${id}`)}`,
  );
  const screen = await saved.json();
  const comments = screen.conversations.find(
    (c: { id: string }) => c.id === id,
  ).comments;
  expect(
    comments.find((c: { body: string }) => c.body === "Direct draft").root_id,
  ).toBeNull();
  for (const body of ["Draft for parent", "Draft for child"])
    expect(
      comments.find((c: { body: string }) => c.body === body).root_id,
    ).toBe(root);
  await reader.goto(`/titles/movie/987654?item=${id}&reply=${child}`);
  await expect(comment(first)).toBeVisible();
  await expect(comment(child)).toBeInViewport();
  await expect(
    comment(child).getByText("Nested spoiler", { exact: true }),
  ).toHaveCount(0);
  await comment(child)
    .getByRole("button", { name: /Reveal comment/ })
    .click();
  await expect(
    comment(child).getByText("Nested spoiler", { exact: true }),
  ).toBeVisible();
  await reader.goto("/people/nestownerlayout");
  await expect(comment(child)).toHaveCount(0);
  for (const page of [owner, reader, other]) await page.context().close();
});

test("nested updates preserve drafts, expansion, and position while parent access changes immediately", async ({
  member,
}) => {
  test.setTimeout(180_000);
  const { owner, reader, other, id, write, item, comment } =
    await nestedDiscussion(member, "access");
  const root = await write(other, "Parent that will be hidden");
  const child = await write(owner, "Eligible child", root);
  const removed = await write(owner, "Removed nested reply", root);
  expect(
    (
      await owner.request.post("/api/screenr/remove-comment", {
        headers: { Origin: browserConfig.baseURL },
        data: { id: removed },
      })
    ).status(),
  ).toBe(200);
  await reader.goto(`/titles/movie/987654?item=${id}`);
  await item.getByRole("button", { name: "View 1 reply", exact: true }).click();
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const nested = item.getByRole("form", {
    name: "Replying to @nestotheraccess",
    exact: true,
  });
  await nested.getByRole("textbox").fill("Keep this nested draft");
  await item.getByRole("button", { name: "Comment", exact: true }).click();
  await item
    .getByRole("form", { name: "Reply to feed item", exact: true })
    .getByRole("textbox")
    .fill("Keep this direct draft");
  await write(owner, "Incoming nested reply", child);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(
    item.getByText("Incoming nested reply", { exact: true }),
  ).toHaveCount(0);
  await comment(child).evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const before = (await comment(child).boundingBox())!.y;
  await reader.getByRole("button", { name: /New activity/ }).click();
  await expect(
    item.getByText("Incoming nested reply", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs((await comment(child).boundingBox())!.y - before),
    )
    .toBeLessThan(3);
  await expect(nested.getByRole("textbox")).toHaveValue(
    "Keep this nested draft",
  );
  const otherScreen = await owner.request.get(
    "/api/screenr/screen?path=/people/nestotheraccess",
  );
  const otherId = (await otherScreen.json()).profile.user_id;
  expect(
    (
      await reader.request.post("/api/screenr/relationship", {
        headers: { Origin: browserConfig.baseURL },
        data: { target: otherId, action: "block" },
      })
    ).status(),
  ).toBe(200);
  await expect(
    comment(root).getByText("Comment unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    comment(root).getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (
      await reader.request.post("/api/screenr/reaction", {
        headers: { Origin: browserConfig.baseURL },
        data: { item: id, reply: root, kind: "like" },
      })
    ).status(),
  ).toBe(404);
  const childReactions = comment(child).getByRole("group", {
    name: "Reactions to reply",
    exact: true,
  });
  await childReactions
    .getByRole("button", { name: "React", exact: true })
    .click();
  await childReactions
    .getByRole("button", { name: "Care", exact: true })
    .click();
  await expect(
    childReactions.getByRole("button", { name: "Care: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(item.getByText(/@nestotheraccess/)).toHaveCount(0);
  await expect(
    item.getByText("Parent that will be hidden", { exact: true }),
  ).toHaveCount(0);
  await expect(comment(child)).toBeVisible();
  await expect(
    item
      .getByRole("form", { name: "Reply to feed item", exact: true })
      .getByRole("textbox"),
  ).toHaveValue("Keep this direct draft");
  const data = await reader.request.get(
    `/api/screenr/screen?path=${encodeURIComponent(`/titles/movie/987654?item=${id}`)}`,
  );
  expect(await data.text()).not.toContain("nestotheraccess");
  expect(
    (
      await reader.request.post("/api/screenr/comment", {
        headers: { Origin: browserConfig.baseURL },
        data: {
          conversation: id,
          body: "Reject stale target",
          spoiler: false,
          replyTo: root,
        },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await reader.request.post("/api/screenr/relationship", {
        headers: { Origin: browserConfig.baseURL },
        data: { target: otherId, action: "unblock" },
      })
    ).status(),
  ).toBe(200);
  await expect(nested.getByRole("textbox")).toHaveValue(
    "Keep this nested draft",
  );
  expect(
    (
      await owner.request.post("/api/screenr/remove-comment", {
        headers: { Origin: browserConfig.baseURL },
        data: { id: root },
      })
    ).status(),
  ).toBe(200);
  await expect(
    comment(root).getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await expect(comment(child)).toBeVisible();
  await expect(
    item.getByRole("button", { name: "View 2 replies", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await reader.reload();
  await expect(
    item.getByRole("button", { name: "View 2 replies", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(comment(child)).toHaveCount(0);
  await reader.goto(`/titles/movie/987654?item=${id}&reply=${child}`);
  await expect(comment(child)).toBeInViewport();
  const ownerScreen = await reader.request.get(
    "/api/screenr/screen?path=/people/nestowneraccess",
  );
  expect(
    (
      await reader.request.post("/api/screenr/relationship", {
        headers: { Origin: browserConfig.baseURL },
        data: {
          target: (await ownerScreen.json()).profile.user_id,
          action: "remove",
        },
      })
    ).status(),
  ).toBe(200);
  await expect(item).toHaveCount(0);
  for (const page of [owner, reader, other]) await page.context().close();
});

import { expect } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test, monitorErrors } from "./monitored-test";
import { befriend } from "./journey-helpers";

test("profile friends support discovery and refresh accepted friendships and blocks", async ({
  member,
  page,
}) => {
  const owner = await member("circleowner");
  const displayName = "W".repeat(60);
  const friend = await member("circlefriend", { displayName });
  const viewer = await member("circleviewer");
  await befriend(owner, friend, "circlefriend", "circleowner");

  const anonymous = await page.request.get(
    "/api/screenr/screen?path=/people/circleowner",
  );
  expect(anonymous.status()).toBe(401);
  await page.goto("/people/circleowner");
  await expect(page).toHaveURL(/\/login/);

  await owner.goto("/people/circleowner");
  await owner.getByText("Friends (1)", { exact: true }).click();
  await expect(
    owner
      .getByRole("region", { name: "Friends", exact: true })
      .getByRole("link"),
  ).toHaveText(`${displayName} @circlefriend`);

  await viewer.goto("/people/circleowner");
  await viewer.getByText("Friends (1)", { exact: true }).click();
  const list = viewer.getByRole("region", { name: "Friends", exact: true });
  await expect(list.getByRole("link")).toHaveCount(1);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await viewer.setViewportSize({ width, height: 900 });
    expect(
      await viewer.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await viewer.screenshot({
      path: `.cache/profile-friends-${width}.png`,
      fullPage: true,
    });
  }
  const toggle = viewer.getByText("Friends (1)", { exact: true });
  await toggle.focus();
  await toggle.press("Enter");
  await expect(list).toBeHidden();
  await toggle.press("Enter");
  await expect(list).toBeVisible();
  await list
    .getByRole("link", { name: `${displayName} @circlefriend` })
    .click();
  await expect(viewer).toHaveURL(/\/people\/circlefriend$/);
  await viewer
    .getByRole("button", { name: "Send friend request", exact: true })
    .click();
  await expect(
    viewer.getByRole("button", { name: "Cancel friend request", exact: true }),
  ).toBeVisible();

  await viewer.goto("/people/circleowner");
  await viewer
    .getByRole("button", { name: "Send friend request", exact: true })
    .click();
  await viewer.getByText("Friends (1)", { exact: true }).click();
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(
    viewer.getByText("You’ll see their activity after you become friends."),
  ).toBeVisible();

  await friend.goto("/people/circleowner");
  await friend.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(viewer.getByText("Friends (0)", { exact: true })).toBeVisible();
  await expect(list.getByRole("link")).toHaveCount(0);
  await expect(list.getByText("No friends to show yet.")).toBeVisible();

  await befriend(owner, friend, "circlefriend", "circleowner");
  await expect(list.getByRole("link")).toHaveCount(1);
  await friend.goto("/people/circleviewer");
  await friend.getByRole("button", { name: "Block", exact: true }).click();
  await expect(list.getByRole("link")).toHaveCount(0);

  await owner.goto("/people/circleviewer");
  await owner.getByRole("button", { name: "Block", exact: true }).click();
  await expect(
    viewer.getByRole("alert").filter({ hasText: "Person not found." }),
  ).toBeVisible();
  await expect(viewer.getByText("Friends (0)", { exact: true })).toHaveCount(0);
  await owner.context().close();
  await friend.context().close();
  await viewer.context().close();
});

test("an unavailable legacy link navigates after friendship restores access", async ({
  member,
}) => {
  const owner = await member("recoveryowner");
  const reader = await member("recoveryreader");
  await owner.goto("/titles/movie/987654");
  const response = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  const screen = await owner.request.get("/api/screenr/screen?path=/");
  const entry = (await screen.json()).conversations.find(
    (item: { id: string }) => item.id === id,
  );
  const waiting = await reader.context().newPage();
  monitorErrors(waiting);
  await waiting.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Trailer player fixture" }),
  );
  await waiting.goto(`/conversations/${entry.conversation_id}`);
  await expect(waiting.getByRole("main").getByRole("alert")).toContainText(
    "Conversation not found.",
  );
  await befriend(owner, reader, "recoveryreader", "recoveryowner");
  await waiting.bringToFront();
  await expect(waiting).toHaveURL(
    new RegExp(`/titles/movie/987654\\?item=${id}$`),
  );
  await expect(
    waiting
      .locator(`[data-item-id="${id}"]`)
      .getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await reader.context().close();
  await owner.context().close();
});

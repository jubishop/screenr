import { expect } from "@playwright/test";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { friend, person, userId } from "./member-fixture";
import { openWithoutPolling } from "./refresh-helpers";
const { updateTitleActivity } = await import("../../src/server/title-actions");

// The server refuses text with a blocked word
// (docs/data-and-access.md#blocked-words). Each form shows the server's
// message beneath its fields and keeps what the member typed.

const refusal = (label: string) =>
  `${label} contains a word Screenr doesn’t allow.`;

test("a refused post, profile edit, or signup shows the server's message and keeps the typed text", async ({
  member,
}) => {
  const writer = await member("blockedwriter");
  await writer
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  const composer = writer.getByRole("form", { name: "New post" });
  const field = composer.getByLabel("Your post", { exact: true });
  const post = composer.getByRole("button", { name: "Post", exact: true });
  await field.fill("That finale was one long gangbang.");
  await post.click();
  await expect(composer.locator(".error")).toHaveText(refusal("Post"));
  await expect(field).toHaveValue("That finale was one long gangbang.");
  await expect(
    writer.locator("[data-item-id]").filter({ hasText: "finale" }),
  ).toHaveCount(0);
  // Ordinary text, with words that contain a blocked word, posts.
  await field.fill("The spicy finale made me snigger.");
  await post.click();
  await expect(field).toHaveValue("");
  await expect(
    writer
      .locator("[data-item-id]")
      .filter({ hasText: "The spicy finale made me snigger." }),
  ).toBeVisible();

  await writer.goto("/account");
  await writer
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  const name = writer.getByLabel("Display name", { exact: true });
  const username = writer.getByLabel("Username", { exact: true });
  await name.fill("Gangbang Fan");
  await username.fill("blocked_writer");
  await writer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    writer.locator(".error").filter({ hasText: refusal("Display name") }),
  ).toBeVisible();
  await expect(name).toHaveValue("Gangbang Fan");
  await expect(username).toHaveValue("blocked_writer");
  await expect(writer.locator(".sidebar-bottom")).toContainText(
    "@blockedwriter",
  );

  const joiner = await member("blockedjoiner", { complete: false });
  const setupName = joiner.getByLabel("Display name", { exact: true });
  const setupUsername = joiner.getByLabel("Username", { exact: true });
  await setupName.fill("Blocked Joiner");
  await setupUsername.fill("joiner_gangbang");
  await joiner
    .getByRole("button", { name: "Join Screenr", exact: true })
    .click();
  await expect(joiner.locator(".error")).toHaveText(refusal("Username"));
  await expect(setupName).toHaveValue("Blocked Joiner");
  await expect(setupUsername).toHaveValue("joiner_gangbang");
  await expect(joiner).toHaveURL(/\/setup/);
});

test("a refused review in a feed entry's review editor shows the server's message and keeps the draft", async ({
  member,
}) => {
  const page = await member("blockedreviewer");
  const viewer = await userId(page);
  const maya = await person("blockedreviewmaya", "Maya Review");
  await friend(viewer, maya);
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name,release_date)
    VALUES('movie:998571','movie',998571,'Harbor Glass','2024-01-01') ON CONFLICT DO NOTHING`,
  );
  const recommendation = await updateTitleActivity(
    maya,
    "movie:998571",
    "recommended",
    true,
  );
  await openWithoutPolling(page, "/");
  const entry = page.locator(`[data-item-id="${recommendation}"]`);
  await entry
    .getByRole("button", { name: "Rate or review", exact: true })
    .click();
  const form = entry.getByRole("form", { name: "Your review" });
  const text = form.getByRole("textbox", { name: "Your review (optional)" });
  await form.getByRole("radio", { name: "4 stars", exact: true }).check();
  await text.fill("One long gangbang of a finale.");
  await form.getByRole("button", { name: "Save review", exact: true }).click();
  await expect(form.locator(".error")).toHaveText(refusal("Review"));
  await expect(text).toHaveValue("One long gangbang of a finale.");
  await expect(
    form.getByRole("radio", { name: "4 stars", exact: true }),
  ).toBeChecked();
  expect(
    (await db.query("SELECT 1 FROM review WHERE owner_id=$1", [viewer]))
      .rowCount,
  ).toBe(0);
});

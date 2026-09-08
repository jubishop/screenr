import { expect, type Page } from "@playwright/test";
import { test, db } from "./database-fixture";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const { createInvitation } = await import("../../src/server/invitations");
const { changeRelationship, updateTitleActivity } =
  await import("../../src/server/social");

async function signup(page: Page) {
  const username = "suggestedviewer";
  const { token } = await createInvitation(null, 1);
  const email = `${username}@example.test`;
  await page.goto(`/join/${token}`);
  await page.getByLabel("Email address").fill(email);
  await page
    .getByRole("button", { name: "Send sign-in code", exact: true })
    .click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  const filename = createHash("sha256").update(email).digest("hex");
  const { otp } = JSON.parse(
    await readFile(`.cache/mail/${filename}.json`, "utf8"),
  );
  await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Display name").fill("Viewer");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByRole("button", { name: "Join Screenr", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
  return (
    await db.query("SELECT user_id FROM profile WHERE username=$1", [username])
  ).rows[0].user_id as string;
}

async function person(username: string, name: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
     VALUES($1,$2,$3,true,now(),now())`,
    [id, name, `${username}@example.test`],
  );
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES($1,$2,$3)",
    [id, username, name],
  );
  return id;
}

async function friend(a: string, b: string) {
  await changeRelationship(a, b, "request");
  await changeRelationship(b, a, "accept");
}

test("People suggestions show mutual friends, send requests, and refresh safely on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn.t match/i.test(message.text())
    )
      errors.push(message.text());
  });
  const viewer = await signup(page);
  await page.goto("/people");
  const section = page.getByRole("region", {
    name: "People you may know",
    exact: true,
  });
  await expect(section.getByText("No friend suggestions yet.")).toBeVisible();

  const benName = "B".repeat(60);
  const ben = await person("suggestedben", benName);
  const cam = await person("suggestedcam", "Cam");
  const danaName = "D".repeat(60);
  const dana = await person("suggesteddana", danaName);
  const ellis = await person("suggestedellis", "Ellis");
  await friend(viewer, ben);
  await friend(cam, viewer);
  await friend(ben, dana);
  await friend(dana, cam);
  await friend(ben, ellis);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:996063','movie',996063,'Private suggestion activity') ON CONFLICT DO NOTHING",
  );
  const privateItem = await updateTitleActivity(
    dana,
    "movie:996063",
    "recommended",
    true,
  );
  const response = await page.goto("/people");
  const initialHTML = await response!.text();
  const rows = section.getByRole("article");
  await expect(rows).toHaveCount(2);
  const danaRow = rows.filter({
    has: page.getByRole("link", {
      name: `${danaName} @suggesteddana`,
      exact: true,
    }),
  });
  await expect(rows.first()).toContainText("@suggesteddana");
  await expect(danaRow).toContainText("Mutual friends:");
  await expect(
    danaRow.getByRole("link", {
      name: `${benName} (@suggestedben)`,
      exact: true,
    }),
  ).toHaveAttribute("href", "/people/suggestedben");
  await expect(
    danaRow.getByRole("link", { name: "Cam (@suggestedcam)", exact: true }),
  ).toHaveAttribute("href", "/people/suggestedcam");
  await expect(rows.last()).toContainText("Mutual friend:");
  const apiResponse = await page.request.get(
    "/api/screenr/screen?path=%2Fpeople",
  );
  expect(apiResponse.status()).toBe(200);
  const payload = await apiResponse.text();
  for (const value of [privateItem, "Private suggestion activity"]) {
    expect(initialHTML).not.toContain(value);
    expect(payload).not.toContain(value);
  }
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await section.scrollIntoViewIfNeeded();
    await expect(
      danaRow.getByRole("button", { name: "Send friend request" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.cache/people-suggestions-${width}.png`,
      fullPage: true,
    });
  }
  await danaRow
    .getByRole("link", { name: `${danaName} @suggesteddana`, exact: true })
    .click();
  await expect(page).toHaveURL(/\/people\/suggesteddana$/);
  await expect(
    page.getByText("You’ll see their activity after you become friends."),
  ).toBeVisible();
  await expect(page.getByText("Private suggestion activity")).toHaveCount(0);
  await page.goto("/people");
  await danaRow
    .getByRole("button", { name: "Send friend request", exact: true })
    .click();
  await expect(danaRow).toHaveCount(0);
  const pending = page.getByRole("article").filter({
    has: page.getByRole("link", {
      name: `${danaName} @suggesteddana`,
      exact: true,
    }),
  });
  await expect(pending).toContainText("Request sent");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await pending.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(danaRow).toHaveCount(1);
  await danaRow
    .getByRole("button", { name: "Send friend request", exact: true })
    .click();
  await expect(pending).toContainText("Request sent");
  await changeRelationship(dana, viewer, "accept");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    pending.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeVisible();
  await expect(danaRow).toHaveCount(0);
  await pending.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(danaRow).toHaveCount(1);
  await changeRelationship(ben, dana, "remove");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    danaRow.getByRole("link", {
      name: `${benName} (@suggestedben)`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(danaRow).toContainText("Mutual friend: Cam");
  await changeRelationship(dana, viewer, "block");
  await expect(danaRow).toHaveCount(0);
  await changeRelationship(viewer, ellis, "block");
  await expect(section.getByText("No friend suggestions yet.")).toBeVisible();
  expect(errors).toEqual([]);
});

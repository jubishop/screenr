import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";
import { db } from "./database-fixture";
import { browserConfig } from "../../scripts/browser-config";

// Where the file transport delivers an address's sign-in code.
const codeFile = (email: string) =>
  `.cache/mail/${createHash("sha256").update(email).digest("hex")}.json`;

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status()).toBe(200);
  return response.json();
}

test("a member confirms it's them with an email code, deletes their account, and cannot sign back in", async ({
  member,
}) => {
  const departing = await member("deletingmember");
  const friend = await member("deletionfriend");
  await prepareFriendship(departing, friend);
  const email = "deletingmember.browser@example.test";
  const id = await userId(departing);
  // The departing member's comment on a friend's post has the friend's reply.
  const { id: postId } = await post(friend, "discussion-post", {
    body: "Movie night on Friday?",
    spoiler: false,
  });
  const { id: commentId } = await post(departing, "comment", {
    conversation: postId,
    body: "Only if we watch something scary.",
    spoiler: false,
  });
  await post(friend, "comment", {
    conversation: postId,
    body: "Deal, bring snacks.",
    spoiler: false,
    replyTo: commentId,
  });

  await departing.goto("/account");
  const start = departing.getByRole("button", {
    name: "Delete account",
    exact: true,
  });
  await start.click();
  const verify = departing.getByRole("group", {
    name: `First, confirm it’s you. We’ll email a sign-in code to ${email}.`,
  });
  // Cancel takes focus and returns it to Delete account.
  await expect(verify.getByRole("button", { name: "Cancel" })).toBeFocused();
  await verify.getByRole("button", { name: "Cancel" }).click();
  await expect(start).toBeFocused();

  await start.click();
  await rm(codeFile(email), { force: true });
  await departing
    .getByRole("button", { name: "Email me a code", exact: true })
    .click();
  const code = departing.getByLabel("Sign-in code", { exact: true });
  await expect(code).toBeFocused();
  const { otp } = JSON.parse(await readFile(codeFile(email), "utf8"));
  // A wrong code keeps the step open with its error.
  await code.fill(otp === "000000" ? "111111" : "000000");
  const confirmCode = departing.getByRole("button", {
    name: "Confirm code",
    exact: true,
  });
  await confirmCode.click();
  await expect(
    departing
      .getByRole("region", { name: "Delete account" })
      .getByRole("alert"),
  ).toHaveText("Invalid OTP");
  await expect(confirmCode).toHaveAccessibleDescription("Invalid OTP");
  await code.fill(otp);
  await confirmCode.click();
  const confirmation = departing.getByRole("group", {
    name: "Delete your Screenr account permanently? This can’t be undone.",
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await confirmation
    .getByRole("button", { name: "Delete account", exact: true })
    .click();

  // The member ends signed out on the sign-in page.
  await expect(departing).toHaveURL(/\/login\?deleted=1$/);
  await expect(
    departing.getByText("Your Screenr account was deleted.", { exact: true }),
  ).toBeVisible();
  expect(
    (await db.query('SELECT 1 FROM "user" WHERE id=$1', [id])).rowCount,
  ).toBe(0);
  await departing.goto("/account");
  await expect(departing).toHaveURL(/\/login\?next=%2Faccount$/);

  // Without a new invitation, the address gets no code and cannot sign in.
  await rm(codeFile(email), { force: true });
  await departing.getByLabel("Email address").fill(email);
  await departing
    .getByRole("button", { name: "Send sign-in code", exact: true })
    .click();
  await expect(
    departing.getByLabel("Sign-in code", { exact: true }),
  ).toBeVisible();
  await expect(stat(codeFile(email))).rejects.toThrow();
  await departing.getByLabel("Sign-in code", { exact: true }).fill(otp);
  await departing.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(departing.locator("p.error[role=alert]")).toHaveText(
    "Invalid OTP",
  );
  await expect(departing).toHaveURL(/\/login/);

  // The friend's post keeps the reply under a removed placeholder.
  await friend.goto("/");
  const placeholder = friend.getByRole("article", { name: "Comment removed" });
  await expect(placeholder).toHaveText(/^Comment removed/);
  await expect(placeholder).not.toHaveText(/scary|deletingmember/);
  await friend.getByRole("button", { name: "View 1 reply" }).click();
  await expect(
    friend
      .locator("article.comment")
      .filter({ hasText: "Deal, bring snacks." }),
  ).toBeVisible();
});

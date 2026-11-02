import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";
import { db } from "./database-fixture";
import { browserConfig } from "../../scripts/browser-config";
import { openWithoutPolling, refreshOnReturn } from "./refresh-helpers";
import {
  countRequests,
  expectPendingWhileLeaving,
  stayOnPage,
} from "./page-loads";

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
  const departing = await member("deletingmember", {
    serviceWorkers: "block",
  });
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
    departing.getByRole("region", { name: "Delete account" }).locator(".error"),
  ).toHaveText("Invalid OTP");
  await code.fill(otp);
  await confirmCode.click();
  const confirmation = departing.getByRole("group", {
    name: "Delete your Screenr account permanently? This can’t be undone.",
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  // The action stays pending until sign-in replaces the page, so a second
  // press can't send another deletion, and the page reads nothing more: its
  // rejected read would open sign-in without the result.
  const deletions = countRequests(departing, "/api/screenr/delete-account");
  const next = await stayOnPage(departing, "/login");
  const remove = confirmation.getByRole("button", {
    name: "Delete account",
    exact: true,
  });
  await remove.click();
  expect(await next.url).toBe(`${browserConfig.baseURL}/login?deleted=1`);
  const reads = countRequests(departing, "/api/screenr/screen");
  await expectPendingWhileLeaving(departing, remove);
  await departing.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(remove).toHaveAttribute("aria-disabled", "true");
  expect(reads()).toBe(0);
  await departing.goto(await next.url);

  // The member ends signed out on the sign-in page.
  await expect(
    departing.getByText("Your Screenr account was deleted.", { exact: true }),
  ).toBeVisible();
  // The address drops the result once it shows, so a reload omits it.
  await expect(departing).toHaveURL(/\/login$/);
  await departing.reload();
  await expect(departing.getByLabel("Email address")).toBeEditable();
  await expect(
    departing.getByText("Your Screenr account was deleted.", { exact: true }),
  ).toHaveCount(0);
  expect(deletions()).toBe(1);
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
  await expect(departing.locator("p.error")).toHaveText("Invalid OTP");
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

test("a failed read keeps the deletion step, the sign-in methods, and focus, with their actions waiting for the next read", async ({
  member,
}) => {
  const departing = await member("retrydeletion");
  const email = "retrydeletion.browser@example.test";
  const id = await userId(departing);
  // Each read is one the test starts, so the failure lasts until it reads
  // again.
  await openWithoutPolling(departing, "/account");
  const failure = departing.getByRole("main").locator(".error").first();
  // Returning to the page reads it once; this read fails.
  async function failOneRead() {
    await departing.route(
      "**/api/screenr/screen?**",
      (route) => route.abort("failed"),
      { times: 1 },
    );
    await refreshOnReturn(departing);
    await expect(failure).toContainText("Could not reach Screenr.");
  }
  async function readAgain() {
    await refreshOnReturn(departing);
    await expect(failure).toHaveCount(0);
  }
  let signIns = 0;
  departing.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/sign-in/email-otp")
      signIns++;
  });
  const methods = departing.getByRole("region", { name: "Sign-in methods" });
  const signOut = methods.getByRole("button", { name: "Sign out" });

  await departing
    .getByRole("button", { name: "Delete account", exact: true })
    .click();
  await rm(codeFile(email), { force: true });
  await departing
    .getByRole("button", { name: "Email me a code", exact: true })
    .click();
  const code = departing.getByLabel("Sign-in code", { exact: true });
  await expect(code).toBeFocused();
  const { otp } = JSON.parse(await readFile(codeFile(email), "utf8"));
  await code.fill(otp.slice(0, 3));
  const confirmCode = departing.getByRole("button", {
    name: "Confirm code",
    exact: true,
  });

  // The member switches to Mail, and the read on their return fails. The
  // code step keeps the typed digits and focus, and Confirm code waits.
  await failOneRead();
  await expect(code).toBeFocused();
  await expect(code).toHaveValue(otp.slice(0, 3));
  await expect(confirmCode).toHaveAttribute("aria-disabled", "true");
  await expect(methods).toBeVisible();
  await expect(signOut).toHaveAttribute("aria-disabled", "true");
  await code.pressSequentially(otp.slice(3));
  await code.press("Enter");
  await readAgain();
  expect(signIns).toBe(0);
  await expect(confirmCode).toHaveAttribute("aria-disabled", "false");
  await expect(signOut).toHaveAttribute("aria-disabled", "false");
  await expect(code).toBeFocused();
  await code.press("Enter");

  // A failed read after the code keeps the final confirmation. Its Cancel
  // keeps focus, and Delete account waits for the next read.
  const confirmation = departing.getByRole("group", {
    name: "Delete your Screenr account permanently? This can’t be undone.",
  });
  const cancel = confirmation.getByRole("button", { name: "Cancel" });
  const confirmDelete = confirmation.getByRole("button", {
    name: "Delete account",
    exact: true,
  });
  await expect(cancel).toBeFocused();
  await failOneRead();
  await expect(cancel).toBeFocused();
  await expect(confirmDelete).toHaveAttribute("aria-disabled", "true");
  await expect(cancel).toHaveAttribute("aria-disabled", "false");
  await readAgain();
  await expect(cancel).toBeFocused();
  // The confirmed code still deletes the account, with no second code.
  await confirmDelete.click();
  await expect(
    departing.getByText("Your Screenr account was deleted.", { exact: true }),
  ).toBeVisible();
  expect(
    (await db.query('SELECT 1 FROM "user" WHERE id=$1', [id])).rowCount,
  ).toBe(0);
});

import { expect, type Page, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { monitorErrors } from "./monitored-test";
const { createInvitation } = await import("../../src/server/invitations");

// Use these complete UI journeys only when signup or friendship is under test.
export async function join(
  browser: Browser,
  name: string,
  options: {
    complete?: boolean;
    token?: string;
    hasTouch?: boolean;
    displayName?: string;
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
    hasTouch: options.hasTouch,
  });
  const page = await context.newPage();
  await page.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Trailer player fixture" }),
  );
  monitorErrors(page);
  const token = options.token ?? (await createInvitation(null, 1)).token;
  const email = `${name}.browser@example.test`;
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
  if (options.complete === false) {
    await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
    return page;
  }
  await page.getByLabel("Display name").fill(options.displayName ?? name);
  await page.getByLabel("Username", { exact: true }).fill(name);
  const [completed] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/screenr/setup") &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Join Screenr", exact: true }).click(),
  ]);
  if (completed.status() !== 200) throw new Error(await completed.text());
  expect(completed.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
  return page;
}

export async function befriend(a: Page, b: Page, bName: string, aName: string) {
  await a.goto(`/people/${bName}`);
  await a
    .getByRole("button", { name: "Send friend request", exact: true })
    .click();
  await expect(
    a.getByRole("button", { name: "Cancel friend request", exact: true }),
  ).toBeVisible();
  await b.goto(`/people/${aName}`);
  await b
    .getByRole("button", { name: "Accept friend request", exact: true })
    .click();
  await expect(
    b.getByRole("button", { name: "Unfriend", exact: true }),
  ).toBeVisible();
}

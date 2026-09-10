import { expect, type Page } from "@playwright/test";
import { test } from "./member-fixture";

const screenRead = "**/api/screenr/screen?**";

async function refresh(page: Page) {
  const response = page.waitForResponse((response) =>
    response.url().includes("/api/screenr/screen?"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await (await response).finished();
}

async function failRefresh(page: Page) {
  await page.route(screenRead, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "View refresh unavailable" },
    }),
  );
  await refresh(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "View refresh unavailable",
  );
}

async function recover(page: Page) {
  await page.unroute(screenRead);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("View refresh unavailable")).toHaveCount(0);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("People retains the username draft and focus on refresh, and restores the draft after read recovery", async ({
  member,
}) => {
  const page = await member("peopledraft");
  await page.goto("/people");
  const input = page.getByLabel("Exact username");
  await input.fill("Some_Friend");
  await refresh(page);
  await expect(input).toHaveValue("Some_Friend");
  await expect(input).toBeFocused();
  await failRefresh(page);
  await expect(input).toHaveCount(0);
  await recover(page);
  await expect(input).toHaveValue("Some_Friend");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/people\/some_friend$/);
});

test("invitations retain the signup limit through reads and disable creation while saving", async ({
  member,
}) => {
  const page = await member("invitelimitdraft");
  await page.goto("/invites");
  const limit = page.getByLabel("Maximum signups");
  const create = page.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  await limit.selectOption("7");
  await limit.focus();
  await refresh(page);
  await expect(limit).toHaveValue("7");
  await expect(limit).toBeFocused();
  await failRefresh(page);
  await expect(limit).toHaveCount(0);
  await recover(page);
  await expect(limit).toHaveValue("7");

  const started = deferred();
  const release = deferred();
  let submitted: unknown;
  await page.route("**/api/screenr/invite", async (route) => {
    submitted = route.request().postDataJSON();
    started.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await create.click();
    await started.promise;
    await expect(create).toBeDisabled();
    await refresh(page);
    await expect(create).toBeDisabled();
  } finally {
    release.resolve();
  }
  await expect(page.getByText("0 of 7 signups", { exact: true })).toBeVisible();
  expect(submitted).toEqual({ limit: 7 });
  await expect(limit).toHaveValue("7");
  await expect(create).toBeEnabled();
});

test("account linking and sign-out keep pending states and errors across read recovery", async ({
  member,
}) => {
  const page = await member("accountpending");
  await page.goto("/account");
  const connect = page.getByRole("button", {
    name: "Connect Google",
    exact: true,
  });
  const connecting = page.getByRole("button", {
    name: "Connecting…",
    exact: true,
  });
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  const started = deferred();
  const release = deferred();
  await page.route("**/api/auth/link-social", async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ status: 503, json: { message: "Link unavailable" } });
  });
  try {
    await connect.click();
    await started.promise;
    await expect(connecting).toBeDisabled();
    await expect(signOut).toBeDisabled();
    await failRefresh(page);
    await expect(signOut).toHaveCount(0);
    await recover(page);
    await expect(connecting).toBeDisabled();
    await expect(signOut).toBeDisabled();
  } finally {
    release.resolve();
  }
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Link unavailable",
  );
  await expect(connect).toBeEnabled();
  await expect(signOut).toBeEnabled();
  await failRefresh(page);
  await recover(page);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Link unavailable",
  );
  await page.unroute("**/api/auth/link-social");
  await page.route("**/api/auth/link-social", (route) =>
    route.fulfill({ json: {} }),
  );
  await connect.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Google sign-in did not start. Please try again.",
  );
  await expect(connect).toBeEnabled();

  const signingOut = deferred();
  const finishSignOut = deferred();
  await page.route("**/api/auth/sign-out", async (route) => {
    signingOut.resolve();
    await finishSignOut.promise;
    await route.fulfill({
      status: 503,
      json: { message: "Sign-out unavailable" },
    });
  });
  try {
    await signOut.click();
    await signingOut.promise;
    await expect(signOut).toBeDisabled();
    await expect(connect).toBeDisabled();
    await failRefresh(page);
    await recover(page);
    await expect(signOut).toBeDisabled();
    await expect(connect).toBeDisabled();
  } finally {
    finishSignOut.resolve();
  }
  await expect(
    page
      .getByRole("main")
      .getByRole("alert")
      .filter({ hasText: "Sign-out unavailable" }),
  ).toBeVisible();
  await expect(signOut).toBeEnabled();
  await expect(connect).toBeEnabled();
  await refresh(page);
  await expect(
    page
      .getByRole("main")
      .getByRole("alert")
      .filter({ hasText: "Sign-out unavailable" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
});

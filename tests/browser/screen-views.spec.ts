import { expect, type Page } from "@playwright/test";
import { test } from "./monitored-test";
import { expectErrorBeside, failAction, press } from "./action-errors";

const screenRead = "**/api/screenr/screen?**";
const unavailable =
  "Screenr is temporarily unavailable. Please try again in a moment.";

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

test("proxy error pages show a retryable message instead of parser errors", async ({
  member,
}) => {
  const page = await member("proxyerrors");
  await page.goto("/invites");
  const main = page.getByRole("main");
  const create = page.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  await expect(create).toBeEnabled();

  await page.route("**/api/screenr/invite", (route) =>
    route.fulfill({ status: 502, body: "" }),
  );
  await create.click();
  await expect(main.getByRole("alert")).toContainText(unavailable);
  await expect(create).toBeEnabled();
  await page.unroute("**/api/screenr/invite");
  await create.click();
  await expect(page.getByText("0 of 1 signups", { exact: true })).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);

  await page.route(screenRead, (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<!doctype html><title>502 Bad Gateway</title><h1>Bad Gateway</h1>",
    }),
  );
  await refresh(page);
  await expect(main.getByRole("alert")).toContainText(unavailable);
  await expect(main).not.toContainText(/Unexpected|JSON/);
  await expect(create).toHaveCount(0);
  await page.unroute(screenRead);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(main.getByRole("alert")).toHaveCount(0);
  await expect(create).toBeEnabled();
});

test("invitation and sign-out failures show their errors beside the control", async ({
  member,
}) => {
  const page = await member("actionerrorplacement");
  await page.goto("/invites");
  const main = page.getByRole("main");
  const create = page.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await failAction(page, "invite", "Invitations unavailable.");
  await press(create);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    await expectErrorBeside(page, {
      container: main,
      failed: create,
      controls: [create, page.getByLabel("Maximum signups")],
      message: "Invitations unavailable.",
      screenshot: "action-error-invite",
    });
  }
  await page.unroute("**/api/screenr/invite");
  await press(create);
  const card = page.locator(".invite-card");
  await expect(card).toContainText("0 of 1 signups");
  await expect(main.getByRole("alert")).toHaveCount(0);
  // A failed Revoke keeps its confirmation open with the message.
  const confirmation = card.getByRole("group", {
    name: /^Revoke this invitation\?/,
  });
  const revoke = confirmation.getByRole("button", {
    name: "Revoke",
    exact: true,
  });
  await failAction(page, "revoke-invite", "Revoking unavailable.");
  await press(card.getByRole("button", { name: "Revoke", exact: true }));
  await press(revoke);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    await expectErrorBeside(page, {
      container: confirmation,
      failed: revoke,
      controls: [
        revoke,
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ],
      message: "Revoking unavailable.",
      screenshot: "action-error-revoke",
    });
  }

  await page.goto("/account");
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  await expect(signOut).toBeEnabled();
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ status: 503, json: { message: "Sign-out unavailable." } }),
  );
  await press(signOut);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    await expectErrorBeside(page, {
      container: page.getByRole("region", { name: "Sign-in methods" }),
      failed: signOut,
      controls: [signOut],
      message: "Sign-out unavailable.",
      screenshot: "action-error-sign-out",
    });
  }
});

test("a stalled write times out and re-enables its controls", async ({
  member,
}) => {
  const page = await member("stalledwrite");
  await page.clock.install();
  await page.goto("/invites");
  const create = page.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  await expect(create).toBeEnabled();
  // Paused timers stop polling. The write aborts any active read, so the
  // jump below can expire only the write's own deadline.
  await page.clock.pauseAt(Date.now() + 1000);
  const started = deferred();
  await page.route("**/api/screenr/invite", () => started.resolve());
  await create.click();
  await started.promise;
  await expect(create).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "The request timed out. Please try again.",
  );
  await expect(create).toBeEnabled();

  await page.unroute("**/api/screenr/invite");
  await page.clock.resume();
  await create.click();
  await expect(page.getByText("0 of 1 signups", { exact: true })).toBeVisible();
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

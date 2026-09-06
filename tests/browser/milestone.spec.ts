import { test, expect, type Page, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const browserErrors: string[] = [];

function monitorErrors(page: Page) {
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn.t match/i.test(message.text())
    )
      browserErrors.push(message.text());
  });
}
test.beforeEach(({ page }) => {
  browserErrors.length = 0;
  monitorErrors(page);
});
test.afterEach(() => {
  expect(browserErrors).toEqual([]);
});

async function join(
  browser: Browser,
  name: string,
  options: { complete?: boolean; token?: string } = {},
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  monitorErrors(page);
  const token =
    options.token ??
    (await readFile(".cache/browser-invite.txt", "utf8")).trim();
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
  await page.getByLabel("Display name").fill(name);
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
async function befriend(a: Page, b: Page, bName: string, aName: string) {
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

test("invited friends discover, save, and share a persistent conversation with live access enforcement", async ({
  browser,
}) => {
  const alice = await join(browser, "alice"),
    ben = await join(browser, "ben"),
    cam = await join(browser, "cam"),
    outsider = await join(browser, "outsider");
  await befriend(alice, ben, "ben", "alice");
  await befriend(alice, cam, "cam", "alice");
  await alice.goto("/search");
  await alice.getByLabel("Movie or show title").fill("Lantern");
  await alice.getByRole("button", { name: "Search", exact: true }).click();
  await alice
    .getByRole("heading", { name: "The Lantern Room", exact: true })
    .click();
  await alice
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  await expect(
    alice.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
  await alice.getByRole("link", { name: /Open conversation/ }).click();
  await expect(alice).toHaveURL(/\/conversations\/[0-9a-f-]+$/);
  const conversationURL = alice.url();
  const conversationId = conversationURL.split("/").at(-1)!;
  await ben.goto("/");
  await expect(
    ben.getByText("The Lantern Room", { exact: true }),
  ).toBeVisible();
  await ben
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await ben.goto("/titles/movie/987654");
  await expect(
    ben
      .locator(".title-hero")
      .getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  const original = ben.locator(".activity-card").filter({ hasText: "alice" });
  await original.getByRole("link", { name: /Open conversation/ }).click();
  await expect(ben).toHaveURL(conversationURL);
  await ben
    .getByLabel("Add your reply")
    .fill("This looks like our kind of movie.");
  await ben.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    ben.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await expect(
    alice.getByRole("button", { name: /New replies/ }),
  ).toBeVisible();
  await expect(
    alice.getByText("This looks like our kind of movie.", { exact: true }),
  ).not.toBeVisible();
  await alice.getByRole("button", { name: /New replies/ }).click();
  await expect(
    alice.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await alice.getByRole("button", { name: "Reply", exact: true }).click();
  await alice.getByLabel("Add your reply").fill("The ending surprised me.");
  await alice.getByLabel("Contains spoilers", { exact: true }).check();
  await alice.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(ben.getByRole("button", { name: /New replies/ })).toBeVisible();
  await ben.getByRole("button", { name: /New replies/ }).click();
  await expect(
    ben.getByText("The ending surprised me.", { exact: true }),
  ).not.toBeVisible();
  await ben
    .getByRole("button", {
      name: "Contains spoilers · Reveal comment",
      exact: true,
    })
    .click();
  await expect(
    ben.getByText("The ending surprised me.", { exact: true }),
  ).toBeVisible();
  await ben.reload();
  await expect(
    ben.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  const denied = await outsider.request.get(
    `/api/screenr/screen?path=/conversations/${conversationId}`,
  );
  expect(denied.status()).toBe(404);
  const deniedWrite = await outsider.request.post("/api/screenr/comment", {
    headers: { Origin: "http://localhost:3055" },
    data: {
      conversation: conversationId,
      body: "Unauthorized",
      spoiler: false,
    },
  });
  expect(deniedWrite.status()).toBe(404);
  await outsider.goto(conversationURL);
  await expect(
    outsider.getByText("Conversation not found.", { exact: false }),
  ).toBeVisible();
  await expect(
    outsider.getByText("This looks like our kind of movie.", { exact: true }),
  ).not.toBeVisible();
  await cam.goto(conversationURL);
  await expect(
    cam.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await alice.goto("/people/ben");
  await alice.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(
    ben.getByText("Conversation not found.", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    cam.getByText("This looks like our kind of movie.", { exact: true }),
  ).not.toBeVisible({ timeout: 10000 });
  await befriend(alice, ben, "ben", "alice");
  await ben.goto(conversationURL);
  await expect(
    ben.getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await ben.goto("/people/cam");
  await ben.getByRole("button", { name: "Block", exact: true }).click();
  await cam.getByLabel("Add your reply").fill("Cam’s view of the film.");
  await cam.getByRole("button", { name: "Post reply", exact: true }).click();
  await ben.goto(conversationURL);
  await expect(
    ben.getByText("Cam’s view of the film.", { exact: true }),
  ).not.toBeVisible();
  await alice.goto(conversationURL);
  await expect(
    alice.getByText("Cam’s view of the film.", { exact: true }),
  ).toBeVisible();
  let firstRoot = "";
  for (let index = 0; index < 12; index++) {
    const result = await alice.request.post("/api/screenr/comment", {
      headers: { Origin: "http://localhost:3055" },
      data: {
        conversation: conversationId,
        body: `Reading position marker ${index}`,
        spoiler: false,
      },
    });
    expect(result.status()).toBe(200);
    if (index === 0) firstRoot = (await result.json()).id;
  }
  await alice.reload();
  const anchor = alice.getByText("Reading position marker 8", { exact: true });
  await anchor.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const inserted = await ben.request.post("/api/screenr/comment", {
    headers: { Origin: "http://localhost:3055" },
    data: {
      conversation: conversationId,
      body: "A new nested reply above the reading position",
      spoiler: false,
      replyTo: firstRoot,
    },
  });
  expect(inserted.status()).toBe(200);
  await expect(
    alice.getByRole("button", { name: /New replies/ }),
  ).toBeVisible();
  const before = await anchor.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await alice.getByRole("button", { name: /New replies/ }).click();
  await expect(
    alice.getByText("A new nested reply above the reading position", {
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs(
        (await anchor.evaluate(
          (element) => element.getBoundingClientRect().top,
        )) - before,
      ),
    )
    .toBeLessThan(3);
  await alice.goto("/invites");
  await alice.getByLabel("Maximum signups").selectOption("2");
  await alice
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(alice.getByLabel("Invitation link")).toHaveValue(/\/join\//);
  await alice.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(alice.getByText("Revoked", { exact: true })).toBeVisible();
  await ben.goto("/");
  await ben.screenshot({ path: ".cache/screenr-mobile.png", fullPage: true });
  await alice.setViewportSize({ width: 1400, height: 1000 });
  await alice.goto("/");
  await alice.screenshot({
    path: ".cache/screenr-desktop.png",
    fullPage: true,
  });
  for (const page of [alice, ben, cam, outsider]) await page.context().close();
});

test("server-rendered signup controls wait for their event handlers", async ({
  page,
}) => {
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scriptsReady;
    await route.continue();
  });
  try {
    await page.goto("/login", { waitUntil: "commit" });
    await expect(page.getByLabel("Email address")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Send sign-in code", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseScripts();
  }
  await expect(page.getByLabel("Email address")).toBeEditable();
});

async function useTestGoogle(page: Page) {
  // The harness owns the provider boundary. Never fall through to real Google
  // when running with test credentials.
  await page.route("https://accounts.google.com/**", (route) => route.abort());
}

async function approveGoogle(page: Page, email: string) {
  await expect(
    page.getByRole("heading", { name: "Test identity provider" }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

async function nextAccountRefresh(page: Page) {
  await page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/screenr/screen" &&
      url.searchParams.get("path") === "/account"
    );
  });
}

test("Google signup shows its connection and an email code returns to the same profile", async ({
  page,
}) => {
  await useTestGoogle(page);
  const token = (await readFile(".cache/browser-invite.txt", "utf8")).trim();
  const email = "googlefirst.browser@example.test";
  await page.goto(`/join/${token}`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await approveGoogle(page, email);
  await page.getByLabel("Display name").fill("Google First");
  await page.getByLabel("Username", { exact: true }).fill("googlefirst");
  await page.getByRole("button", { name: "Join Screenr", exact: true }).click();
  await expect(page.getByText("@googlefirst", { exact: true })).toBeVisible();
  await page.goto("/account");
  await expect(page.getByRole("status")).toHaveText("Google connected.");
  await expect(
    page.getByRole("button", { name: "Connect Google", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Google connected.");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address").fill(email);
  await page
    .getByRole("button", { name: "Send sign-in code", exact: true })
    .click();
  const filename = createHash("sha256").update(email).digest("hex");
  await expect(page.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  const { otp } = JSON.parse(
    await readFile(`.cache/mail/${filename}.json`, "utf8"),
  );
  const invalid = String((Number(otp) + 1) % 1_000_000).padStart(6, "0");
  await page.getByLabel("Sign-in code", { exact: true }).fill(invalid);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /invalid|incorrect/i,
  );
  await page.getByLabel("Sign-in code", { exact: true }).fill(otp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("@googlefirst", { exact: true })).toBeVisible();
  await page.goto("/account");
  await expect(page.getByRole("status")).toHaveText("Google connected.");
});

test("email members can recover from linking failures, connect Google, and sign back into their profile", async ({
  browser,
}) => {
  const page = await join(browser, "linkflow");
  await page.setViewportSize({ width: 1280, height: 900 });
  await useTestGoogle(page);
  await page.goto("/account");
  const connect = page.getByRole("button", {
    name: "Connect Google",
    exact: true,
  });
  await expect(connect).toBeEnabled();
  const failure = async (route: import("@playwright/test").Route) => {
    await route.fulfill({
      status: 503,
      json: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Google is temporarily unavailable.",
      },
    });
  };
  await page.route("**/api/auth/link-social", failure);
  await connect.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Google is temporarily unavailable.",
  );
  await expect(connect).toBeEnabled();
  await nextAccountRefresh(page);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Google is temporarily unavailable.",
  );
  await page.unroute("**/api/auth/link-social", failure);

  await connect.click();
  await expect(
    page.getByRole("heading", { name: "Test identity provider" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Google connection was canceled. You can try again.",
  );
  await nextAccountRefresh(page);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Google connection was canceled. You can try again.",
  );

  await connect.click();
  await approveGoogle(page, "different.browser@example.test");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Choose the Google account with the same email address as your Screenr account.",
  );
  await expect(connect).toBeEnabled();
  await expect(page.getByText("@linkflow", { exact: true })).toBeVisible();

  await connect.click();
  await approveGoogle(page, "linkflow.browser@example.test");
  await expect(page.getByRole("status")).toHaveText("Google connected.");
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Google connected.");

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await approveGoogle(page, "linkflow.browser@example.test");
  await expect(page.getByText("@linkflow", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
  await page.context().close();
});

for (const complete of [true, false]) {
  test(`sign-out failures remain visible and retryable from ${complete ? "Account" : "Setup"}`, async ({
    browser,
  }) => {
    const page = await join(
      browser,
      complete ? "signoutmember" : "signoutpending",
      { complete },
    );
    if (complete) await page.goto("/account");
    const startURL = page.url();
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    const alert = page.getByRole("main").getByRole("alert");
    for (const transportFailure of [false, true]) {
      await page.route("**/api/auth/sign-out", (route) =>
        transportFailure
          ? route.abort("failed")
          : route.fulfill({
              status: 503,
              json: { message: "Sign-out temporarily unavailable." },
            }),
      );
      await signOut.click();
      await expect(alert).toBeVisible();
      await expect(page).toHaveURL(startURL);
      await expect(signOut).toBeEnabled();
      if (complete) {
        await nextAccountRefresh(page);
        await expect(alert).toBeVisible();
      }
      await page.unroute("**/api/auth/sign-out");
    }
    await signOut.click();
    await expect(page).toHaveURL(/\/login$/);
    expect(
      await (await page.request.get("/api/auth/get-session")).json(),
    ).toBeNull();
    await page.goto(complete ? "/account" : "/setup");
    await expect(page).toHaveURL(/\/login$/);
    await page.context().close();
  });
}

test("reply drafts survive failed refreshes without retaining conversation content", async ({
  browser,
}) => {
  const page = await join(browser, "draftrefresh");
  const activity = await page.request.post("/api/screenr/activity", {
    headers: { Origin: "http://localhost:3055" },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await activity.json();
  await page.request.post("/api/screenr/comment", {
    headers: { Origin: "http://localhost:3055" },
    data: {
      conversation: id,
      body: "Visible conversation content",
      spoiler: false,
    },
  });
  await page.goto(`/conversations/${id}`);
  const draft = page.getByLabel("Add your reply");
  await draft.fill("Keep this unsent reply");
  await page.getByLabel("Contains spoilers", { exact: true }).check();
  await page.route("**/api/screenr/screen?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Refresh unavailable." } }),
  );
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Refresh unavailable.",
  );
  await expect(
    page.getByText("Visible conversation content", { exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/screenr/screen?**");
  await expect(draft).toHaveValue("Keep this unsent reply");
  await expect(
    page.getByLabel("Contains spoilers", { exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(draft).toHaveValue("");
  await page.getByRole("button", { name: /Reveal comment/ }).click();
  await expect(
    page.getByText("Keep this unsent reply", { exact: true }),
  ).toBeVisible();
  await page.context().close();
});

test("posting preserves later typing and background refresh preserves action errors", async ({
  browser,
}) => {
  const page = await join(browser, "draftposting");
  const response = await page.request.post("/api/screenr/activity", {
    headers: { Origin: "http://localhost:3055" },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await response.json();
  await page.goto(`/conversations/${id}`);
  const draft = page.getByLabel("Add your reply");
  await draft.fill("First submitted reply");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/screenr/comment",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.getByRole("button", { name: "Post reply", exact: true }).click();
    await draft.fill("Second unsent reply");
  } finally {
    release();
  }
  await expect(
    page.getByText("First submitted reply", { exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue("Second unsent reply");
  await page.goto("/search");
  await page.route("**/api/screenr/search?**", (route) =>
    route.fulfill({
      status: 502,
      json: { error: "Catalog temporarily unavailable." },
    }),
  );
  await page.getByLabel("Movie or show title").fill("Lantern");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("Catalog temporarily unavailable.");
  await nextAccountRefreshForPath(page, "/search");
  await expect(alert).toContainText("Catalog temporarily unavailable.");
  await page.unroute("**/api/screenr/search?**");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await page.context().close();
});

async function nextAccountRefreshForPath(page: Page, path: string) {
  await page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/screenr/screen" &&
      url.searchParams.get("path") === path
    );
  });
}

test("Google sign-in recovers from transport failure and an empty redirect", async ({
  page,
}) => {
  await useTestGoogle(page);
  const token = (await readFile(".cache/browser-invite.txt", "utf8")).trim();
  await page.goto(`/join/${token}`);
  const google = page.getByRole("button", { name: "Continue with Google" });
  for (const transportFailure of [true, false]) {
    await page.route("**/api/auth/sign-in/social", (route) =>
      transportFailure
        ? route.abort("failed")
        : route.fulfill({ status: 200, json: {} }),
    );
    await google.click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(google).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Send sign-in code", exact: true }),
    ).toBeEnabled();
    await page.unroute("**/api/auth/sign-in/social");
  }
  await google.click();
  await approveGoogle(page, "googleretry.browser@example.test");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
});

test("friend profile saves display the viewer's current saved state", async ({
  browser,
}) => {
  const owner = await join(browser, "profileowner");
  const viewer = await join(browser, "profileviewer");
  await befriend(owner, viewer, "profileviewer", "profileowner");
  for (const page of [owner, viewer]) {
    await page.request.post("/api/screenr/activity", {
      headers: { Origin: "http://localhost:3055" },
      data: { title: "movie:987654", field: "recommended", value: true },
    });
  }
  await viewer.goto("/people/profileowner");
  await viewer
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(
    viewer.getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  await viewer.reload();
  await expect(
    viewer.getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  await owner.goto("/people/profileviewer");
  await expect(
    owner.getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  await owner.context().close();
  await viewer.context().close();
});

test("a signed-out pending member can finish with one visit to a replacement invitation", async ({
  browser,
}) => {
  const owner = await join(browser, "replacementowner");
  const post = (action: string, data: unknown) =>
    owner.request.post(`/api/screenr/${action}`, {
      headers: { Origin: "http://localhost:3055" },
      data,
    });
  const original = await (await post("invite", { limit: 1 })).json();
  const pending = await join(browser, "replacementpending", {
    token: original.token,
    complete: false,
  });
  await post("revoke-invite", { id: original.id });
  await pending.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(pending).toHaveURL(/\/login$/);
  const replacement = await (await post("invite", { limit: 1 })).json();
  await pending.goto(`/join/${replacement.token}`);
  const email = "replacementpending.browser@example.test";
  await pending.getByLabel("Email address").fill(email);
  await pending
    .getByRole("button", { name: "Send sign-in code", exact: true })
    .click();
  await expect(
    pending.getByLabel("Sign-in code", { exact: true }),
  ).toBeVisible();
  const filename = createHash("sha256").update(email).digest("hex");
  const { otp } = JSON.parse(
    await readFile(`.cache/mail/${filename}.json`, "utf8"),
  );
  await pending.getByLabel("Sign-in code", { exact: true }).fill(otp);
  await pending.getByRole("button", { name: "Sign in", exact: true }).click();
  await pending.getByLabel("Display name").fill("Replacement member");
  await pending
    .getByLabel("Username", { exact: true })
    .fill("replacementpending");
  await pending
    .getByRole("button", { name: "Join Screenr", exact: true })
    .click();
  await expect(
    pending.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
  const screen = await (
    await owner.request.get("/api/screenr/screen?path=/invites")
  ).json();
  expect(
    screen.invitations.find(
      (invite: { id: string }) => invite.id === original.id,
    ).uses,
  ).toBe(0);
  expect(
    screen.invitations.find(
      (invite: { id: string }) => invite.id === replacement.id,
    ).uses,
  ).toBe(1);
  await owner.context().close();
  await pending.context().close();
});

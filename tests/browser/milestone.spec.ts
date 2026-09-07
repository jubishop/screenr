import { test, expect, type Page, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

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
  options: { complete?: boolean; token?: string; hasTouch?: boolean } = {},
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

async function invitationCreator(browser: Browser, name: string) {
  const page = await join(browser, name, {
    token: (await readFile(".cache/browser-sharing-invite.txt", "utf8")).trim(),
    hasTouch: true,
  });
  await page.goto("/invites");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveValue(
    /\/join\//,
  );
  return page;
}

test("invitation links copy on repeated mobile taps and keyboard activation", async ({
  browser,
}) => {
  const page = await invitationCreator(browser, "copyinvitation");
  const link = page.getByLabel("Invitation link", { exact: true });
  const copied: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.exposeFunction("writeInvitationText", async (text: string) => {
    copied.push(text);
    await gate;
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (
          window as unknown as {
            writeInvitationText: (text: string) => Promise<void>;
          }
        ).writeInvitationText,
      },
    });
  });
  const url = await link.inputValue();
  await page.screenshot({
    path: ".cache/invitation-copy.png",
    fullPage: true,
  });
  await link.tap();
  try {
    await expect.poll(() => copied).toEqual([url]);
    await expect(page.getByRole("status")).not.toHaveText("Link copied.");
  } finally {
    release();
  }
  await expect(page.getByRole("status")).toHaveText("Link copied.");
  await link.tap();
  await expect.poll(() => copied).toEqual([url, url]);
  const copy = page.getByRole("button", { name: "Copy link", exact: true });
  await expect(copy).toBeEnabled();
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => copied).toEqual([url, url, url]);
  await expect(copy).toBeEnabled();
  await page.keyboard.press("Space");
  await expect.poll(() => copied).toEqual([url, url, url, url]);
  await expect(page).toHaveURL(/\/invites$/);
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(link).not.toHaveValue(url);
  await expect(page.getByRole("status")).not.toHaveText("Link copied.");
  await link.tap();
  await expect.poll(() => copied.at(-1)).toBe(await link.inputValue());
  await page.context().close();
});

test("invitation links remain manually copyable when clipboard access fails or is unavailable", async ({
  browser,
}) => {
  const page = await invitationCreator(browser, "copyfallback");
  const link = page.getByLabel("Invitation link", { exact: true });
  const url = await link.inputValue();
  for (const available of [true, false]) {
    await page.evaluate((available) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: available
          ? {
              writeText: async () => {
                throw new DOMException("Clipboard denied", "NotAllowedError");
              },
            }
          : undefined,
      });
    }, available);
    await link.tap();
    await expect(page.getByRole("status")).toContainText("copy it manually");
    await expect(link).toHaveValue(url);
    expect(
      await link.evaluate((input: HTMLInputElement) =>
        input.value.slice(input.selectionStart!, input.selectionEnd!),
      ),
    ).toBe(url);
    await expect(
      page.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeEnabled();
  }
  await page.context().close();
});

test("invitation links share the exact URL and handle cancellation, failure, and unsupported browsers", async ({
  browser,
}) => {
  const page = await invitationCreator(browser, "shareinvitation");
  const shared: { data: ShareData; active: boolean }[] = [];
  const copied: string[] = [];
  await page.exposeFunction(
    "captureInvitationShare",
    (data: ShareData, active: boolean) => {
      shared.push({ data, active });
    },
  );
  await page.exposeFunction("writeInvitationText", (text: string) => {
    copied.push(text);
  });
  await page.addInitScript(() => {
    const boundary = window as unknown as {
      captureInvitationShare: (
        data: ShareData,
        active: boolean,
      ) => Promise<void>;
      writeInvitationText: (text: string) => Promise<void>;
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: boundary.writeInvitationText },
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: sessionStorage.getItem("share-unsupported")
        ? undefined
        : async (data: ShareData) => {
            await boundary.captureInvitationShare(
              data,
              navigator.userActivation.isActive,
            );
            const failure = sessionStorage.getItem("share-failure");
            if (failure) throw new DOMException("Share failed", failure);
          },
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  const link = page.getByLabel("Invitation link", { exact: true });
  const url = await link.inputValue();
  const share = page.getByRole("button", {
    name: "Share invitation",
    exact: true,
  });
  await expect(share).toBeVisible();
  await share.tap();
  await expect
    .poll(() => shared)
    .toEqual([{ data: { title: "Join me on Screenr", url }, active: true }]);
  for (const failure of ["AbortError", "NotAllowedError"]) {
    await page.evaluate(
      (failure) => sessionStorage.setItem("share-failure", failure),
      failure,
    );
    await share.tap();
    await expect(share).toBeEnabled();
    if (failure === "AbortError") {
      await expect(page.getByRole("status")).toBeEmpty();
      expect(copied).toEqual([]);
    } else {
      await expect(page.getByRole("status")).toContainText("Could not share");
    }
  }
  await page.getByRole("button", { name: "Copy link", exact: true }).tap();
  await expect.poll(() => copied).toEqual([url]);
  await page.evaluate(() => sessionStorage.removeItem("share-failure"));
  await share.tap();
  await expect.poll(() => shared.length).toBe(4);
  await expect(page.getByRole("status")).toBeEmpty();
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const control of [
      link,
      share,
      page.getByRole("button", { name: "Copy link", exact: true }),
    ]) {
      const bounds = await control.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: `.cache/invitation-${width}.png`,
      fullPage: true,
    });
  }
  await page.evaluate(() =>
    sessionStorage.setItem("share-unsupported", "true"),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(share).toHaveCount(0);
  await link.tap();
  await expect.poll(() => copied.at(-1)).toBe(await link.inputValue());
  await page.context().close();
});

test("title trailers fit desktop and mobile, send an origin referrer, and omit unavailable players", async ({
  browser,
}) => {
  const page = await join(browser, "trailerviewer", {
    token: (await readFile(".cache/browser-trailer-invite.txt", "utf8")).trim(),
  });
  const embeds: string[] = [];
  await page.route("https://www.youtube.com/embed/**", async (route) => {
    embeds.push((await route.request().allHeaders()).referer);
    await route.fulfill({
      contentType: "text/html",
      body: "Trailer player fixture",
    });
  });
  const response = await page.goto("/titles/movie/987654");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  const player = page.getByTitle("The Lantern Room trailer: Official trailer", {
    exact: true,
  });
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute(
    "src",
    "https://www.youtube.com/embed/Abcdef_1234?autoplay=0&playsinline=1",
  );
  await expect(
    page.getByRole("link", { name: "Watch on YouTube" }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=Abcdef_1234");
  await expect.poll(() => embeds).toEqual(["http://localhost:3055/"]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await player.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(200);
    expect(bounds!.height).toBeGreaterThanOrEqual(200);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
  await page.waitForResponse(
    (response) =>
      response.url().includes("/api/screenr/screen?") &&
      response.status() === 200,
  );
  expect(embeds).toHaveLength(1); // Background refresh must not reload playback.
  for (const path of ["/movie/987655", "/movie/987656", "/tv/987657"]) {
    await page.goto(`/titles${path}`);
    await expect(
      page.getByRole("heading", { name: "The Lantern Room", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Around this title" }),
    ).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Watch on YouTube" }),
    ).toHaveCount(0);
  }
  await page.context().close();
});

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

test("slow and failed refreshes enforce access while preserving reply drafts", async ({
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
  const invitation = await page.request.post("/api/screenr/invite", {
    headers: { Origin: "http://localhost:3055" },
    data: { limit: 1 },
  });
  const viewer = await join(browser, "slowviewer", {
    token: (await invitation.json()).token,
  });
  await befriend(page, viewer, "slowviewer", "draftrefresh");
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByLabel("Add your reply").fill("Keep my slow-network draft");
  await viewer.route("**/api/screenr/screen?**", async (route) => {
    // Delay the real HTTP boundary beyond the polling interval. Application
    // authorization and database reads still determine the returned content.
    await delay(4000);
    await route.continue();
  });
  await page.request.post("/api/screenr/comment", {
    headers: { Origin: "http://localhost:3055" },
    data: { conversation: id, body: "A slow incoming reply", spoiler: false },
  });
  await expect(
    viewer.getByRole("button", { name: /New replies/ }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: /New replies/ }).click();
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(viewer.getByRole("main").getByRole("alert")).toContainText(
    "Conversation not found.",
  );
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toHaveCount(0);
  await viewer.unrouteAll({ behavior: "wait" });
  await befriend(page, viewer, "slowviewer", "draftrefresh");
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByLabel("Add your reply").fill("Retain this timed-out draft");
  await viewer.route("**/api/screenr/screen?**", async (route) => {
    await delay(15000);
    await route.continue();
  });
  await expect(viewer.getByRole("main").getByRole("alert")).toContainText(
    "Refresh timed out. Please try again.",
    { timeout: 14000 },
  );
  await expect(
    viewer.getByText("Visible conversation content", { exact: true }),
  ).toHaveCount(0);
  await viewer.unrouteAll({ behavior: "wait" });
  await expect(viewer.getByLabel("Add your reply")).toHaveValue(
    "Retain this timed-out draft",
  );
  await viewer.context().close();
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
  await viewer
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await expect(
    viewer.getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  await viewer.reload();
  await expect(
    viewer.getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  await viewer.goto("/");
  await viewer
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await viewer
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await expect(
    viewer.getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  await viewer.reload();
  await expect(
    viewer.getByRole("button", { name: "+ Want to watch", exact: true }),
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

import { test, expect, type Page, type Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { browserConfig } from "../../scripts/browser-config";

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

test("emoji reactions persist across feeds on entries and replies, with change, removal, and retry", async ({
  browser,
  request,
}) => {
  const token = (
    await readFile(".cache/browser-reaction-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "reactionowner", { token });
  const reader = await join(browser, "reactionreader", {
    token,
    hasTouch: true,
  });
  await befriend(owner, reader, "reactionreader", "reactionowner");
  await owner.goto("/titles/movie/987654");
  const post = async (action: string, data: object) => {
    const response = await owner.request.post(`/api/screenr/${action}`, {
      headers: { Origin: browserConfig.baseURL },
      data,
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const recommended = await post("activity", {
    title: "movie:987654",
    field: "recommended",
    value: true,
  });
  const watch = await post("activity", {
    title: "movie:987654",
    field: "want_to_watch",
    value: true,
  });
  const standalone = await post("title-comment", {
    title: "movie:987654",
    body: "A discussion worth reacting to",
    spoiler: false,
  });
  const reply = await post("comment", {
    conversation: standalone,
    body: "A reply worth reacting to",
    spoiler: false,
  });
  const nested = await post("comment", {
    conversation: standalone,
    body: "A nested reply",
    spoiler: false,
    replyTo: reply,
  });
  await reader.goto("/titles/movie/987654");
  const entry = reader.locator(`[data-item-id="${standalone}"]`);
  const reactions = entry.getByRole("group", {
    name: "Reactions to entry",
    exact: true,
  });
  await expect(
    reactions.getByRole("button", { name: "React", exact: true }),
  ).toBeVisible();
  for (const group of [
    reactions,
    entry.locator(`[data-comment-id="${reply}"]`).getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ]) {
    const trigger = group.getByRole("button", { name: "React", exact: true });
    for (const focusChoice of [false, true]) {
      await trigger.focus();
      await reader.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      if (focusChoice)
        await group.getByRole("button", { name: "Like", exact: true }).focus();
      await reader.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
      await expect(
        group.getByRole("button", { name: "Like", exact: true }),
      ).toHaveCount(0);
    }
  }
  for (const name of ["Like", "Love", "Care", "Haha", "Wow", "Sad", "Angry"]) {
    await reactions.getByRole("button", { name: "React", exact: true }).click();
    await reactions.getByRole("button", { name, exact: true }).click();
    await expect(
      reactions.getByRole("button", { name: `${name}: 1`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(reactions.getByRole("button", { name: /: 1$/ })).toHaveCount(
      1,
    );
    await expect(
      reactions.getByRole("button", { name: "React", exact: true }),
    ).toBeFocused();
  }
  await entry
    .getByRole("button", { name: "View 1 reply", exact: true })
    .click();
  for (const [selector, label] of [
    [`[data-item-id="${recommended}"]`, "Reactions to entry"],
    [`[data-item-id="${watch}"]`, "Reactions to entry"],
    [`[data-comment-id="${reply}"]`, "Reactions to reply"],
    [`[data-comment-id="${nested}"]`, "Reactions to reply"],
  ]) {
    const group = reader
      .locator(selector)
      .getByRole("group", { name: label, exact: true });
    await group.getByRole("button", { name: "React", exact: true }).click();
    await group.getByRole("button", { name: "Love", exact: true }).click();
    await expect(
      group.getByRole("button", { name: "Love: 1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  for (const path of ["/", "/people/reactionowner", "/titles/movie/987654"]) {
    await reader.goto(path);
    await entry
      .getByRole("button", { name: "View 1 reply", exact: true })
      .click();
    await expect(
      reactions.getByRole("button", { name: "Angry: 1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      entry
        .locator(`[data-comment-id="${nested}"]`)
        .getByRole("button", { name: "Love: 1", exact: true }),
    ).toBeVisible();
  }
  const draft = entry.getByLabel("Add your reply");
  await draft.fill("Keep this draft while reacting");
  for (const succeeds of [false, true]) {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const saving = new Promise<void>((resolve) => (started = resolve));
    await reader.route("**/api/screenr/reaction", async (route) => {
      started();
      await gate;
      if (succeeds) await route.continue();
      else
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Reaction failed. Please retry." }),
        });
    });
    try {
      await reactions
        .getByRole("button", { name: "Angry: 1", exact: true })
        .focus();
      await reader.keyboard.press("Enter");
      await saving;
      await draft.fill("Typing while the reaction saves");
      release();
      if (succeeds) {
        await expect(
          reactions.getByRole("button", { name: "Angry: 1", exact: true }),
        ).toHaveCount(0);
      } else {
        await expect(reactions.getByRole("alert")).toHaveText(
          "Reaction failed. Please retry.",
        );
        await expect(
          reactions.getByRole("button", { name: "Angry: 1", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
      }
      await expect(
        reactions.getByRole("button", { name: "React", exact: true }),
      ).toHaveAttribute("aria-disabled", "false");
      await expect(draft).toBeFocused();
      await reader.keyboard.type(" and keeps typing");
      await expect(draft).toHaveValue(
        "Typing while the reaction saves and keeps typing",
      );
    } finally {
      release();
      await reader.unroute("**/api/screenr/reaction");
    }
  }
  await reader.reload();
  await expect(
    reactions.getByRole("button", { name: "Angry: 1", exact: true }),
  ).toHaveCount(0);
  await owner.goto("/titles/movie/987654");
  await expect(
    owner
      .locator(`[data-item-id="${recommended}"]`)
      .getByRole("button", { name: "Love: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  for (const width of [320, 1440]) {
    await reader.setViewportSize({ width, height: 900 });
    await reactions.getByRole("button", { name: "React", exact: true }).click();
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await reader.screenshot({
      path: `.cache/reactions-${width}.png`,
      fullPage: true,
    });
    await reactions.getByRole("button", { name: "React", exact: true }).click();
  }
  await post("remove-comment", { id: standalone });
  for (const path of ["/", "/people/reactionowner", "/titles/movie/987654"]) {
    await reader.goto(path);
    await expect(
      entry.getByText("Comment removed", { exact: true }),
    ).toBeVisible();
    await expect(reactions).toHaveCount(0);
    const survivingReply = entry.locator(`[data-comment-id="${reply}"]`);
    await expect(
      survivingReply.getByRole("button", { name: "Love: 1", exact: true }),
    ).toBeVisible();
  }
  const survivingReactions = entry
    .locator(`[data-comment-id="${reply}"]`)
    .getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    });
  await survivingReactions
    .getByRole("button", { name: "React", exact: true })
    .click();
  await survivingReactions
    .getByRole("button", { name: "Care", exact: true })
    .click();
  await expect(
    survivingReactions.getByRole("button", { name: "Care: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    (
      await reader.request.post("/api/screenr/reaction", {
        headers: { Origin: browserConfig.baseURL },
        data: { item: standalone, kind: "like" },
      })
    ).status(),
  ).toBe(404);
  const hidden = await post("title-comment", {
    title: "movie:987654",
    body: "Spoiler discussion",
    spoiler: true,
  });
  const hiddenReply = await post("comment", {
    conversation: hidden,
    body: "Spoiler reply",
    spoiler: true,
  });
  await reader.goto("/titles/movie/987654");
  const spoilerEntry = reader.locator(`[data-item-id="${hidden}"]`);
  await expect(
    spoilerEntry.getByRole("group", { name: /Reactions/ }),
  ).toHaveCount(0);
  await spoilerEntry
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  await expect(
    spoilerEntry.getByRole("group", {
      name: "Reactions to entry",
      exact: true,
    }),
  ).toBeVisible();
  const spoilerReply = spoilerEntry.locator(
    `[data-comment-id="${hiddenReply}"]`,
  );
  await expect(
    spoilerReply.getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ).toHaveCount(0);
  await spoilerReply
    .getByRole("button", {
      name: "Contains spoilers · Reveal comment",
      exact: true,
    })
    .click();
  await expect(
    spoilerReply.getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ).toBeVisible();
  const data = { item: recommended, kind: "like" };
  const headers = { Origin: browserConfig.baseURL };
  expect(
    (await request.post("/api/screenr/reaction", { headers, data })).status(),
  ).toBe(401);
  expect(
    (
      await reader.request.post("/api/screenr/reaction", {
        headers: { Origin: "https://untrusted.example" },
        data,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await reader.request.post("/api/screenr/reaction", {
        headers,
        data: { ...data, kind: "invalid" },
      })
    ).status(),
  ).toBe(400);
  await reader.goto("/people/reactionowner");
  await reader.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(
    reader.locator(`[data-item-id="${recommended}"]`),
  ).not.toBeVisible();
  expect(
    (
      await reader.request.post("/api/screenr/reaction", { headers, data })
    ).status(),
  ).toBe(404);
  await expect(
    owner
      .locator(`[data-item-id="${recommended}"]`)
      .getByRole("button", { name: "Love: 1", exact: true }),
  ).toHaveCount(0);
  await reader.context().close();
  await owner.context().close();
});

test("invitation links copy on repeated mobile taps and keyboard activation", async ({
  browser,
}) => {
  const page = await invitationCreator(browser, "copyinvitation");
  const link = page.getByLabel("Invitation link", { exact: true });
  const copied: string[] = [];
  let release!: () => void;
  let gate = new Promise<void>((resolve) => {
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
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await copy.focus();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => copied).toEqual([url, url, url]);
    await expect(copy).toBeDisabled();
    await expect(copy).toBeFocused();
    await page.keyboard.press("Space");
    expect(copied).toEqual([url, url, url]);
  } finally {
    release();
  }
  await expect(page.getByRole("status")).toHaveText("Link copied.");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Space");
  await expect.poll(() => copied).toEqual([url, url, url, url]);
  await expect(page).toHaveURL(/\/invites$/);
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  const links = page.getByLabel("Invitation link", { exact: true });
  await expect(links).toHaveCount(2);
  const newest = links.first();
  await expect(newest).not.toHaveValue(url);
  await expect(page.getByRole("status").first()).not.toHaveText("Link copied.");
  await newest.tap();
  await expect.poll(() => copied.at(-1)).toBe(await newest.inputValue());
  await page.context().close();
});

test("active invitation cards retain links across reloads and disappear after use, revocation, or expiry", async ({
  browser,
}) => {
  const owner = await join(browser, "invitationowner", {
    token: (await readFile(".cache/browser-invite-list.txt", "utf8")).trim(),
  });
  await owner.goto("/invites");
  await owner.getByLabel("Maximum signups").selectOption("2");
  const create = owner.getByRole("button", {
    name: "Create invitation",
    exact: true,
  });
  await create.click();
  const links = owner.getByLabel("Invitation link", { exact: true });
  await expect(links).toHaveCount(1);
  const url = await links.inputValue();
  await owner.reload();
  await expect(links).toHaveValue(url);
  await create.click();
  await expect(links).toHaveCount(2);
  const newerURL = await links.first().inputValue();
  expect(newerURL).not.toBe(url);
  const guest = await join(browser, "invitationguest", {
    token: new URL(url).pathname.split("/").at(-1),
  });
  await expect(
    owner.getByText("1 of 2 signups", { exact: true }),
  ).toBeVisible();
  await expect(
    owner.getByRole("link", {
      name: "invitationguest (@invitationguest)",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (
      await (
        await guest.request.get("/api/screenr/screen?path=/invites")
      ).json()
    ).invitations,
  ).toEqual([]);
  await owner.screenshot({
    path: ".cache/invitations-mobile.png",
    fullPage: true,
  });
  expect(
    await owner.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await owner.setViewportSize({ width: 1400, height: 1000 });
  await owner.screenshot({
    path: ".cache/invitations-desktop.png",
    fullPage: true,
  });
  const finalGuest = await join(browser, "invitationlast", {
    token: new URL(url).pathname.split("/").at(-1),
  });
  await expect(links).toHaveCount(1);
  await expect(links).toHaveValue(newerURL);
  await owner.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(links).toHaveCount(0);
  await expect(
    owner.getByText("No active invitations.", { exact: true }),
  ).toBeVisible();
  await create.click();
  await expect(links).toHaveCount(1);
  const screen = await (
    await owner.request.get("/api/screenr/screen?path=/invites")
  ).json();
  const database = new Pool({ connectionString: browserConfig.databaseURL });
  try {
    await database.query("UPDATE invitation SET expires_at=now() WHERE id=$1", [
      screen.invitations[0].id,
    ]);
  } finally {
    await database.end();
  }
  await expect(links).toHaveCount(0);
  await owner.reload();
  await expect(
    owner.getByText("No active invitations.", { exact: true }),
  ).toBeVisible();
  for (const page of [owner, guest, finalGuest]) await page.context().close();
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
  await expect(share).toHaveCount(0);
  await link.tap();
  await expect.poll(() => copied.at(-1)).toBe(await link.inputValue());
  await page.context().close();
});

test("title watch availability shows US categories, empty results, failures, and older data on mobile and desktop", async ({
  browser,
}) => {
  const page = await join(browser, "availabilityviewer", {
    token: (
      await readFile(".cache/browser-availability-invite.txt", "utf8")
    ).trim(),
  });
  await page.route("https://image.tmdb.org/t/p/w92/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#667765"/></svg>',
    }),
  );
  const availability = page.getByRole("region", { name: "Where to watch" });
  for (const kind of ["movie", "tv"]) {
    await page.goto(`/titles/${kind}/987660`);
    await expect(availability).toBeVisible();
    await expect(
      availability.getByText("United States", { exact: true }),
    ).toBeVisible();
    for (const [label, name] of [
      ["Subscription", "Harbor Stream"],
      ["Free", "Lantern Free"],
      ["With ads", "Coast TV"],
      ["Rent", "Harbor Store"],
      ["Buy", "Harbor Store"],
    ]) {
      const group = availability.getByRole("group", {
        name: label,
        exact: true,
      });
      await expect(group.getByText(name, { exact: true })).toBeVisible();
      await expect(group.locator("img")).toHaveAttribute(
        "src",
        "https://image.tmdb.org/t/p/w92/test-provider.png",
      );
    }
    await expect(availability.getByText("Canada only")).toHaveCount(0);
    await expect(
      availability.getByRole("link", { name: "Viewing options on TMDB" }),
    ).toHaveAttribute(
      "href",
      `https://www.themoviedb.org/${kind}/987660/watch?locale=US`,
    );
    await expect(
      availability.getByRole("link", { name: "JustWatch" }),
    ).toHaveAttribute("href", "https://www.justwatch.com/");
    await expect(
      availability.getByText("Availability may vary by season."),
    ).toHaveCount(kind === "tv" ? 1 : 0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await availability.scrollIntoViewIfNeeded();
      const bounds = await availability.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      if (kind === "movie" && width !== 320) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `.cache/watch-availability-${width}.png`,
          fullPage: true,
        });
      }
    }
  }
  await page.goto("/titles/movie/987661");
  await expect(
    availability.getByText("No viewing options are listed for the US."),
  ).toBeVisible();
  await expect(availability.getByText("Canada only")).toHaveCount(0);
  await page.goto("/titles/movie/987662");
  await expect(
    availability.getByText(
      "Viewing options could not be loaded. Please check again later.",
    ),
  ).toBeVisible();
  await expect(
    availability.getByText("No viewing options are listed for the US."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "The Lantern Room", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Around this title" }),
  ).toBeVisible();
  const pool = new Pool({ connectionString: browserConfig.databaseURL });
  try {
    await page.request.post(`${browserConfig.catalogURL}/availability-failure`);
    await pool.query(
      "UPDATE title_availability SET fetched_at='2020-01-02T12:00:00Z', refresh_after=now()-interval '1 second' WHERE title_id='movie:987660'",
    );
    await page.goto("/titles/movie/987660");
    await expect(
      availability.getByText("Could not refresh viewing options."),
    ).toBeVisible();
    await expect(
      availability.getByText("Harbor Stream", { exact: true }),
    ).toBeVisible();
    await expect(availability.locator("time")).toHaveAttribute(
      "datetime",
      "2020-01-02T12:00:00.000Z",
    );
    await expect(availability.locator("time")).toContainText("2020");
    // Exercise the real HTTP failure on an older successful empty result too.
    await pool.query(
      "UPDATE title_availability SET availability=$1, fetched_at='2020-01-02T12:00:00Z', refresh_after=now()-interval '1 second' WHERE title_id='movie:987660'",
      [{ link: null, providers: {} }],
    );
    await page.reload();
    await expect(
      availability.getByText("Could not refresh viewing options."),
    ).toBeVisible();
    await expect(
      availability.getByText(
        "No viewing options were listed when last checked.",
      ),
    ).toBeVisible();
    await expect(
      availability.getByText("Harbor Stream", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.request.delete(
      `${browserConfig.catalogURL}/availability-failure`,
    );
    await pool.end();
  }
  await page.goto("/");
  await expect(availability).toHaveCount(0);
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
  await expect.poll(() => embeds).toEqual([`${browserConfig.baseURL}/`]);
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

test("invited friends discover, save, and share inline discussions with live access enforcement", async ({
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
  await alice.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const titleURL = alice.url();
  await alice
    .getByRole("button", { name: "Copy link to discussion", exact: true })
    .click();
  await expect(alice.getByRole("status")).toHaveText("Link copied.");
  await expect(alice).toHaveURL(titleURL);
  const conversationURL = await alice.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(new URL(conversationURL).origin).toBe(browserConfig.baseURL);
  expect(
    new URL(conversationURL).pathname + new URL(conversationURL).search,
  ).toMatch(/^\/titles\/movie\/987654\?item=[0-9a-f-]+$/);
  const id = new URL(conversationURL).searchParams.get("item")!;
  const item = (page: Page) => page.locator(`[data-item-id="${id}"]`);
  await ben.goto("/");
  await item(ben)
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(ben.locator("[data-item-id]")).toHaveCount(2);
  await item(ben)
    .getByLabel("Add your reply")
    .fill("This looks like our kind of movie.");
  await item(ben)
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    item(ben).getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await expect(
    alice.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(
    item(alice).getByText("This looks like our kind of movie.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await alice.getByRole("button", { name: /New activity/ }).click();
  await item(alice).getByRole("button", { name: "Reply", exact: true }).click();
  const nestedComposer = item(alice).getByRole("form", {
    name: "Replying to @ben",
    exact: true,
  });
  await nestedComposer.getByRole("textbox").fill("The ending surprised me.");
  await nestedComposer.getByLabel("Contains spoilers", { exact: true }).check();
  await nestedComposer
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(ben.getByRole("button", { name: /New activity/ })).toBeVisible();
  await ben.getByRole("button", { name: /New activity/ }).click();
  await expect(
    item(ben).getByText("The ending surprised me.", { exact: true }),
  ).toHaveCount(0);
  await item(ben)
    .getByRole("button", { name: "View 1 reply", exact: true })
    .click();
  await item(ben)
    .getByRole("button", { name: /Reveal comment/ })
    .click();
  await expect(
    item(ben).getByText("The ending surprised me.", { exact: true }),
  ).toBeVisible();
  await expect(
    item(ben).getByText("Replying to @ben", { exact: true }),
  ).toBeVisible();
  await ben.reload();
  await expect(
    item(ben).getByText("The ending surprised me.", { exact: true }),
  ).toHaveCount(0);
  const denied = await outsider.request.get(
    `/api/screenr/screen?path=/conversations/${id}`,
  );
  expect(denied.status()).toBe(404);
  const write = (page: Page, body: string, replyTo?: string) =>
    page.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: { conversation: id, body, spoiler: false, replyTo },
    });
  expect((await write(outsider, "Unauthorized")).status()).toBe(404);
  await outsider.goto(conversationURL);
  await expect(outsider.getByRole("status")).toHaveText(
    "This activity is unavailable.",
  );
  await expect(item(outsider)).toHaveCount(0);
  await cam.goto(conversationURL);
  await expect(
    item(cam).getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await expect(
    item(cam).getByRole("button", { name: /^(Delete|Remove)$/ }),
  ).toHaveCount(0);
  await alice.goto("/people/ben");
  await alice.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(item(ben)).toHaveCount(0);
  await expect(
    item(cam).getByText("This looks like our kind of movie.", { exact: true }),
  ).toHaveCount(0);
  await befriend(alice, ben, "ben", "alice");
  await ben.goto(conversationURL);
  await expect(
    item(ben).getByText("This looks like our kind of movie.", { exact: true }),
  ).toBeVisible();
  await ben.goto("/people/cam");
  await ben.getByRole("button", { name: "Block", exact: true }).click();
  await item(cam).getByLabel("Add your reply").fill("Cam’s view of the film.");
  await item(cam)
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await ben.goto(conversationURL);
  await expect(
    item(ben).getByText("Cam’s view of the film.", { exact: true }),
  ).toHaveCount(0);
  await alice.goto(conversationURL);
  const camComment = item(alice)
    .locator("[data-comment-id]")
    .filter({ hasText: "Cam’s view of the film." });
  const camReply = await camComment.getAttribute("data-comment-id");
  const reply = await write(alice, "The host can reply to Cam", camReply!);
  expect(reply.status()).toBe(200);
  await alice.reload();
  await camComment.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    item(alice)
      .locator(`[data-comment-id="${camReply}"]`)
      .getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await item(alice)
    .getByRole("button", { name: "View 1 reply", exact: true })
    .last()
    .click();
  await expect(
    item(alice).getByText("Replying to @cam", { exact: true }),
  ).toBeVisible();
  const ownComment = (page: Page) =>
    item(page).locator("[data-comment-id]").filter({
      hasText: "This looks like our kind of movie.",
    });
  for (const path of ["/", "/people/alice", conversationURL]) {
    await ben.goto(path);
    await expect(
      ownComment(ben).getByRole("button", { name: "Delete", exact: true }),
    ).toBeVisible();
    await expect(
      item(ben).getByRole("button", { name: "Remove", exact: true }),
    ).toHaveCount(0);
  }
  const ownId = await ownComment(ben).getAttribute("data-comment-id");
  for (const page of [cam, outsider]) {
    const deniedRemoval = await page.request.post(
      "/api/screenr/remove-comment",
      {
        headers: { Origin: browserConfig.baseURL },
        data: { id: ownId },
      },
    );
    expect(deniedRemoval.status()).toBe(404);
  }
  await ben.route(
    "**/api/screenr/remove-comment",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Deletion failed. Please try again." },
      }),
    { times: 1 },
  );
  await ownComment(ben)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(item(ben).getByRole("alert")).toHaveText(
    "Deletion failed. Please try again.",
  );
  await expect(ownComment(ben)).toBeVisible();
  await ownComment(ben)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(item(ben).getByRole("alert")).toHaveCount(0);
  for (const page of [ben, alice]) {
    await expect(
      item(page).locator(`[data-comment-id="${ownId}"]`),
    ).toContainText("Comment removed");
    await expect(
      item(page).getByText("This looks like our kind of movie.", {
        exact: true,
      }),
    ).toHaveCount(0);
    const group = item(page)
      .locator(".comment-group")
      .filter({
        has: page.locator(`[data-comment-id="${ownId}"]`),
      });
    const expansion = group.getByRole("button", {
      name: "View 1 reply",
      exact: true,
    });
    if ((await expansion.getAttribute("aria-expanded")) !== "true")
      await expansion.click();
    await expect(
      item(page).getByText("Replying to @ben", { exact: true }),
    ).toBeVisible();
  }
  await ben.reload();
  await expect(item(ben).locator(`[data-comment-id="${ownId}"]`)).toContainText(
    "Comment removed",
  );
  await expect(
    item(ben).getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  await alice.goto("/invites");
  await alice.getByLabel("Maximum signups").selectOption("2");
  await alice
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(alice.getByLabel("Invitation link")).toHaveValue(/\/join\//);
  await alice.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(alice.getByLabel("Invitation link")).toHaveCount(0);
  await expect(
    alice.getByText("No active invitations.", { exact: true }),
  ).toBeVisible();
  for (const page of [alice, ben, cam, outsider]) await page.context().close();
});

test("standalone title comments persist and share replies across all three mobile feeds", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const token = (
    await readFile(".cache/browser-comment-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "commentowner", { token });
  const reader = await join(browser, "commentreader", { token });
  const outsider = await join(browser, "commentoutsider", { token });
  await befriend(owner, reader, "commentreader", "commentowner");
  await owner.goto("/titles/movie/987654");
  const composer = owner.getByRole("form", { name: "New title comment" });
  await expect(
    composer.getByLabel("Your comment", { exact: true }),
  ).toBeVisible();
  for (const body of [
    "First independent thought",
    "Second independent thought",
  ]) {
    await composer.getByLabel("Your comment", { exact: true }).fill(body);
    await composer
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(owner.getByText(body, { exact: true })).toBeVisible();
    await expect(
      composer.getByLabel("Your comment", { exact: true }),
    ).toHaveValue("");
  }
  const first = owner
    .locator("[data-item-id]")
    .filter({ hasText: "First independent thought" });
  const id = await first.getAttribute("data-item-id");
  await owner.reload();
  await expect(owner.locator("[data-item-id]")).toHaveCount(2);
  await expect(
    owner.getByRole("button", { name: "Recommend to friends", exact: true }),
  ).toBeVisible();
  await expect(
    owner
      .locator(".title-hero")
      .getByRole("button", { name: "+ Want to watch", exact: true }),
  ).toBeVisible();
  for (const [index, path] of [
    "/titles/movie/987654",
    "/",
    "/people/commentowner",
  ].entries()) {
    await reader.goto(path);
    await expect(
      reader.getByRole("form", { name: "New title comment" }),
    ).toHaveCount(index === 0 ? 1 : 0);
    const item = reader.locator(`[data-item-id="${id}"]`);
    await item
      .getByLabel("Add your reply")
      .fill(`Standalone reply from view ${index}`);
    await item.getByRole("button", { name: "Post reply", exact: true }).click();
    await expect(
      item
        .locator("[data-comment-id]")
        .getByText(`Standalone reply from view ${index}`, { exact: true }),
    ).toBeVisible();
    await reader.reload();
    await expect(item.locator("[data-comment-id]")).toHaveCount(index + 1);
    await expect(
      reader
        .locator("[data-item-id]")
        .filter({ hasText: "Second independent thought" })
        .locator("[data-comment-id]"),
    ).toHaveCount(0);
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await reader.screenshot({
      path: `.cache/standalone-view-${index}.png`,
      fullPage: true,
    });
  }
  // The same stored replies appear in every view after reload.
  for (const path of ["/titles/movie/987654", "/", "/people/commentowner"]) {
    await reader.goto(path);
    await expect(
      reader.locator(`[data-item-id="${id}"] [data-comment-id]`),
    ).toHaveCount(3);
  }
  await owner.goto("/titles/movie/987654");
  await first.getByLabel("Add your reply").fill("Fourth reply from the host");
  await first.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    first
      .locator("[data-comment-id]")
      .getByText("Fourth reply from the host", { exact: true }),
  ).toBeVisible();
  for (const path of ["/titles/movie/987654", "/", "/people/commentowner"]) {
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${id}"]`);
    await expect(item.locator("[data-comment-id]")).toHaveCount(3);
    await expect(
      item.getByText("Standalone reply from view 0", { exact: true }),
    ).toHaveCount(0);
    await item
      .getByRole("button", { name: "Show earlier comments (1)", exact: true })
      .click();
    await expect(item.locator("[data-comment-id]")).toHaveCount(4);
    await expect(
      item.getByText("Standalone reply from view 0", { exact: true }),
    ).toBeVisible();
  }
  await reader.goto("/people/commentreader");
  await expect(reader.locator("[data-item-id]")).toHaveCount(0);
  await expect(
    reader.getByRole("form", { name: "New title comment" }),
  ).toHaveCount(0);
  const denied = await outsider.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "No access", spoiler: false },
  });
  expect(denied.status()).toBe(404);
  await outsider.goto(`/titles/movie/987654?item=${id}`);
  await expect(
    outsider.getByText("First independent thought", { exact: true }),
  ).toHaveCount(0);
  await expect(
    outsider.getByText("This activity is unavailable.", { exact: true }),
  ).toBeVisible();
  const signedOut = await browser.newContext();
  expect(
    (
      await signedOut.request.post(
        `${browserConfig.baseURL}/api/screenr/title-comment`,
        {
          headers: { Origin: browserConfig.baseURL },
          data: { title: "movie:987654", body: "Anonymous", spoiler: false },
        },
      )
    ).status(),
  ).toBe(401);
  await signedOut.close();
  await owner.goto("/titles/tv/987654");
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("A show spoiler");
  await composer.getByLabel("Contains spoilers").check();
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(
    owner.getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    }),
  ).toBeVisible();
  await owner.reload();
  await owner
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  const spoilerItem = owner
    .locator("[data-item-id]")
    .filter({ hasText: "A show spoiler" });
  const spoilerId = await spoilerItem.getAttribute("data-item-id");
  await spoilerItem
    .getByLabel("Add your reply")
    .fill("Thread inherits the spoiler flag");
  await spoilerItem
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    spoilerItem
      .locator("[data-comment-id]")
      .getByText("Thread inherits the spoiler flag", { exact: true }),
  ).toBeVisible();
  for (const path of [
    `/titles/tv/987654?item=${spoilerId}`,
    "/",
    "/people/commentowner",
  ]) {
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${spoilerId}"]`);
    await expect(item.getByText("A show spoiler", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      item.getByText("Thread inherits the spoiler flag", { exact: true }),
    ).toHaveCount(0);
    await item
      .getByRole("button", {
        name: "Contains spoilers · Reveal discussion",
        exact: true,
      })
      .click();
    await expect(
      item.getByText("A show spoiler", { exact: true }),
    ).toBeVisible();
    await expect(
      item.getByText("Thread inherits the spoiler flag", { exact: true }),
    ).toBeVisible();
  }
  await owner.context().close();
  await reader.context().close();
  await outsider.context().close();
});

test("standalone deletion preserves discussions across feeds, keeps spoilers hidden, and removes empty entries", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const token = (
    await readFile(".cache/browser-comment-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "deleteowner", { token });
  const reader = await join(browser, "deletereader", { token });
  await befriend(owner, reader, "deletereader", "deleteowner");
  const headers = { Origin: browserConfig.baseURL };
  const create = async (body: string, spoiler = false) => {
    const response = await owner.request.post("/api/screenr/title-comment", {
      headers,
      data: { title: "tv:987654", body, spoiler },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const reply = async (id: string, body: string) => {
    const response = await reader.request.post("/api/screenr/comment", {
      headers,
      data: { conversation: id, body, spoiler: false },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const item = (page: Page, id: string) =>
    page.locator(`[data-item-id="${id}"]`);
  const heading = (page: Page, id: string) =>
    page.locator(`[data-item-heading="${id}"]`);
  for (const [index, path] of [
    "/titles/tv/987654",
    "/",
    "/people/deleteowner",
  ].entries()) {
    const body = `Starting comment from view ${index}`;
    const id = await create(body);
    const replyId = await reply(id, `Retained reply ${index}`);
    await owner.goto(path);
    await reader.goto(`/titles/tv/987654?item=${id}`);
    await expect(
      heading(reader, id).getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await reader.request.post("/api/screenr/remove-comment", {
          headers,
          data: { id },
        })
      ).status(),
    ).toBe(404);
    const button = heading(owner, id).getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await expect(button).toBeVisible();
    if (index === 0) {
      await owner.route(
        "**/api/screenr/remove-comment",
        (route) =>
          route.fulfill({
            status: 503,
            json: { error: "Deletion failed. Please try again." },
          }),
        { times: 1 },
      );
      await button.click();
      await expect(heading(owner, id).getByRole("alert")).toHaveText(
        "Deletion failed. Please try again.",
      );
      await expect(
        heading(owner, id).getByText(body, { exact: true }),
      ).toBeVisible();
    }
    await button.click();
    for (const page of [owner, reader]) {
      await expect(
        heading(page, id).getByText("Comment removed", { exact: true }),
      ).toBeVisible();
      await expect(item(page, id).getByText(body, { exact: true })).toHaveCount(
        0,
      );
      await expect(
        item(page, id).getByText(`Retained reply ${index}`, { exact: true }),
      ).toBeVisible();
    }
    await expect(heading(owner, id).getByRole("alert")).toHaveCount(0);
    await expect(button).toHaveCount(0);
    await owner.reload();
    await expect(
      heading(owner, id).getByText("Comment removed", { exact: true }),
    ).toBeVisible();
    if (index === 0) {
      await item(reader, id)
        .getByLabel("Add your reply")
        .fill("Continue after deletion");
      await item(reader, id)
        .getByRole("button", { name: "Post reply", exact: true })
        .click();
      await expect(
        item(reader, id).getByText("Continue after deletion", { exact: true }),
      ).toBeVisible();
      await owner.screenshot({
        path: ".cache/deleted-standalone-mobile.png",
        fullPage: true,
      });
      expect(
        await owner.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(390);
    } else {
      await item(reader, id)
        .locator(`[data-comment-id="${replyId}"]`)
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(item(reader, id)).toHaveCount(0);
      await expect(item(owner, id)).toHaveCount(0);
    }
  }
  const spoilerId = await create("Remove this hidden spoiler", true);
  await reply(spoilerId, "Still protected by the discussion spoiler");
  for (const page of [owner, reader])
    await page.goto(`/titles/tv/987654?item=${spoilerId}`);
  await heading(owner, spoilerId)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    heading(reader, spoilerId).getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await expect(
    item(reader, spoilerId).getByText(
      "Still protected by the discussion spoiler",
      { exact: true },
    ),
  ).toHaveCount(0);
  await item(reader, spoilerId)
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  await expect(
    item(reader, spoilerId).getByText(
      "Still protected by the discussion spoiler",
      { exact: true },
    ),
  ).toBeVisible();
  await reader.reload();
  await expect(
    item(reader, spoilerId).getByText(
      "Still protected by the discussion spoiler",
      { exact: true },
    ),
  ).toHaveCount(0);

  const emptyId = await create("Remove this empty entry");
  for (const page of [owner, reader])
    await page.goto(`/titles/tv/987654?item=${emptyId}`);
  await heading(owner, emptyId)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  for (const page of [owner, reader]) {
    await expect(item(page, emptyId)).toHaveCount(0);
    await expect(
      page.getByText("This activity is unavailable.", { exact: true }),
    ).toBeVisible();
  }
  for (const path of [
    "/",
    "/people/deleteowner",
    `/titles/tv/987654?item=${emptyId}`,
  ]) {
    await owner.goto(path);
    await expect(item(owner, emptyId)).toHaveCount(0);
  }
  await owner.context().close();
  await reader.context().close();
});

test("spoiler reply links reach the hidden discussion before revealing the target", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-comment-invite.txt", "utf8")
  ).trim();
  const page = await join(browser, "commentlinks", { token });
  const headers = { Origin: browserConfig.baseURL };
  const body = "Hidden discussion.\n".repeat(60).trim();
  const response = await page.request.post("/api/screenr/title-comment", {
    headers,
    data: { title: "movie:987655", body, spoiler: true },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const replyResponse = await page.request.post("/api/screenr/comment", {
    headers,
    data: { conversation: id, body: "Linked hidden reply", spoiler: false },
  });
  expect(replyResponse.ok()).toBe(true);
  const { id: replyId } = await replyResponse.json();
  // Newer entries put the linked discussion below the initial viewport.
  for (let index = 0; index < 2; index++) {
    const newer = await page.request.post("/api/screenr/title-comment", {
      headers,
      data: {
        title: "movie:987655",
        body: `Newer discussion ${index}`,
        spoiler: false,
      },
    });
    expect(newer.ok()).toBe(true);
  }
  await page.goto(`/titles/movie/987655?item=${id}&reply=${replyId}`);
  const item = page.locator(`[data-item-id="${id}"]`);
  const reveal = item.getByRole("button", {
    name: "Contains spoilers · Reveal discussion",
    exact: true,
  });
  await expect(reveal).toBeInViewport();
  await expect(item.getByText(body, { exact: true })).toHaveCount(0);
  await expect(
    item.getByText("Linked hidden reply", { exact: true }),
  ).toHaveCount(0);
  await reveal.click();
  await expect(page.locator(`#comment-${replyId}`)).toBeInViewport();
  await expect(
    item.getByText("Linked hidden reply", { exact: true }),
  ).toBeVisible();
  await page.context().close();
});

test("standalone composition retains drafts through posting and refresh failures", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-comment-invite.txt", "utf8")
  ).trim();
  const page = await join(browser, "commentdrafts", { token });
  await page.goto("/titles/movie/987655");
  const composer = page.getByRole("form", { name: "New title comment" });
  const input = composer.getByLabel("Your comment", { exact: true });
  const submit = composer.getByRole("button", {
    name: "Post comment",
    exact: true,
  });
  await input.fill("Keep my standalone draft");
  await composer.getByLabel("Contains spoilers").check();
  await page.route("**/api/screenr/title-comment", (route) =>
    route.fulfill({ status: 503, json: { error: "Posting unavailable" } }),
  );
  await submit.click();
  await expect(composer.getByRole("alert")).toHaveText("Posting unavailable");
  await expect(input).toHaveValue("Keep my standalone draft");
  await expect(composer.getByLabel("Contains spoilers")).toBeChecked();
  await page.route("**/api/screenr/screen?**", (route) =>
    route.fulfill({ status: 503, json: { error: "Refresh unavailable" } }),
  );
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Refresh unavailable",
  );
  await expect(composer).toHaveCount(0);
  await page.unroute("**/api/screenr/screen?**");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(input).toHaveValue("Keep my standalone draft");
  await expect(composer.getByLabel("Contains spoilers")).toBeChecked();
  await page.unroute("**/api/screenr/title-comment");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/screenr/title-comment", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await submit.click();
  await input.fill("A later thought typed while saving");
  await composer.getByLabel("Contains spoilers").uncheck();
  release();
  await expect(submit).toBeEnabled();
  await expect(input).toHaveValue("A later thought typed while saving");
  await page.unroute("**/api/screenr/title-comment");
  await submit.click();
  await expect(
    page.getByText("A later thought typed while saving", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(page.locator("[data-item-id]")).toHaveCount(2);
  await page
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Keep my standalone draft", { exact: true }),
  ).toBeVisible();
  const wrongOrigin = await page.request.post("/api/screenr/title-comment", {
    headers: { Origin: "http://untrusted.example.test" },
    data: { title: "movie:987655", body: "Cross-origin", spoiler: false },
  });
  expect(wrongOrigin.status()).toBe(403);
  for (const [data, status] of [
    [{ title: "movie:987655", body: " ", spoiler: false }, 400],
    [{ title: "movie:987655", body: "Valid", spoiler: "false" }, 400],
    [{ body: "Titleless", spoiler: false }, 404],
  ] as const) {
    const response = await page.request.post("/api/screenr/title-comment", {
      headers: { Origin: browserConfig.baseURL },
      data,
    });
    expect(response.status()).toBe(status);
  }
  await page.context().close();
});

test("profile friends support discovery and refresh accepted friendships and blocks", async ({
  browser,
  page,
}) => {
  const token = (
    await readFile(".cache/browser-friends-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "circleowner", { token });
  const displayName = "W".repeat(60);
  const friend = await join(browser, "circlefriend", { token, displayName });
  const viewer = await join(browser, "circleviewer", { token });
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

test("watch together opens from a friend profile, filters shared titles, and refreshes choices and access", async ({
  browser,
  page,
}) => {
  const token = (
    await readFile(".cache/browser-watch-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "watchowner", { token });
  const friend = await join(browser, "watchfriend", { token });
  const path = "/watch-together?with=watchfriend";
  const apiPath = `/api/screenr/screen?path=${encodeURIComponent(path)}`;
  await owner.goto("/people/watchfriend");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toHaveCount(0);
  expect((await owner.request.get(apiPath)).status()).toBe(404);
  expect((await page.request.get(apiPath)).status()).toBe(401);
  await befriend(owner, friend, "watchfriend", "watchowner");
  await owner.goto("/people/watchowner");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toHaveCount(0);
  await owner.goto("/people/watchfriend");
  await owner
    .getByRole("link", { name: "Watch together", exact: true })
    .click();
  await expect(
    owner.getByRole("heading", { name: "No shared titles yet." }),
  ).toBeVisible();
  for (const title of ["/titles/movie/987654", "/titles/tv/998001"]) {
    for (const person of [owner, friend]) {
      await person.goto(title);
      await person
        .locator(".title-hero")
        .getByRole("button", { name: "+ Want to watch", exact: true })
        .click();
      await expect(
        person
          .locator(".title-hero")
          .getByRole("button", { name: "✓ Want to watch", exact: true }),
      ).toBeVisible();
    }
  }
  await owner.goto("/people/watchfriend");
  await owner
    .getByRole("link", { name: "Watch together", exact: true })
    .click();
  await expect(owner).toHaveURL(path);
  await expect(
    owner.getByRole("heading", { name: "Watch together", exact: true }),
  ).toBeVisible();
  const results = owner.getByLabel("Shared titles");
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Harbor Signal",
    "The Lantern Room",
  ]);
  await expect(
    owner.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    owner.getByRole("button", { name: /Want to watch/ }),
  ).toHaveCount(0);
  await owner.getByRole("button", { name: "Movies", exact: true }).click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Lantern Room",
  ]);
  await owner.waitForResponse((response) =>
    response.url().includes("/api/screenr/screen?"),
  );
  await expect(
    owner.getByRole("button", { name: "Movies", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await owner.getByRole("button", { name: "TV", exact: true }).click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Harbor Signal",
  ]);
  await owner.reload();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Harbor Signal",
    "The Lantern Room",
  ]);
  for (const width of [1440, 390, 320]) {
    await owner.setViewportSize({ width, height: 900 });
    expect(
      await owner.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await owner.screenshot({
      path: `.cache/watch-together-${width}.png`,
      fullPage: true,
    });
  }
  await results
    .getByRole("link")
    .filter({ hasText: "The Lantern Room" })
    .click();
  await expect(owner).toHaveURL("/titles/movie/987654");
  await expect(
    owner
      .locator(".title-hero")
      .getByRole("button", { name: "✓ Want to watch", exact: true }),
  ).toBeVisible();
  await owner.goBack();
  await owner.getByRole("button", { name: "TV", exact: true }).click();
  await friend
    .locator(".title-hero")
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await expect(
    owner.getByRole("heading", { name: "No shared TV shows yet." }),
  ).toBeVisible();
  await owner.getByRole("button", { name: "All", exact: true }).click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Lantern Room",
  ]);
  await friend.goto("/titles/movie/987654");
  await friend
    .locator(".title-hero")
    .getByRole("button", { name: "✓ Want to watch", exact: true })
    .click();
  await expect(
    owner.getByRole("heading", { name: "No shared titles yet." }),
  ).toBeVisible();
  await friend
    .locator(".title-hero")
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(results.getByRole("heading", { level: 2 })).toHaveText([
    "The Lantern Room",
  ]);
  await friend.goto("/people/watchowner");
  await friend.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Watch together not found." }),
  ).toBeVisible();
  await expect(results).toHaveCount(0);
  expect((await owner.request.get(apiPath)).status()).toBe(404);
  await owner.reload();
  await expect(
    owner.getByRole("alert").filter({ hasText: "Watch together not found." }),
  ).toBeVisible();
  await owner.goto("/people/watchfriend");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toHaveCount(0);
  await owner.context().close();
  await friend.context().close();
});

test("discussion links copy from every feed without navigating or losing drafts and recover from clipboard failures", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-feed-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "copyowner", { token });
  const reader = await join(browser, "copyreader", { token, hasTouch: true });
  await befriend(owner, reader, "copyreader", "copyowner");
  await owner.goto("/titles/tv/987657");
  await owner
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  const composer = owner.getByRole("form", { name: "New title comment" });
  await composer
    .getByLabel("Your comment", { exact: true })
    .fill("An independent discussion to share");
  await composer
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(owner.locator("[data-item-id]")).toHaveCount(3);
  await reader
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"]);

  for (const path of ["/titles/tv/987657", "/", "/people/copyowner"]) {
    await reader.goto(path);
    const entries = reader.locator("[data-item-id]");
    await expect(entries).toHaveCount(3);
    for (const entry of await entries.all()) {
      const id = await entry.getAttribute("data-item-id");
      const expectedURL = `${browserConfig.baseURL}/titles/tv/987657?item=${id}`;
      const draft = entry.getByLabel("Add your reply");
      await draft.fill("Keep this reply draft.");
      const copy = entry.getByRole("button", {
        name: "Copy link to discussion",
        exact: true,
      });
      await expect(copy).toBeVisible();
      await expect(entry.getByRole("status")).toBeEmpty();
      await copy.tap();
      await expect(entry.getByRole("status")).toHaveText("Link copied.");
      expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(
        expectedURL,
      );
      await expect(reader).toHaveURL(`${browserConfig.baseURL}${path}`);
      await expect(draft).toHaveValue("Keep this reply draft.");
      await reader.evaluate(() =>
        navigator.clipboard.writeText("Before keyboard copy"),
      );
      await copy.focus();
      await reader.keyboard.press("Enter");
      await expect(copy).toBeFocused();
      await expect(reader).toHaveURL(`${browserConfig.baseURL}${path}`);
      await expect
        .poll(() => reader.evaluate(() => navigator.clipboard.readText()))
        .toBe(expectedURL);
    }
  }

  const entry = reader.locator("[data-item-id]").first();
  const copy = entry.getByRole("button", {
    name: "Copy link to discussion",
    exact: true,
  });
  for (const unavailable of [false, true]) {
    await reader.evaluate((unavailable) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: unavailable
          ? undefined
          : {
              writeText: async () => {
                throw new DOMException("Clipboard denied", "NotAllowedError");
              },
            },
      });
    }, unavailable);
    await copy.tap();
    await expect(entry.getByRole("status")).toHaveText(
      "Could not copy the link. Please try again.",
    );
    await expect(reader).toHaveURL(`${browserConfig.baseURL}/people/copyowner`);
    await expect(entry.getByLabel("Add your reply")).toHaveValue(
      "Keep this reply draft.",
    );
  }
  await reader.evaluate(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });
  await copy.tap();
  await expect(entry.getByRole("status")).toHaveText("Link copied.");
  const sharedURL = await reader.evaluate(() => navigator.clipboard.readText());
  await owner.goto(sharedURL);
  await expect(
    owner.locator(
      `[data-item-id="${new URL(sharedURL).searchParams.get("item")}"]`,
    ),
  ).toBeInViewport();
  await reader.setViewportSize({ width: 320, height: 844 });
  expect(
    await reader.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(320);
  await reader.screenshot({
    path: ".cache/discussion-copy-mobile.png",
    fullPage: true,
  });
  await owner.context().close();
  await reader.context().close();
});

test("feed poster links name their titles and support keyboard navigation with and without artwork", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-feed-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "posterowner", { token });
  const reader = await join(browser, "posterreader", { token });
  await befriend(owner, reader, "posterreader", "posterowner");
  for (const page of [owner, reader]) {
    await page.route("**/_next/image?**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoIAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
  }
  await owner.goto("/search");
  await owner.getByLabel("Movie or show title").fill("Lantern");
  await owner.getByRole("button", { name: "Search", exact: true }).click();
  const result = owner.locator(".search-result");
  await expect(result).toHaveAccessibleName("The Lantern Room Movie · 2026");
  await result.click();
  await expect(owner).toHaveURL(/\/titles\/movie\/987654$/);

  for (const [id, name, hasArtwork] of [
    [987654, "The Lantern Room", false],
    [987658, "The Painted Sky", true],
  ] as const) {
    const titlePath = `/titles/movie/${id}`;
    await owner.goto(titlePath);
    await owner
      .getByRole("button", { name: "Recommend to friends", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "✓ Recommended", exact: true }),
    ).toBeVisible();
    for (const path of ["/", "/people/posterowner", titlePath]) {
      await reader.goto(path);
      const entry = reader.locator(".feed-entry").filter({
        has: reader.getByRole("heading", { name, exact: true }),
      });
      const poster = entry.locator(".poster-link");
      await expect(poster.getByRole("img")).toHaveCount(hasArtwork ? 1 : 0);
      await expect(poster).toHaveAccessibleName(name);
      await poster.focus();
      await expect(poster).toBeFocused();
      await reader.keyboard.press("Enter");
      await expect(reader).toHaveURL(new RegExp(`${titlePath}$`));
      await expect(
        reader.getByRole("heading", { name, level: 1, exact: true }),
      ).toBeVisible();

      await reader.goto(path);
      const titleLink = entry
        .getByRole("heading", { name, exact: true })
        .getByRole("link", { name, exact: true });
      await titleLink.click();
      await expect(reader).toHaveURL(new RegExp(`${titlePath}$`));
      await expect(
        reader.getByRole("heading", { name, level: 1, exact: true }),
      ).toBeVisible();
    }
  }
  await reader.context().close();
  await owner.context().close();
});

test("unified feeds show separate actions and support inline replies on title, friends, and profile", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-feed-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "feedowner", { token });
  const reader = await join(browser, "feedreader", { token });
  await befriend(owner, reader, "feedreader", "feedowner");
  await owner.goto("/titles/movie/987654");
  await owner
    .getByRole("button", { name: "Recommend to friends", exact: true })
    .click();
  await owner
    .locator(".title-hero")
    .getByRole("button", { name: "+ Want to watch", exact: true })
    .click();
  await expect(owner.getByLabel("Add your reply")).toHaveCount(2);
  const recommendation = owner
    .locator("[data-item-id]")
    .filter({ hasText: "feedowner recommends" });
  const id = await recommendation.getAttribute("data-item-id");
  for (const [index, path] of [
    "/titles/movie/987654",
    "/",
    "/people/feedowner",
  ].entries()) {
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${id}"]`);
    await item.getByLabel("Add your reply").fill(`Reply from surface ${index}`);
    await item.getByRole("button", { name: "Post reply", exact: true }).click();
    await expect(
      item.getByText(`Reply from surface ${index}`, { exact: true }),
    ).toBeVisible();
    await reader.reload();
    await expect(
      item.getByText(`Reply from surface ${index}`, { exact: true }),
    ).toBeVisible();
    await expect(
      reader
        .locator("[data-item-id]")
        .filter({ hasText: "feedowner wants to watch" })
        .locator("[data-comment-id]"),
    ).toHaveCount(0);
  }
  for (const width of [1440, 390, 320]) {
    await reader.setViewportSize({ width, height: 900 });
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(
      reader.locator(`[data-item-id="${id}"] [data-comment-id]`),
    ).toHaveCount(3);
  }
  await reader.evaluate(() => window.scrollTo(0, 0));
  await reader.screenshot({ path: ".cache/feed-phone.png", fullPage: true });
  await reader.setViewportSize({ width: 1440, height: 1000 });
  await reader.evaluate(() => window.scrollTo(0, 0));
  await reader.screenshot({ path: ".cache/feed-desktop.png", fullPage: true });
  await reader.context().close();
  await owner.context().close();
});

test("every feed holds incoming activity, preserves drafts and position, and expands reply links safely", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-feed-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "incomingowner", { token });
  const reader = await join(browser, "incomingreader", { token });
  await befriend(owner, reader, "incomingreader", "incomingowner");
  async function action(field: string, value: boolean) {
    const result = await owner.request.post("/api/screenr/activity", {
      headers: { Origin: browserConfig.baseURL },
      data: { title: "movie:987654", field, value },
    });
    expect(result.status()).toBe(200);
    return (await result.json()).id as string;
  }
  const id = await action("recommended", true);
  const replies: string[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await owner.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: {
        conversation: id,
        body: `Preview reply ${index}`,
        spoiler: index === 0,
      },
    });
    expect(response.status()).toBe(200);
    replies.push((await response.json()).id);
  }
  const saved = await action("want_to_watch", true);
  for (const [index, path] of [
    "/",
    "/titles/movie/987654",
    "/people/incomingowner",
  ].entries()) {
    await action("recommended", true);
    await action("want_to_watch", false);
    await action("want_to_watch", true);
    await reader.goto(path);
    const item = reader.locator(`[data-item-id="${id}"]`);
    const ids = () =>
      reader
        .locator("[data-item-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-item-id")),
        );
    expect(await ids()).toEqual([saved, id]);
    await expect(item.locator("[data-comment-id]")).toHaveCount(3);
    await expect(
      item.getByText("Preview reply 0", { exact: true }),
    ).toHaveCount(0);
    await item.getByRole("button", { name: /Show earlier comments/ }).click();
    await expect(item.locator("[data-comment-id]")).toHaveCount(5 + index);
    await expect(
      item.getByText("Preview reply 0", { exact: true }),
    ).toHaveCount(0);
    const draft = item.getByLabel("Add your reply");
    await draft.fill(`Draft on surface ${index}`);
    await item.getByLabel("Contains spoilers", { exact: true }).check();
    const added = await owner.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: {
        conversation: id,
        body: `Incoming on surface ${index}`,
        spoiler: false,
      },
    });
    expect(added.status()).toBe(200);
    await expect(
      reader.getByRole("button", { name: /New activity/ }),
    ).toBeVisible();
    await expect(
      item.getByText(`Incoming on surface ${index}`, { exact: true }),
    ).toHaveCount(0);
    expect(await ids()).toEqual([saved, id]);
    await action("recommended", false);
    await expect(
      item.getByText("removed their recommendation", { exact: true }),
    ).toBeVisible();
    expect(await ids()).toEqual([saved, id]);
    const anchor = item.getByText("Preview reply 3", { exact: true });
    await anchor.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    const before = (await anchor.boundingBox())!.y;
    await reader.getByRole("button", { name: /New activity/ }).click();
    await expect(
      item.getByText(`Incoming on surface ${index}`, { exact: true }),
    ).toBeVisible();
    expect(await ids()).toEqual([id, saved]);
    await expect
      .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
      .toBeLessThan(3);
    await expect(draft).toHaveValue(`Draft on surface ${index}`);
    await expect(
      item.getByLabel("Contains spoilers", { exact: true }),
    ).toBeChecked();
    await expect(
      item.getByText("Preview reply 0", { exact: true }),
    ).toHaveCount(0);
  }
  await reader.goto(`/titles/movie/987654?item=${id}&reply=${replies[0]}`);
  const target = reader.locator(`[data-comment-id="${replies[0]}"]`);
  await expect(target).toBeVisible();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toHaveCount(0);
  const bounds = (await target.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(
    (await reader.locator(".sidebar").boundingBox())!.height,
  );
  expect(bounds.y).toBeLessThan(844);
  await target.getByRole("button", { name: /Reveal comment/ }).click();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toBeVisible();
  await reader.reload();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toHaveCount(0);
  await reader.goto(`/conversations/${id}?reply=${replies[0]}`);
  await expect(reader).toHaveURL(new RegExp(`item=${id}&reply=${replies[0]}`));
  await expect(target).toBeVisible();
  await expect(
    target.getByText("Preview reply 0", { exact: true }),
  ).toHaveCount(0);
  await reader.context().close();
  await owner.context().close();
});

test("loading activity retains the visible three-reply preview and its reading anchor", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-feed-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "previewowner", { token });
  const reader = await join(browser, "previewreader", { token });
  await befriend(owner, reader, "previewreader", "previewowner");
  const activity = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await activity.json();
  async function reply(body: string) {
    const response = await owner.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: { conversation: id, body, spoiler: false },
    });
    expect(response.status()).toBe(200);
  }
  for (let index = 0; index < 3; index++) await reply(`Reading reply ${index}`);
  await reader.goto("/");
  await expect(reader.locator("[data-comment-id]")).toHaveCount(3);
  const anchor = reader.getByText("Reading reply 0", { exact: true });
  await anchor.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const beforeArrival = (await anchor.boundingBox())!.y;
  await reply("New reply after the preview");
  const incomingItem = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "want_to_watch", value: true },
  });
  expect(incomingItem.status()).toBe(200);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(reader.locator("[data-item-id]")).toHaveCount(1);
  expect(
    Math.abs((await anchor.boundingBox())!.y - beforeArrival),
  ).toBeLessThan(3);
  await anchor.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const before = (await anchor.boundingBox())!.y;
  await reader.getByRole("button", { name: /New activity/ }).click();
  await expect(anchor).toBeVisible();
  await expect(reader.locator("[data-item-id]")).toHaveCount(2);
  await expect(
    reader.getByText("New reply after the preview", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - before))
    .toBeLessThan(3);
  await reader.reload();
  await expect(reader.locator("[data-comment-id]")).toHaveCount(3);
  await expect(anchor).toHaveCount(0);
  await reader.context().close();
  await owner.context().close();
});

test("an unavailable legacy link navigates after friendship restores access", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-feed-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "recoveryowner", { token });
  const reader = await join(browser, "recoveryreader", { token });
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
    waiting.locator(`[data-item-id="${id}"]`).getByLabel("Add your reply"),
  ).toBeVisible();
  await reader.context().close();
  await owner.context().close();
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
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  const { id } = await activity.json();
  await page.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: {
      conversation: id,
      body: "Visible conversation content",
      spoiler: false,
    },
  });
  await page.goto(`/conversations/${id}`);
  const draft = page.getByLabel("Add your reply");
  const replySpoiler = page
    .getByRole("region", { name: "Conversation", exact: true })
    .getByLabel("Contains spoilers", { exact: true });
  await draft.fill("Keep this unsent reply");
  await replySpoiler.check();
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
  await expect(replySpoiler).toBeChecked();
  await page.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(draft).toHaveValue("");
  await page.getByRole("button", { name: /Reveal comment/ }).click();
  await expect(
    page.getByText("Keep this unsent reply", { exact: true }),
  ).toBeVisible();
  const invitation = await page.request.post("/api/screenr/invite", {
    headers: { Origin: browserConfig.baseURL },
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
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "A slow incoming reply", spoiler: false },
  });
  await expect(
    viewer.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: /New activity/ }).click();
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(viewer.getByRole("status")).toContainText(
    "This activity is unavailable.",
  );
  await expect(
    viewer.getByText("A slow incoming reply", { exact: true }),
  ).toHaveCount(0);
  await viewer.unrouteAll({ behavior: "wait" });
  await befriend(page, viewer, "slowviewer", "draftrefresh");
  await viewer.goto(`/conversations/${id}`);
  await viewer.getByLabel("Add your reply").fill("Retain this timed-out draft");
  let requestStarted!: () => void;
  const delayedRequest = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  await viewer.route("**/api/screenr/screen?**", async (route) => {
    requestStarted();
    await delay(15000);
    await route.continue();
  });
  await viewer.bringToFront();
  // Measure the refresh deadline from an actual intercepted request, not
  // from navigation or a background tab's next polling opportunity.
  await delayedRequest;
  await expect(viewer.getByRole("main").getByRole("alert")).toContainText(
    "Refresh timed out. Please try again.",
    { timeout: 12000 },
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
    headers: { Origin: browserConfig.baseURL },
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

test("feed actions persist the viewer's independent recommendation and watch states", async ({
  browser,
}) => {
  const owner = await join(browser, "profileowner");
  const viewer = await join(browser, "profileviewer");
  await befriend(owner, viewer, "profileviewer", "profileowner");
  for (const page of [owner, viewer]) {
    await page.request.post("/api/screenr/activity", {
      headers: { Origin: browserConfig.baseURL },
      data: { title: "movie:987654", field: "recommended", value: true },
    });
  }
  await viewer.goto("/people/profileowner");
  const recommended = viewer.getByRole("button", {
    name: "✓ Recommended",
    exact: true,
  });
  const recommend = viewer.getByRole("button", {
    name: "+ Recommend",
    exact: true,
  });
  await expect(recommended).toBeVisible();
  await recommended.click();
  await expect(recommend).toBeVisible();
  await viewer.reload();
  await expect(recommend).toBeVisible();
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
  await expect(recommend).toBeVisible();
  await recommend.click();
  await expect(recommended).toBeVisible();
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
  const friendEntry = viewer.locator("[data-item-id]").filter({
    has: viewer.getByRole("link", { name: "profileowner", exact: true }),
  });
  await expect(
    friendEntry.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
  await recommended.click();
  await expect(recommend).toBeVisible();
  await recommend.click();
  await expect(recommended).toBeVisible();
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
  await expect(recommended).toBeVisible();
  await viewer.goto("/titles/movie/987654");
  const titleEntry = viewer.locator("[data-item-id]").filter({
    has: viewer.getByRole("link", { name: "profileowner", exact: true }),
  });
  const titleRecommendation = titleEntry.getByRole("button", {
    name: "✓ Recommended",
    exact: true,
  });
  await expect(titleRecommendation).toBeVisible();
  await titleRecommendation.click();
  await expect(
    titleEntry.getByRole("button", { name: "+ Recommend", exact: true }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "Recommend to friends", exact: true }),
  ).toBeVisible();
  await viewer.reload();
  await expect(
    titleEntry.getByRole("button", { name: "+ Recommend", exact: true }),
  ).toBeVisible();
  await titleEntry
    .getByRole("button", { name: "+ Recommend", exact: true })
    .click();
  await expect(titleRecommendation).toBeVisible();
  for (const width of [390, 1440]) {
    await viewer.setViewportSize({ width, height: 900 });
    await titleEntry.scrollIntoViewIfNeeded();
    const watchBounds = await titleEntry
      .getByRole("button", { name: "+ Want to watch", exact: true })
      .boundingBox();
    const recommendBounds = await titleRecommendation.boundingBox();
    expect(recommendBounds!.y).toBeGreaterThanOrEqual(watchBounds!.y);
    if (recommendBounds!.y === watchBounds!.y)
      expect(recommendBounds!.x).toBeGreaterThan(watchBounds!.x);
    expect(recommendBounds!.x + recommendBounds!.width).toBeLessThanOrEqual(
      width,
    );
    await viewer.screenshot({
      path: `.cache/feed-recommend-${width}.png`,
      fullPage: true,
    });
  }
  await owner.goto("/people/profileviewer");
  await expect(
    owner.getByRole("button", { name: "✓ Recommended", exact: true }),
  ).toBeVisible();
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
      headers: { Origin: browserConfig.baseURL },
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
  expect(screen.invitations).toEqual([]);
  await owner.context().close();
  await pending.context().close();
});

async function nestedDiscussion(browser: Browser, suffix: string) {
  const token = (
    await readFile(".cache/browser-nested-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, `nestowner${suffix}`, { token });
  const reader = await join(browser, `nestreader${suffix}`, { token });
  const other = await join(browser, `nestother${suffix}`, { token });
  await befriend(owner, reader, `nestreader${suffix}`, `nestowner${suffix}`);
  await befriend(owner, other, `nestother${suffix}`, `nestowner${suffix}`);
  const response = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  async function write(
    page: Page,
    body: string,
    replyTo?: string,
    spoiler = false,
  ) {
    const result = await page.request.post("/api/screenr/comment", {
      headers: { Origin: browserConfig.baseURL },
      data: { conversation: id, body, replyTo, spoiler },
    });
    expect(result.status()).toBe(200);
    return (await result.json()).id as string;
  }
  const item = reader.locator(`[data-item-id="${id}"]`);
  const comment = (id: string) => item.locator(`[data-comment-id="${id}"]`);
  return { owner, reader, other, id, write, item, comment };
}

test("own nested replies keep their parent when another tab has not accepted new activity", async ({
  browser,
}) => {
  const token = (
    await readFile(".cache/browser-nested-invite.txt", "utf8")
  ).trim();
  const owner = await join(browser, "pendingparentowner", { token });
  const reader = await join(browser, "pendingparentreader", { token });
  await befriend(owner, reader, "pendingparentreader", "pendingparentowner");
  const response = await owner.request.post("/api/screenr/activity", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", field: "recommended", value: true },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  await reader.goto(`/titles/movie/987654?item=${id}`);
  const item = reader.locator(`[data-item-id="${id}"]`);
  await expect(item.getByText("Be the first to reply.")).toBeVisible();
  const parentResponse = await owner.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "Pending parent", spoiler: false },
  });
  expect(parentResponse.status()).toBe(200);
  const { id: parent } = await parentResponse.json();
  const unrelated = await owner.request.post("/api/screenr/comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { conversation: id, body: "Still pending", spoiler: false },
  });
  expect(unrelated.status()).toBe(200);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(item.getByText("Pending parent", { exact: true })).toHaveCount(
    0,
  );

  const otherTab = await reader.context().newPage();
  monitorErrors(otherTab);
  await otherTab.goto(`/titles/movie/987654?item=${id}`);
  await otherTab
    .locator(`[data-comment-id="${parent}"]`)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const composer = otherTab.getByRole("form", {
    name: "Replying to @pendingparentowner",
  });
  await composer.getByRole("textbox").fill("My reply from another tab");
  await composer
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    otherTab.getByText("My reply from another tab", { exact: true }),
  ).toBeVisible();
  await reader.bringToFront();
  await expect(item.getByText("Pending parent", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "View 1 reply", exact: true }).click();
  await expect(
    item.getByText("My reply from another tab", { exact: true }),
  ).toBeVisible();
  await expect(item.getByText("Be the first to reply.")).toHaveCount(0);
  await expect(item.getByText("Still pending", { exact: true })).toHaveCount(0);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await owner.context().close();
  await reader.context().close();
});

test("nested discussions group stored replies, preview direct comments, and keep two composer destinations", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { owner, reader, other, id, write, item, comment } =
    await nestedDiscussion(browser, "layout");
  const first = await write(other, "Old direct comment");
  const root = await write(other, "Parent comment");
  const second = await write(owner, "Unrelated direct comment");
  const child = await write(owner, "Nested spoiler", root, true);
  const third = await write(owner, "Newest direct comment");
  const grandchild = await write(other, "Reply to the nested comment", child);
  for (const [index, path] of [
    "/titles/movie/987654",
    "/",
    "/people/nestownerlayout",
  ].entries()) {
    await reader.setViewportSize(
      index === 1 ? { width: 1280, height: 900 } : { width: 390, height: 844 },
    );
    await reader.goto(path);
    await expect(item.locator("[data-comment-id]")).toHaveCount(3);
    await expect(comment(first)).toHaveCount(0);
    expect(
      await item
        .locator("[data-comment-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-comment-id")),
        ),
    ).toEqual([root, second, third]);
    const expand = item.getByRole("button", {
      name: "View 2 replies",
      exact: true,
    });
    await expand.focus();
    await reader.keyboard.press("Enter");
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    await expect(comment(grandchild)).toBeVisible();
    expect((await comment(child).boundingBox())!.x).toBeGreaterThan(
      (await comment(root).boundingBox())!.x + 10,
    );
    expect((await comment(child).boundingBox())!.x).toBe(
      (await comment(grandchild).boundingBox())!.x,
    );
    expect(
      await item
        .locator("[data-comment-id]")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getAttribute("data-comment-id")),
        ),
    ).toEqual([root, child, grandchild, second, third]);
    await expect(
      comment(child).getByText("Nested spoiler", { exact: true }),
    ).toHaveCount(0);
    await expect(
      comment(grandchild).getByText("Replying to @nestownerlayout", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(index === 1 ? 1280 : 390);
    await reader.screenshot({
      path: `.cache/nested-layout-${index}.png`,
      fullPage: true,
    });
  }
  const direct = item.getByRole("form", {
    name: "Reply to feed item",
    exact: true,
  });
  await direct
    .getByLabel("Add your reply", { exact: true })
    .fill("Direct draft");
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const nested = () => item.getByRole("form", { name: /^Replying to @/ });
  await expect(nested().getByRole("textbox")).toBeFocused();
  expect((await nested().boundingBox())!.y).toBeGreaterThan(
    (await comment(root).boundingBox())!.y,
  );
  expect((await nested().boundingBox())!.y).toBeLessThan(
    (await comment(child).boundingBox())!.y,
  );
  await nested().getByRole("textbox").fill("Draft for parent");
  await comment(child)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested()).toHaveAccessibleName("Replying to @nestownerlayout");
  await expect(nested().getByRole("textbox")).toHaveValue("");
  await nested().getByRole("textbox").fill("Draft for child");
  await nested().getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(nested()).toHaveCount(0);
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for parent");
  await reader.route("**/api/screenr/comment", (route) =>
    route.fulfill({ status: 503, json: { error: "Try this reply again" } }),
  );
  await nested()
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(nested().getByRole("alert")).toHaveText("Try this reply again");
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for parent");
  await reader.unroute("**/api/screenr/comment");
  await direct.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(
    item
      .locator("[data-comment-id]")
      .getByText("Direct draft", { exact: true }),
  ).toBeVisible();
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for parent");
  const groupToggle = item.getByRole("button", {
    name: "View 2 replies",
    exact: true,
  });
  await groupToggle.click();
  await expect(comment(child)).toHaveCount(0);
  await nested()
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(comment(child)).toBeVisible();
  await expect(
    item
      .locator("[data-comment-id]")
      .getByText("Draft for parent", { exact: true }),
  ).toBeVisible();
  await comment(child)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested().getByRole("textbox")).toHaveValue("Draft for child");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await reader.route("**/api/screenr/comment", async (route) => {
    await gate;
    await route.continue();
  });
  await nested()
    .getByRole("button", { name: "Post reply", exact: true })
    .click();
  await expect(
    nested().getByRole("button", { name: "Posting…", exact: true }),
  ).toBeDisabled();
  await nested().getByRole("textbox").fill("Later typing for child");
  await nested().getByRole("button", { name: "Cancel", exact: true }).click();
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await nested().getByRole("textbox").fill("Unsent next reply to parent");
  release();
  await expect(
    item
      .locator("[data-comment-id]")
      .getByText("Draft for child", { exact: true }),
  ).toBeVisible();
  await reader.unroute("**/api/screenr/comment");
  await expect(nested().getByRole("textbox")).toHaveValue(
    "Unsent next reply to parent",
  );
  await comment(child)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(nested().getByRole("textbox")).toHaveValue(
    "Later typing for child",
  );
  await reader.screenshot({
    path: ".cache/nested-composer-mobile.png",
    fullPage: true,
  });
  const saved = await reader.request.get(
    `/api/screenr/screen?path=${encodeURIComponent(`/titles/movie/987654?item=${id}`)}`,
  );
  const screen = await saved.json();
  const comments = screen.conversations.find(
    (c: { id: string }) => c.id === id,
  ).comments;
  expect(
    comments.find((c: { body: string }) => c.body === "Direct draft").root_id,
  ).toBeNull();
  for (const body of ["Draft for parent", "Draft for child"])
    expect(
      comments.find((c: { body: string }) => c.body === body).root_id,
    ).toBe(root);
  await reader.goto(`/titles/movie/987654?item=${id}&reply=${child}`);
  await expect(comment(first)).toBeVisible();
  await expect(comment(child)).toBeInViewport();
  await expect(
    comment(child).getByText("Nested spoiler", { exact: true }),
  ).toHaveCount(0);
  await comment(child)
    .getByRole("button", { name: /Reveal comment/ })
    .click();
  await expect(
    comment(child).getByText("Nested spoiler", { exact: true }),
  ).toBeVisible();
  await reader.goto("/people/nestownerlayout");
  await expect(comment(child)).toHaveCount(0);
  for (const page of [owner, reader, other]) await page.context().close();
});

test("nested updates preserve drafts, expansion, and position while parent access changes immediately", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { owner, reader, other, id, write, item, comment } =
    await nestedDiscussion(browser, "access");
  const root = await write(other, "Parent that will be hidden");
  const child = await write(owner, "Eligible child", root);
  const removed = await write(owner, "Removed nested reply", root);
  expect(
    (
      await owner.request.post("/api/screenr/remove-comment", {
        headers: { Origin: browserConfig.baseURL },
        data: { id: removed },
      })
    ).status(),
  ).toBe(200);
  await reader.goto(`/titles/movie/987654?item=${id}`);
  await item.getByRole("button", { name: "View 1 reply", exact: true }).click();
  await comment(root)
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  const nested = item.getByRole("form", {
    name: "Replying to @nestotheraccess",
    exact: true,
  });
  await nested.getByRole("textbox").fill("Keep this nested draft");
  await item
    .getByRole("form", { name: "Reply to feed item", exact: true })
    .getByRole("textbox")
    .fill("Keep this direct draft");
  await write(owner, "Incoming nested reply", child);
  await expect(
    reader.getByRole("button", { name: /New activity/ }),
  ).toBeVisible();
  await expect(
    item.getByText("Incoming nested reply", { exact: true }),
  ).toHaveCount(0);
  await comment(child).evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const before = (await comment(child).boundingBox())!.y;
  await reader.getByRole("button", { name: /New activity/ }).click();
  await expect(
    item.getByText("Incoming nested reply", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs((await comment(child).boundingBox())!.y - before),
    )
    .toBeLessThan(3);
  await expect(nested.getByRole("textbox")).toHaveValue(
    "Keep this nested draft",
  );
  const otherScreen = await owner.request.get(
    "/api/screenr/screen?path=/people/nestotheraccess",
  );
  const otherId = (await otherScreen.json()).profile.user_id;
  expect(
    (
      await reader.request.post("/api/screenr/relationship", {
        headers: { Origin: browserConfig.baseURL },
        data: { target: otherId, action: "block" },
      })
    ).status(),
  ).toBe(200);
  await expect(
    comment(root).getByText("Comment unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    comment(root).getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (
      await reader.request.post("/api/screenr/reaction", {
        headers: { Origin: browserConfig.baseURL },
        data: { item: id, reply: root, kind: "like" },
      })
    ).status(),
  ).toBe(404);
  const childReactions = comment(child).getByRole("group", {
    name: "Reactions to reply",
    exact: true,
  });
  await childReactions
    .getByRole("button", { name: "React", exact: true })
    .click();
  await childReactions
    .getByRole("button", { name: "Care", exact: true })
    .click();
  await expect(
    childReactions.getByRole("button", { name: "Care: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(item.getByText(/@nestotheraccess/)).toHaveCount(0);
  await expect(
    item.getByText("Parent that will be hidden", { exact: true }),
  ).toHaveCount(0);
  await expect(comment(child)).toBeVisible();
  await expect(
    item
      .getByRole("form", { name: "Reply to feed item", exact: true })
      .getByRole("textbox"),
  ).toHaveValue("Keep this direct draft");
  const data = await reader.request.get(
    `/api/screenr/screen?path=${encodeURIComponent(`/titles/movie/987654?item=${id}`)}`,
  );
  expect(await data.text()).not.toContain("nestotheraccess");
  expect(
    (
      await reader.request.post("/api/screenr/comment", {
        headers: { Origin: browserConfig.baseURL },
        data: {
          conversation: id,
          body: "Reject stale target",
          spoiler: false,
          replyTo: root,
        },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await reader.request.post("/api/screenr/relationship", {
        headers: { Origin: browserConfig.baseURL },
        data: { target: otherId, action: "unblock" },
      })
    ).status(),
  ).toBe(200);
  await expect(nested.getByRole("textbox")).toHaveValue(
    "Keep this nested draft",
  );
  expect(
    (
      await owner.request.post("/api/screenr/remove-comment", {
        headers: { Origin: browserConfig.baseURL },
        data: { id: root },
      })
    ).status(),
  ).toBe(200);
  await expect(
    comment(root).getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await expect(comment(child)).toBeVisible();
  await expect(
    item.getByRole("button", { name: "View 2 replies", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await reader.reload();
  await expect(
    item.getByRole("button", { name: "View 2 replies", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(comment(child)).toHaveCount(0);
  await reader.goto(`/titles/movie/987654?item=${id}&reply=${child}`);
  await expect(comment(child)).toBeInViewport();
  const ownerScreen = await reader.request.get(
    "/api/screenr/screen?path=/people/nestowneraccess",
  );
  expect(
    (
      await reader.request.post("/api/screenr/relationship", {
        headers: { Origin: browserConfig.baseURL },
        data: {
          target: (await ownerScreen.json()).profile.user_id,
          action: "remove",
        },
      })
    ).status(),
  ).toBe(200);
  await expect(item).toHaveCount(0);
  for (const page of [owner, reader, other]) await page.context().close();
});

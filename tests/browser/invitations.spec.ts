import { expect } from "@playwright/test";
import { Pool } from "pg";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { type Member } from "./member-fixture";
import { join } from "./journey-helpers";

async function invitationCreator(member: Member, name: string) {
  const page = await member(name, {
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
  member,
}) => {
  const page = await invitationCreator(member, "copyinvitation");
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
  member,
}) => {
  const owner = await member("invitationowner");
  await owner.goto("/invites");
  await expect
    .soft(owner.getByText(/completes signup.*automatically become friends/))
    .toBeVisible();
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
    complete: false,
  });
  await expect
    .soft(
      guest.getByText(/member’s invitation automatically makes you friends/),
    )
    .toBeVisible();
  await guest.getByLabel("Display name").fill("invitationguest");
  await guest.getByLabel("Username", { exact: true }).fill("invitationguest");
  await guest
    .getByRole("button", { name: "Join Screenr", exact: true })
    .click();
  await expect(
    guest.getByRole("heading", { name: "Better with friends." }),
  ).toBeVisible();
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
  for (const [guestPage, username] of [
    [guest, "invitationguest"],
    [finalGuest, "invitationlast"],
  ] as const) {
    await guestPage.goto("/people/invitationowner");
    await expect(
      guestPage.getByRole("button", { name: "Unfriend", exact: true }),
    ).toBeVisible();
    await owner.goto(`/people/${username}`);
    await expect(
      owner.getByRole("button", { name: "Unfriend", exact: true }),
    ).toBeVisible();
  }
  await guest.goto("/people/invitationlast");
  await expect(
    guest.getByRole("button", { name: "Send friend request", exact: true }),
  ).toBeVisible();
  for (const page of [owner, guest, finalGuest]) await page.context().close();
});

test("invitation links remain manually copyable when clipboard access fails or is unavailable", async ({
  member,
}) => {
  const page = await invitationCreator(member, "copyfallback");
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
  member,
}) => {
  const page = await invitationCreator(member, "shareinvitation");
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

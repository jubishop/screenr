import { nextAccountRefresh } from "./refresh-helpers";
import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { browserConfig } from "../../scripts/browser-config";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { join, signInWithCode } from "./journey-helpers";
import { friend, person } from "./member-fixture";
const { createInvitation } = await import("../../src/server/invitations");
const { addComment, createTitleComment } =
  await import("../../src/server/comments");

const timedOut = "The request timed out. Please try again.";
const unreachable =
  "Could not reach Screenr. Check your connection and try again.";

// Hold a Better Auth request without answering until the page abandons it.
async function stall(page: Page, path: string) {
  let started!: () => void;
  const request = new Promise<void>((resolve) => (started = resolve));
  await page.route(`**/api/auth/${path}`, () => started());
  return request;
}

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

test("a limited code request explains how to continue", async ({ page }) => {
  // The per-IP limit returns Better Auth's generic message; Screenr's caps
  // return this one. Either way the form explains the alternatives.
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
    route.fulfill({
      status: 429,
      json: { message: "Too many requests. Please try again later." },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Email address").fill("limited.browser@example.test");
  const send = page.getByRole("button", {
    name: "Send sign-in code",
    exact: true,
  });
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Too many codes requested. Try again later, or continue with Google.",
  );
  await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveCount(0);
  await expect(send).toBeEnabled();
});

test("stalled email code requests time out and re-enable the sign-in form", async ({
  page,
}) => {
  // Paused timers fire only when the test advances the clock.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.goto("/login");
  const alert = page.getByRole("main").getByRole("alert");
  const waiting = page.getByRole("button", { name: "One moment…" });
  const send = page.getByRole("button", {
    name: "Send sign-in code",
    exact: true,
  });
  await page
    .getByLabel("Email address")
    .fill("stalledcode.browser@example.test");
  const sending = stall(page, "email-otp/send-verification-otp");
  await send.click();
  await sending;
  await expect(waiting).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(alert).toHaveText(timedOut);
  await expect(send).toBeEnabled();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveCount(0);

  await page.unroute("**/api/auth/email-otp/send-verification-otp");
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await send.click();
  await page.getByLabel("Sign-in code", { exact: true }).fill("123456");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  const verifying = stall(page, "sign-in/email-otp");
  await signIn.click();
  await verifying;
  await expect(waiting).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(alert).toHaveText(timedOut);
  await expect(signIn).toBeEnabled();
  await expect(page).toHaveURL(/\/login$/);
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

test("Google signup preserves edited display names across email and Google sign-ins", async ({
  page,
}) => {
  await useTestGoogle(page);
  const { token } = await createInvitation(null, 1);
  const email = "googlefirst.browser@example.test";
  await page.goto(`/join/${token}`);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await approveGoogle(page, email);
  await page.getByLabel("Display name").fill("Google First");
  await page.getByLabel("Username", { exact: true }).fill("googlefirst");
  await page.getByRole("button", { name: "Join Screenr", exact: true }).click();
  await expect(page.getByText("@googlefirst", { exact: true })).toBeVisible();
  await page.goto("/people/googlefirst");
  await page
    .getByRole("button", { name: "Edit display name", exact: true })
    .click();
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Chosen Google Name");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Chosen Google Name", exact: true }),
  ).toBeVisible();
  await page.goto("/account");
  await expect(
    page.getByRole("status").filter({ hasText: "Google connected." }),
  ).toHaveText("Google connected.");
  await expect(
    page.getByRole("button", { name: "Connect Google", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "Google connected." }),
  ).toHaveText("Google connected.");
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
  await page.goto("/people/googlefirst");
  await expect(
    page.getByRole("heading", { name: "Chosen Google Name", exact: true }),
  ).toBeVisible();
  await page.goto("/account");
  await expect(
    page.getByRole("status").filter({ hasText: "Google connected." }),
  ).toHaveText("Google connected.");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Continue with Google", exact: true })
    .click();
  await approveGoogle(page, email);
  await expect(page.getByText("@googlefirst", { exact: true })).toBeVisible();
  await page.goto("/people/googlefirst");
  await expect(
    page.getByRole("heading", { name: "Chosen Google Name", exact: true }),
  ).toBeVisible();
});

test("email members can recover from linking failures, connect Google, and sign back into their profile", async ({
  member,
}) => {
  const page = await member("linkflow");
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
  await expect(
    page.getByRole("banner").getByText("@linkflow", { exact: true }),
  ).toBeVisible();

  await connect.click();
  await approveGoogle(page, "linkflow.browser@example.test");
  await expect(
    page.getByRole("status").filter({ hasText: "Google connected." }),
  ).toHaveText("Google connected.");
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "Google connected." }),
  ).toHaveText("Google connected.");

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await approveGoogle(page, "linkflow.browser@example.test");
  await expect(
    page.getByRole("banner").getByText("@linkflow", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your circle", exact: true }),
  ).toBeVisible();
  await page.context().close();
});

for (const complete of [true, false]) {
  test(`sign-out failures remain visible and retryable from ${complete ? "Account" : "Setup"}`, async ({
    member,
  }) => {
    const page = await member(complete ? "signoutmember" : "signoutpending", {
      complete,
    });
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
      await expect(alert).toHaveText(
        transportFailure ? unreachable : "Sign-out temporarily unavailable.",
      );
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
    await expect(page).toHaveURL(
      complete ? /\/login\?next=%2Faccount$/ : /\/login$/,
    );
    await page.context().close();
  });
}

test("stalled Google link and sign-out requests time out and re-enable Account", async ({
  member,
}) => {
  const page = await member("stalledaccountauth");
  // Paused timers stop polling, and the page load brings the first screen,
  // so the jumps below can expire only the held request's deadline.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.goto("/account");
  const methods = page.getByRole("region", { name: "Sign-in methods" });
  const connect = page.getByRole("button", {
    name: "Connect Google",
    exact: true,
  });
  await expect(connect).toBeEnabled();
  const signOut = page.getByRole("button", { name: "Sign out", exact: true });
  const linking = stall(page, "link-social");
  await connect.click();
  await linking;
  await expect(
    page.getByRole("button", { name: "Connecting…", exact: true }),
  ).toBeDisabled();
  await expect(signOut).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(methods.getByRole("alert")).toHaveText(timedOut);
  await expect(connect).toBeEnabled();
  await expect(signOut).toBeEnabled();

  const signingOut = stall(page, "sign-out");
  await signOut.click();
  await signingOut;
  await expect(signOut).toBeDisabled();
  await expect(connect).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(signOut).toHaveAccessibleDescription(timedOut);
  await expect(signOut).toBeEnabled();
  await expect(connect).toBeEnabled();
  await expect(page).toHaveURL(/\/account$/);

  await page.unroute("**/api/auth/sign-out");
  await page.clock.resume();
  await signOut.click();
  await expect(page).toHaveURL(/\/login$/);
});

test("Google sign-in recovers from transport failure and an empty redirect", async ({
  page,
}) => {
  await useTestGoogle(page);
  const { token } = await createInvitation(null, 1);
  await page.goto(`/join/${token}`);
  const google = page.getByRole("button", { name: "Continue with Google" });
  for (const transportFailure of [true, false]) {
    await page.route("**/api/auth/sign-in/social", (route) =>
      transportFailure
        ? route.abort("failed")
        : route.fulfill({ status: 200, json: {} }),
    );
    await google.click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      transportFailure
        ? unreachable
        : "Google sign-in did not start. Please try again.",
    );
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

test("a signed-out pending member can finish with one visit to a replacement invitation", async ({
  browser,
  member,
}) => {
  const owner = await member("replacementowner");
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
    pending.getByRole("heading", { name: "Your circle", exact: true }),
  ).toBeVisible();
  const screen = await (
    await owner.request.get("/api/screenr/screen?path=/invites")
  ).json();
  expect(screen.invitations).toEqual([]);
  await pending.goto("/people/replacementowner");
  await expect(
    pending.getByRole("link", { name: "Watch together", exact: true }),
  ).toBeVisible();
  await owner.goto("/people/replacementpending");
  await expect(
    owner.getByRole("link", { name: "Watch together", exact: true }),
  ).toBeVisible();
  await owner.context().close();
  await pending.context().close();
});

// A friend's title discussion and its reply, linked as activity email links
// them, below newer discussions.
async function linkedReply(owner: string, tmdbId: number) {
  const title = `movie:${tmdbId}`;
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,'movie',$2,'The Lantern Room') ON CONFLICT DO NOTHING",
    [title, tmdbId],
  );
  const item = await createTitleComment(owner, title, "Who is in?", false);
  const reply = await addComment(owner, item, "The linked reply", false);
  for (let index = 0; index < 3; index++)
    await createTitleComment(owner, title, `Newer discussion ${index}`, false);
  const path = `/titles/movie/${tmdbId}?item=${item}&reply=${reply}`;
  return {
    path,
    login: `/login?next=${encodeURIComponent(path)}`,
    setup: `/setup?next=${encodeURIComponent(path)}`,
    reply: `#comment-${reply}`,
  };
}

async function expectReply(page: Page, link: { path: string; reply: string }) {
  await expect(page).toHaveURL(link.path);
  const reply = page.locator(link.reply);
  await expect(reply).toBeInViewport();
  await expect(
    reply.getByText("The linked reply", { exact: true }),
  ).toBeVisible();
}

test("a signed-out member returns to a linked reply after email sign-in and session expiry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useTestGoogle(page);
  const reader = await person("returnreader");
  const owner = await person("returnowner");
  await friend(owner, reader);
  const link = await linkedReply(owner, 996134);
  await page.goto(link.setup);
  await expect(page).toHaveURL(link.login);
  await page.goto(link.path);
  await expect(page).toHaveURL(link.login);
  // A failed Google attempt keeps the return path for the next method.
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(`${link.login}&error=access_denied`);
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await signInWithCode(page, "returnreader@example.test");
  await expectReply(page, link);

  // The next background refresh after the session ends returns here too.
  await db.query('DELETE FROM session WHERE "userId"=$1', [reader]);
  await expect(page).toHaveURL(link.login);
  await signInWithCode(page, "returnreader@example.test");
  await expectReply(page, link);
});

test("an invited Google signup returns to a linked reply, and sign-in ignores external return paths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await useTestGoogle(page);
  const owner = await person("googlereturnowner");
  const { token } = await createInvitation(owner, 1);
  const link = await linkedReply(owner, 996135);
  await page.goto(`/join/${token}`);
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(link.path);
  await expect(page).toHaveURL(link.login);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await approveGoogle(page, "googlereturn.browser@example.test");
  await expect(page).toHaveURL(link.setup);
  // A signed-in account without a profile finishes setup first.
  await page.goto(link.path);
  await expect(page).toHaveURL(link.setup);
  await page.getByLabel("Display name").fill("Google Return");
  await page.getByLabel("Username", { exact: true }).fill("googlereturn");
  await page.getByRole("button", { name: "Join Screenr", exact: true }).click();
  await expectReply(page, link);

  for (const next of [
    "https://evil.example/titles/movie/996135",
    "//evil.example/titles/movie/996135",
    "/\\evil.example/titles/movie/996135",
  ]) {
    await page.goto("/account");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await approveGoogle(page, "googlereturn.browser@example.test");
    await expect(
      page.getByRole("heading", { name: "Your circle", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${browserConfig.baseURL}/`);
  }
});

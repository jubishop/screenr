import { expect, type Page, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test as databaseTest, db } from "./database-fixture";
import { browserConfig } from "../../scripts/browser-config";

const { createAuth } = await import("../../src/server/auth");
const { createInvitation, invitationHash, completeSignup } =
  await import("../../src/server/invitations");

type MemberOptions = {
  displayName?: string;
  complete?: boolean;
  token?: string;
  hasTouch?: boolean;
};
type SignIn = (
  page: Page,
  username: string,
  options?: MemberOptions,
) => Promise<string>;
export type Member = (
  username: string,
  options?: MemberOptions,
) => Promise<Page>;

// Each test uses distinct users, invitations, contexts, and in-memory email codes.
// Rows live for one harness run; browser-server resets its locked, checkout-local
// database before any test starts. No test resets or deletes shared data.
// Authentication still issues real signed session cookies, which the running
// application validates normally. Only the external email delivery is replaced.
export const test = databaseTest.extend<{ signIn: SignIn; member: Member }>({
  signIn: async ({}, use) => {
    const errors: string[] = [];
    try {
      await use(async (page, username, options = {}) => {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (
            message.type() === "error" &&
            /hydration|didn.t match/i.test(message.text())
          )
            errors.push(message.text());
        });
        const id = randomUUID();
        const email = `${username}.browser@example.test`;
        let token = options.token;
        if (!token) {
          const invitation = await createInvitation(null, 1);
          token = invitation.token;
        }
        await db.query(
          `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt","invitationHash")
           VALUES($1,$2,$3,true,now(),now(),$4)`,
          [id, username, email, invitationHash(token)],
        );
        if (options.complete !== false)
          await completeSignup(
            id,
            options.displayName ?? username,
            username,
            token,
          );
        let code = "";
        const auth = createAuth({
          rateLimit: false,
          sendCode: async ({ otp }) => {
            code = otp;
          },
        });
        const post = (path: string, body: unknown) =>
          auth.handler(
            new Request(`${browserConfig.baseURL}/api/auth/${path}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: browserConfig.baseURL,
              },
              body: JSON.stringify(body),
            }),
          );
        const sent = await post("email-otp/send-verification-otp", {
          email,
          type: "sign-in",
        });
        expect(sent.status).toBe(200);
        expect(code).not.toBe("");
        const signedIn = await post("sign-in/email-otp", { email, otp: code });
        expect(signedIn.status).toBe(200);
        await page.context().addCookies(
          signedIn.headers.getSetCookie().map((cookie) => {
            const pair = cookie.split(";", 1)[0];
            const separator = pair.indexOf("=");
            return {
              name: pair.slice(0, separator),
              value: pair.slice(separator + 1),
              url: browserConfig.baseURL,
              httpOnly: true,
              sameSite: "Lax" as const,
            };
          }),
        );
        await page.goto(options.complete === false ? "/setup" : "/");
        if (options.complete === false)
          await expect(
            page.getByLabel("Username", { exact: true }),
          ).toBeVisible();
        else
          await expect(
            page.getByRole("heading", { name: "Better with friends." }),
          ).toBeVisible();
        return id;
      });
    } finally {
      expect(errors).toEqual([]);
    }
  },
  member: async ({ browser, signIn }, use) => {
    const contexts: BrowserContext[] = [];
    try {
      await use(async (username, options = {}) => {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          timezoneId: "America/Los_Angeles",
          hasTouch: options.hasTouch,
        });
        contexts.push(context);
        const page = await context.newPage();
        await page.route("https://www.youtube.com/embed/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "Trailer player fixture",
          }),
        );
        await signIn(page, username, options);
        return page;
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
});

export async function prepareFriendship(a: Page, b: Page) {
  const session = async (page: Page) => {
    const response = await page.request.get("/api/auth/get-session");
    expect(response.status()).toBe(200);
    return (await response.json()).user.id as string;
  };
  const [aId, bId] = await Promise.all([session(a), session(b)]);
  for (const [page, target, action] of [
    [a, bId, "request"],
    [b, aId, "accept"],
  ] as const) {
    const response = await page.request.post("/api/screenr/relationship", {
      headers: { Origin: browserConfig.baseURL },
      data: { target, action },
    });
    expect(response.status()).toBe(200);
  }
}

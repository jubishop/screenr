import { expect } from "@playwright/test";
import { test } from "./database-fixture";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { browserConfig } from "../../scripts/browser-config";

const { createInvitation } = await import("../../src/server/invitations");

test("invitation links expose rich previews without cookies or JavaScript", async ({
  browser,
  baseURL,
}) => {
  const { token } = await createInvitation(null, 1);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    for (const userAgent of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      "facebookexternalhit/1.1",
      "Twitterbot/1.0",
    ]) {
      // Native fetch follows HTTP redirects without retaining invitation cookies.
      const response = await fetch(new URL(`/join/${token}`, baseURL), {
        headers: { "User-Agent": userAgent },
      });
      expect(response.status).toBe(200);
      expect(response.url).toBe(`${baseURL}/login`);
      const html = await response.text();
      expect(Buffer.byteLength(html)).toBeLessThan(1_000_000);
      await page.setContent(html);
      const head = page.locator("head");
      await expect(head.locator('meta[property="og:title"]')).toHaveAttribute(
        "content",
        "Your next great watch starts with a friend.",
      );
      await expect(
        head.locator('meta[property="og:description"]'),
      ).toHaveAttribute(
        "content",
        "Find your next movie or show through your friends.",
      );
      await expect(
        head.locator('meta[property="og:site_name"]'),
      ).toHaveAttribute("content", "Screenr");
      await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute(
        "content",
        "summary_large_image",
      );
      await expect(head.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex/,
      );
      expect(await head.innerHTML()).not.toContain(token);
      // Do not tell clients to replace the shared invite with the login URL.
      await expect(head.locator('meta[property="og:url"]')).toHaveCount(0);
      await expect(head.locator('link[rel="canonical"]')).toHaveCount(0);

      const imageURL = await head
        .locator('meta[property="og:image"]')
        .getAttribute("content");
      expect(imageURL).toBeTruthy();
      // Development metadata uses Next's own origin; production uses the
      // configured public origin. Keep an exact expectation in both modes.
      expect(new URL(imageURL!).origin).toBe(
        browserConfig.mode === "development" ? browserConfig.appURL : baseURL,
      );
      const image = await fetch(imageURL!);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      const bytes = Buffer.from(await image.arrayBuffer());
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(bytes.readUInt32BE(16)).toBe(1200);
      expect(bytes.readUInt32BE(20)).toBe(630);
      expect(bytes.length).toBeLessThan(1_000_000);
      await expect(head.locator('meta[name="twitter:image"]')).toHaveAttribute(
        "content",
        imageURL!,
      );
    }
  } finally {
    await context.close();
  }
});

test("preview fetches preserve invitation eligibility and the recipient signup cookie", async ({
  request,
  baseURL,
}) => {
  const { token } = await createInvitation(null, 1);
  const database = new Pool({ connectionString: browserConfig.databaseURL });
  const hash = createHash("sha256").update(token).digest("hex");
  try {
    const before = await database.query(
      "SELECT uses FROM invitation WHERE token_hash=$1",
      [hash],
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await fetch(new URL(`/join/${token}`, baseURL))).status).toBe(
        200,
      );
    }
    const recipient = await request.get(`/join/${token}`, { maxRedirects: 0 });
    expect(recipient.status()).toBe(307);
    expect(recipient.headers().location).toBe(`${baseURL}/login`);
    expect(recipient.headers()["cache-control"]).toBe("private, no-store");
    expect(recipient.headers()["referrer-policy"]).toBe("no-referrer");
    const cookie = (await request.storageState()).cookies.find(
      (cookie) => cookie.name === "screenr-invite",
    );
    expect(cookie).toMatchObject({
      value: token,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(await (await request.get("/login")).text()).toContain(
      "You’re invited.",
    );
    const after = await database.query(
      "SELECT uses FROM invitation WHERE token_hash=$1",
      [hash],
    );
    expect(after.rows).toEqual(before.rows);
    expect(before.rowCount).toBe(1);

    const invalid = await fetch(new URL("/join/not-an-invitation", baseURL));
    expect(invalid.url).toBe(`${baseURL}/login?invitation=unavailable`);
    expect(await invalid.text()).toContain(
      "That invitation is no longer available.",
    );
  } finally {
    await database.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { useDatabase, db, cookieFor, pending, person } from "./social-fixture";
import { hang } from "./process-waits";
const { createInvitation, invitationHash } =
  await import("../../src/server/invitations");
const join = await import("../../src/app/join/[token]/route");
const pickup = await import("../../src/app/api/invitation-pickup/route");
const pickupDone =
  await import("../../src/app/api/invitation-pickup/done/route");

useDatabase();

// Invitation links install the app on iPhone
// (docs/ios-app.md#invitation-links-install-the-app-on-iphone--2026-11-07):
// /join saves the invitation in Safari and sends an iPhone to the install
// link, and the app's web authentication session, which shares Safari's
// cookies, picks the invitation up after the install.

const origin = "http://localhost:3000";
const install = "https://testflight.apple.com/join/TESTCODE";
const browsers = {
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  // An iPad's Safari presents itself as a Mac.
  iPad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  desktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

function withInstallLink(value: string | undefined) {
  const previous = process.env.SCREENR_IPHONE_INSTALL_URL;
  if (value === undefined) delete process.env.SCREENR_IPHONE_INSTALL_URL;
  else process.env.SCREENR_IPHONE_INSTALL_URL = value;
  return () => {
    if (previous === undefined) delete process.env.SCREENR_IPHONE_INSTALL_URL;
    else process.env.SCREENR_IPHONE_INSTALL_URL = previous;
  };
}

async function open(
  token: string,
  userAgent: string,
  headers: Record<string, string> = {},
) {
  return join.GET(
    new Request(`${origin}/join/${token}`, {
      headers: { "User-Agent": userAgent, ...headers },
    }),
    { params: Promise.resolve({ token }) },
  );
}

function savedInvitation(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("screenr-invite="));
  return cookie?.split(";", 1)[0].slice("screenr-invite=".length);
}

test("an iPhone opening a valid invitation saves it and goes to the install link", async (t) => {
  t.after(withInstallLink(install));
  const { token } = await createInvitation(null, 2);
  const response = await open(token, browsers.iPhone);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Location"), install);
  assert.equal(savedInvitation(response), token);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("screenr-invite="));
  assert.match(cookie!, /; Max-Age=2592000/);
  assert.match(cookie!, /; HttpOnly/);
  assert.match(cookie!, /; SameSite=lax/i);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  // Opening the link uses nothing up.
  const { rows } = await db.query(
    "SELECT uses FROM invitation WHERE token_hash=$1",
    [invitationHash(token)],
  );
  assert.deepEqual(rows, [{ uses: 0 }]);
});

test("other devices, unavailable invitations, and signed-in people keep the web's join", async (t) => {
  t.after(withInstallLink(install));
  const { token } = await createInvitation(null, 2);
  for (const browser of [browsers.iPad, browsers.android, browsers.desktop]) {
    const response = await open(token, browser);
    assert.equal(response.headers.get("Location"), `${origin}/login`, browser);
    assert.equal(savedInvitation(response), token, browser);
  }

  const used = await createInvitation(null, 1);
  await db.query("UPDATE invitation SET uses=max_uses WHERE token_hash=$1", [
    invitationHash(used.token),
  ]);
  for (const unavailable of [used.token, "a".repeat(43), "not-a-token"]) {
    const response = await open(unavailable, browsers.iPhone);
    assert.equal(
      response.headers.get("Location"),
      `${origin}/login?invitation=unavailable`,
      unavailable,
    );
    assert.equal(savedInvitation(response), undefined, unavailable);
  }

  const member = await cookieFor(await person("iphonemember"));
  const signedIn = await open(token, browsers.iPhone, { Cookie: member });
  assert.equal(signedIn.headers.get("Location"), `${origin}/`);
  assert.equal(savedInvitation(signedIn), undefined);

  // A pending account signed in on the web finishes setup there.
  const account = await cookieFor(await pending("iphonepending", token));
  const pendingSetup = await open(token, browsers.iPhone, { Cookie: account });
  assert.equal(pendingSetup.headers.get("Location"), `${origin}/setup`);
  assert.equal(savedInvitation(pendingSetup), token);
});

test("without an https install link, an iPhone keeps the web's join", async (t) => {
  const { token } = await createInvitation(null, 2);
  for (const setting of [undefined, "", "http://testflight.example", "nope"]) {
    const restore = withInstallLink(setting);
    t.after(restore);
    const response = await open(token, browsers.iPhone);
    assert.equal(
      response.headers.get("Location"),
      `${origin}/login`,
      String(setting),
    );
    assert.equal(savedInvitation(response), token);
    restore();
  }
});

function pickUp(cookie?: string) {
  return pickup.GET(
    new NextRequest(`${origin}/api/invitation-pickup`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
  );
}

test("the pickup hands the saved invitation to the app's callback once", async () => {
  const { token } = await createInvitation(null, 1);
  const saved = await open(token, browsers.iPhone);
  const response = await pickUp(`screenr-invite=${savedInvitation(saved)}`);
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("Location"),
    `${origin}/api/invitation-pickup/done?token=${token}`,
  );
  const cleared = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("screenr-invite="));
  assert.ok(cleared, "The pickup clears the invitation cookie.");
  assert.match(cleared, /^screenr-invite=;/);
  assert.match(cleared, /; Max-Age=0/);
  assert.match(cleared, /; Path=\//);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("the pickup answers the callback without a token when Safari saved none", async () => {
  const none = await pickUp();
  assert.equal(
    none.headers.get("Location"),
    `${origin}/api/invitation-pickup/done`,
  );
  assert.deepEqual(none.headers.getSetCookie(), []);
  assert.equal(none.headers.get("Cache-Control"), "private, no-store");

  // A malformed value is no invitation, and it goes too.
  const malformed = await pickUp("screenr-invite=not-a-token; other=1");
  assert.equal(
    malformed.headers.get("Location"),
    `${origin}/api/invitation-pickup/done`,
  );
  assert.match(malformed.headers.getSetCookie()[0], /^screenr-invite=;/);
});

test("a browser that follows the pickup's callback lands on the home page", async () => {
  const response = pickupDone.GET();
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("Location"), `${origin}/`);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("deployment rejects an iPhone install link that is not an https URL", async () => {
  const env = {
    ...process.env,
    BETTER_AUTH_URL: "https://screenr.example",
    BETTER_AUTH_SECRET: "x".repeat(32),
    DATABASE_URL: "postgres://localhost/screenr",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    TMDB_READ_TOKEN: "token",
    EMAIL_TRANSPORT: "resend",
    EMAIL_FROM: "Screenr <screenr@example.test>",
    RESEND_API_KEY: "key",
  };
  const check = (link: string) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/validate-config.ts"],
      { env: { ...env, SCREENR_IPHONE_INSTALL_URL: link }, timeout: hang },
    );
  await Promise.all([
    ...["", install].map(check),
    ...[
      "http://testflight.apple.com/join/TESTCODE",
      "testflight",
      "https:",
    ].map((link) =>
      assert.rejects(check(link), (error: { stderr: string }) => {
        assert.match(
          error.stderr,
          /SCREENR_IPHONE_INSTALL_URL must be an https URL\./,
        );
        return true;
      }),
    ),
  ]);
});

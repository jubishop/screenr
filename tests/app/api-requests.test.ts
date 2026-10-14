import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  useDatabase,
  db,
  denied,
  assertRouteError,
  person,
  cookieFor,
  bearerFor,
  signIn,
} from "./social-fixture";

const { POST, GET } = await import("../../src/app/api/screenr/[action]/route");
const { auth } = await import("../../src/server/auth");
const { GET: photoRoute } =
  await import("../../src/app/api/photos/[user]/[version]/route");
const { initialScreen } = await import("../../src/server/screens");
useDatabase();

const origin = "http://localhost:3000";

function send(
  action: string,
  cookie: string,
  body?: BodyInit,
  requestOrigin: string | null = origin,
  extra: Record<string, string> = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Cookie: cookie,
    ...extra,
  });
  if (requestOrigin) headers.set("Origin", requestOrigin);
  // Node requires half duplex for streamed bodies; the DOM types omit it.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body,
    duplex: "half",
  };
  return POST(new Request(`${origin}/api/screenr/${action}`, init), {
    params: Promise.resolve({ action }),
  });
}

function get(
  action: string,
  cookie: string,
  query = "",
  extra: Record<string, string> = {},
) {
  return GET(
    new Request(`${origin}/api/screenr/${action}${query}`, {
      headers: { Cookie: cookie, ...extra },
    }),
    { params: Promise.resolve({ action }) },
  );
}

function photo(cookie: string, extra: Record<string, string> = {}) {
  const params = { user: "someone", version: "v1" };
  return photoRoute(
    new Request(`${origin}/api/photos/${params.user}/${params.version}`, {
      headers: { Cookie: cookie, ...extra },
    }),
    { params: Promise.resolve(params) },
  );
}

const tooLarge = { status: 413, message: "Request too large." };

// A JSON object for activity-email whose UTF-8 encoding has exactly `bytes`.
function sized(bytes: number, enabled: boolean) {
  const base = Buffer.byteLength(JSON.stringify({ enabled, pad: "" }));
  const body = JSON.stringify({ enabled, pad: "x".repeat(bytes - base) });
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

async function activityEmail(user: string) {
  return (
    await db.query("SELECT activity_email FROM profile WHERE user_id=$1", [
      user,
    ])
  ).rows[0].activity_email;
}

test("API route rejects missing, malformed, and non-object JSON bodies", async () => {
  const cookie = await cookieFor(await person("alice"));
  await assertRouteError(await send("activity-email", cookie), {
    status: 400,
    message: "A request body is required.",
  });
  for (const body of ["", "{", "enabled=true", "[]", "null", '"on"', "1"])
    await assertRouteError(await send("activity-email", cookie, body), {
      status: 400,
      message: "Invalid request.",
    });
});

test("API route accepts 16,000-byte bodies and rejects larger ones with 413", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  const accepted = await send("activity-email", cookie, sized(16_000, false));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { activityEmail: false });

  const multibyte = JSON.stringify({ enabled: true, pad: "é".repeat(8_000) });
  assert.ok(multibyte.length < 16_000);
  for (const body of [sized(16_001, true), multibyte])
    await assertRouteError(
      await send("activity-email", cookie, body),
      tooLarge,
    );
  assert.equal(await activityEmail(alice), false);
});

test("API route stops reading a streamed body once it passes the limit", async () => {
  const cookie = await cookieFor(await person("alice"));
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 1_000_000) return controller.close();
      sent += 1_000;
      controller.enqueue(new TextEncoder().encode(" ".repeat(1_000)));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assertRouteError(await send("activity-email", cookie, body), tooLarge);
  assert.equal(cancelled, true);
  assert.ok(sent <= 18_000, `read ${sent} bytes`);
});

test("API route returns 404 for unknown actions and for actions sent with the wrong method", async () => {
  const cookie = await cookieFor(await person("alice"));
  for (const response of [
    await get("unknown", cookie),
    await send("unknown", cookie, "{}"),
    await get("reaction", cookie),
    await send("search", cookie, "{}"),
  ])
    await assertRouteError(response, {
      status: 404,
      message: "Action not found.",
    });
});

test("API route checks origin and session before reading request bodies", async () => {
  const cookie = await cookieFor(await person("alice"));
  for (const body of [sized(16_001, true), "{"]) {
    await assertRouteError(
      await send("activity-email", cookie, body, "https://outside.example"),
      denied.origin,
    );
    await assertRouteError(
      await send("activity-email", cookie, body, null),
      denied.origin,
    );
    await assertRouteError(
      await send("activity-email", "", body),
      denied.signedOut,
    );
  }
});

// The member page responds 404 when its loader reports one, so open tabs on a
// missing page get the same status from the page and from each refresh.
test("missing member pages return 404 from the screen API and the page loader", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  for (const [path, message] of [
    ["/titles/movie/not-a-title", "Title not found."],
    ["/people/nobody", "Person not found."],
    ["/nothing/here", "Page not found."],
  ]) {
    await assertRouteError(
      await get("screen", cookie, `?path=${encodeURIComponent(path)}`),
      { status: 404, message },
    );
    assert.deepEqual(await initialScreen(alice, path), {
      data: null,
      error: message,
      status: 404,
    });
  }
  const found = await initialScreen(alice, "/people/alice");
  assert.equal(found.status, 200);
  assert.equal(found.data?.kind, "profile");
});

// The iPhone app authenticates with `Authorization: Bearer <token>` and sends
// neither a cookie nor an Origin.
function native(
  action: string,
  authorization: string,
  options: { body?: string; query?: string; cookie?: string } = {},
) {
  const { body, query = "", cookie } = options;
  const headers = new Headers({ Authorization: authorization });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const request = new Request(`${origin}/api/screenr/${action}${query}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
  });
  return (body === undefined ? GET : POST)(request, {
    params: Promise.resolve({ action }),
  });
}

const profilePath = `?path=${encodeURIComponent("/people/alice")}`;

function signOut(authorization: string) {
  return auth().handler(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { Authorization: authorization },
    }),
  );
}

// The stored session row that a bearer token names.
async function sessionRow(token: string) {
  const id = decodeURIComponent(token).split(".")[0];
  return (
    await db.query(
      `SELECT "userId", extract(epoch FROM "expiresAt"-now())::int AS seconds
      FROM session WHERE token=$1`,
      [id],
    )
  ).rows[0];
}

test("a bearer session reads screens and runs POST actions without a cookie or Origin", async () => {
  const alice = await person("alice");
  const token = await bearerFor(alice);

  const screen = await native("screen", `Bearer ${token}`, {
    query: profilePath,
  });
  assert.equal(screen.status, 200);
  assert.equal((await screen.json()).kind, "profile");

  const saved = await native("activity-email", `Bearer ${token}`, {
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { activityEmail: true });
  assert.equal(await activityEmail(alice), true);
});

test("only a sign-in without an Origin returns its session token in set-auth-token", async () => {
  const alice = await person("alice");
  const web = await signIn(alice, { Origin: origin });
  assert.equal(web.headers.get("set-auth-token"), null);
  assert.ok(web.headers.getSetCookie().length > 0);
  const native = await signIn(alice, {});
  assert.match(native.headers.get("set-auth-token") ?? "", /^[\w-]+\./);
});

test("bearer sessions are the web's session rows, with the same 30-day lifetime", async () => {
  const alice = await person("alice");
  const row = await sessionRow(await bearerFor(alice));
  assert.equal(row.userId, alice);
  const days = row.seconds / 86_400;
  assert.ok(days > 29.99 && days <= 30, `expires in ${days} days`);
});

test("cookie requests keep the Origin check, and a bearer request never signs in with its cookie", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  const body = JSON.stringify({ enabled: true });
  for (const authorization of ["Basic YWxpY2U6c2VjcmV0", "Bearerish token"])
    await assertRouteError(
      await native("activity-email", authorization, { body, cookie }),
      denied.origin,
    );
  for (const authorization of ["Bearer not-a-token", "Bearer"]) {
    await assertRouteError(
      await native("activity-email", authorization, { body, cookie }),
      denied.signedOut,
    );
    await assertRouteError(
      await native("screen", authorization, { query: profilePath, cookie }),
      denied.signedOut,
    );
  }
  assert.equal(await activityEmail(alice), false);
});

test("invalid, unsigned, and signed-out bearer tokens get 401", async () => {
  const alice = await person("alice");
  const token = await bearerFor(alice);
  const other = await bearerFor(alice);
  // The live session's stored token, without or with a forged signature.
  const unsigned = decodeURIComponent(other).split(".")[0];
  const tampered = `${unsigned}.${"A".repeat(43)}`;

  const signedOut = await signOut(`Bearer ${token}`);
  assert.equal(signedOut.status, 200);
  assert.equal(await sessionRow(token), undefined);

  for (const bad of ["not-a-token", tampered, unsigned, token]) {
    await assertRouteError(
      await native("screen", `Bearer ${bad}`, { query: profilePath }),
      denied.signedOut,
    );
    await assertRouteError(
      await native("activity-email", `Bearer ${bad}`, {
        body: JSON.stringify({ enabled: true }),
      }),
      denied.signedOut,
    );
  }
  assert.equal(await activityEmail(alice), false);

  // Signing out ends only that session, and the other one's signed token
  // still works.
  const remaining = await native("screen", `Bearer ${other}`, {
    query: profilePath,
  });
  assert.equal(remaining.status, 200);
});

// The iPhone app names its build on every request, and the server refuses
// builds below a configured minimum: docs/data-and-access.md#client-headers
function minimumBuild(t: TestContext) {
  const previous = process.env.SCREENR_IOS_MINIMUM_BUILD;
  const set = (value: string | undefined) => {
    if (value === undefined) delete process.env.SCREENR_IOS_MINIMUM_BUILD;
    else process.env.SCREENR_IOS_MINIMUM_BUILD = value;
  };
  t.after(() => set(previous));
  return set;
}
const app = (build: string) => ({ "Screenr-Client": `ios/1.4.0/${build}` });

test("iPhone app builds below the minimum get 426 before any other check", async (t) => {
  minimumBuild(t)("42");
  // Signed out, without an origin, and with an invalid body: the build check
  // answers first.
  for (const response of [
    await get("screen", "", "?path=%2F", app("41")),
    await send("activity-email", "", "{", null, app("41")),
    await send("unknown", "", "{", null, app("7")),
    await photo("", app("41")),
  ]) {
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      error: "Update Screenr to continue.",
      minimumBuild: 42,
    });
  }
});

test("iPhone app builds at or above the minimum, and requests without the client header, are served as before", async (t) => {
  const setMinimum = minimumBuild(t);
  const cookie = await cookieFor(await person("alice"));
  const enable = JSON.stringify({ enabled: true });
  for (const [minimum, clients] of [
    ["42", [{}, app("42"), app("43"), app("100000")]],
    // Without a usable minimum, every build is served.
    [undefined, [app("0"), app("1")]],
    ["", [app("1")]],
    ["not a build", [app("1")]],
  ] as const) {
    setMinimum(minimum);
    for (const client of clients) {
      const label = `${minimum} ${JSON.stringify(client)}`;
      const read = await get("notifications", cookie, "", client);
      assert.equal(read.status, 200, label);
      const saved = await send(
        "activity-email",
        cookie,
        enable,
        origin,
        client,
      );
      assert.equal(saved.status, 200, label);
      assert.deepEqual(await saved.json(), { activityEmail: true });
      // A signed-out photo request reaches the session check.
      assert.equal((await photo("", client)).status, 401, label);
    }
  }
});

test("a client header that does not name an iPhone app build gets 400", async () => {
  const cookie = await cookieFor(await person("alice"));
  for (const client of [
    "",
    "ios",
    "ios/1.4.0",
    "ios/1.4.0/",
    "ios//42",
    "ios/1.4.0/42/1",
    "ios/1.4.0/4.2",
    "ios/1.4.0/forty-two",
    "ios/1.4.0/1234567890123456",
    "android/1.4.0/42",
  ]) {
    const headers = { "Screenr-Client": client };
    for (const response of [
      await get("notifications", cookie, "", headers),
      await photo(cookie, headers),
    ])
      await assertRouteError(response, {
        status: 400,
        message: "Invalid client header.",
      });
  }
});

const generatedId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("API responses echo the client's request ID, or carry a new one", async (t) => {
  minimumBuild(t)("42");
  const cookie = await cookieFor(await person("alice"));
  // Successes, expected errors, and the client header checks.
  const responses = async (id: Record<string, string>) => [
    await get("notifications", cookie, "", id),
    await send("activity-email", cookie, '{"enabled":true}', origin, id),
    await send("activity-email", cookie, "{", origin, id),
    await get("unknown", cookie, "", id),
    await photo(cookie, id),
    await photo("", id),
    await get("notifications", "", "", { ...id, ...app("41") }),
    await get("notifications", cookie, "", { ...id, "Screenr-Client": "ios" }),
  ];
  for (const sent of ["6F9619FF-8B86-D011-B42D-00C04FC964FF", "a", "A_b-9"])
    for (const response of await responses({ "Screenr-Request-Id": sent }))
      assert.equal(response.headers.get("Screenr-Request-Id"), sent);

  // A missing, empty, or unsafe ID is replaced, never echoed.
  const seen = new Set<string>();
  for (const sent of [
    undefined,
    "",
    "x".repeat(65),
    "two words",
    '"quoted"',
    "<id>",
  ]) {
    const id: Record<string, string> =
      sent === undefined ? {} : { "Screenr-Request-Id": sent };
    for (const response of await responses(id)) {
      const echoed = response.headers.get("Screenr-Request-Id") ?? "";
      assert.match(echoed, generatedId);
      assert.ok(!seen.has(echoed), "Each request gets its own ID");
      seen.add(echoed);
    }
  }
});

test("deployment rejects a minimum iPhone build that is not a whole number", async () => {
  const env = {
    ...process.env,
    BETTER_AUTH_URL: "https://screenr.example",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    TMDB_READ_TOKEN: "token",
    EMAIL_TRANSPORT: "resend",
    EMAIL_FROM: "Screenr <screenr@example.test>",
    RESEND_API_KEY: "key",
  };
  const check = (minimum: string) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/validate-config.ts"],
      { env: { ...env, SCREENR_IOS_MINIMUM_BUILD: minimum }, timeout: 15_000 },
    );
  await Promise.all([
    ...["", "42"].map(check),
    ...["42a", "4.2", "-1", "1e3", "1234567890123456"].map((minimum) =>
      assert.rejects(check(minimum), (error: { stderr: string }) => {
        assert.match(
          error.stderr,
          /SCREENR_IOS_MINIMUM_BUILD must be a whole number of at most 15 digits\./,
        );
        return true;
      }),
    ),
  ]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
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
const { initialScreen } = await import("../../src/server/screens");
useDatabase();

const origin = "http://localhost:3000";

function send(
  action: string,
  cookie: string,
  body?: BodyInit,
  requestOrigin: string | null = origin,
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Cookie: cookie,
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

function get(action: string, cookie: string, query = "") {
  return GET(
    new Request(`${origin}/api/screenr/${action}${query}`, {
      headers: { Cookie: cookie },
    }),
    { params: Promise.resolve({ action }) },
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

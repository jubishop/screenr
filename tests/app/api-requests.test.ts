import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  denied,
  assertRouteError,
  person,
  cookieFor,
} from "./social-fixture";

const { POST, GET } = await import("../../src/app/api/screenr/[action]/route");
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

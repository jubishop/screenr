import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, person, cookieFor } from "./social-fixture";

const { POST, GET } = await import("../../src/app/api/screenr/[action]/route");
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

function get(action: string, cookie: string) {
  return GET(
    new Request(`${origin}/api/screenr/${action}`, {
      headers: { Cookie: cookie },
    }),
    { params: Promise.resolve({ action }) },
  );
}

async function rejected(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
}

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
  await rejected(
    await send("activity-email", cookie),
    400,
    "A request body is required.",
  );
  for (const body of ["", "{", "enabled=true", "[]", "null", '"on"', "1"])
    await rejected(
      await send("activity-email", cookie, body),
      400,
      "Invalid request.",
    );
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
    await rejected(
      await send("activity-email", cookie, body),
      413,
      "Request too large.",
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
  await rejected(
    await send("activity-email", cookie, body),
    413,
    "Request too large.",
  );
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
    await rejected(response, 404, "Action not found.");
});

test("API route checks origin and session before reading request bodies", async () => {
  const cookie = await cookieFor(await person("alice"));
  for (const body of [sized(16_001, true), "{"]) {
    await rejected(
      await send("activity-email", cookie, body, "https://outside.example"),
      403,
      "Invalid request origin.",
    );
    await rejected(
      await send("activity-email", cookie, body, null),
      403,
      "Invalid request origin.",
    );
    await rejected(
      await send("activity-email", "", body),
      401,
      "Sign in to continue.",
    );
  }
});

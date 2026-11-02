import { test, afterEach, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import { format, stripVTControlCharacters } from "node:util";
import {
  useDatabase,
  db,
  setup,
  cookieFor,
  captureFailures,
  person,
  assertAuthError,
} from "./social-fixture";
import { fakeGoogle, serve } from "./identity-providers";
import { error as logNextError } from "next/dist/build/output/log";

const { GET, POST } = await import("../../src/app/api/screenr/[action]/route");
const { initialScreen } = await import("../../src/server/screens");
const { runWorkerPass } = await import("../../src/server/email");
const { logFailure } = await import("../../src/server/log");
const { runWorkerLoop } = await import("../../src/server/worker-loop");
const { createAuth } = await import("../../src/server/auth");
const { createInvitation, invitationHash } =
  await import("../../src/server/invitations");
const { onRequestError, register } = await import("../../src/instrumentation");
useDatabase();
// Fake Sentry endpoints still open after a failed test.
const endpoints = new Set<Server>();
afterEach(() => {
  mock.restoreAll();
  delete process.env.SENTRY_DSN;
  for (const server of endpoints) {
    server.closeAllConnections();
    server.close();
  }
  endpoints.clear();
});

// Each failure prints one JSON line. Its stack holds only frames, so the
// remaining fields are compared exactly: nothing else may be logged.
function logged(printed: string[]) {
  assert.equal(printed.length, 1, printed.join("\n"));
  const { stack, ...fields } = JSON.parse(printed[0]);
  assert.ok(Array.isArray(stack) && stack.length > 0, printed[0]);
  for (const frame of stack) assert.match(frame, /^at /);
  return { fields, stack: stack as string[] };
}

// loadScreen rejects when its screen read fails while its unread count, a
// single query, may still run. Let it finish before the schema is restored or
// the next test resets tables, so their locks cannot deadlock.
async function settled() {
  while (db.idleCount < db.totalCount) await setTimeout(5);
}

function excludes(printed: string[], values: string[]) {
  for (const value of values)
    assert.ok(!printed.join("\n").includes(value), `Logged ${value}`);
}

async function until(condition: () => boolean) {
  for (let wait = 0; wait < 400 && !condition(); wait++) await setTimeout(5);
  assert.ok(condition(), "Timed out");
}

// Runs screenr-worker's email loop until its first pass fails and is logged.
async function failWorkerPass(printed: string[]) {
  const stop = new AbortController();
  const loop = runWorkerLoop(runWorkerPass, stop.signal);
  await until(() => printed.length > 0);
  stop.abort();
  await loop;
}

// Posts a comment that only a probe check constraint rejects, so the request
// fails unexpectedly. PostgreSQL's message names the constraint and its detail
// repeats the whole failing row. Returns the private values the request held.
async function postRejectedComment() {
  const { alice, conversation } = await setup();
  const cookie = await cookieFor(alice);
  const comment = "Private comment text 4815162342";
  await db.query(
    `ALTER TABLE comment ADD CONSTRAINT failure_log_probe CHECK (body <> '${comment}') NOT VALID`,
  );
  try {
    const response = await POST(
      new Request("http://localhost:3000/api/screenr/comment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify({ conversation, body: comment, spoiler: false }),
      }),
      { params: Promise.resolve({ action: "comment" }) },
    );
    const privateValues = [
      comment,
      alice,
      conversation,
      "alice@example.test",
      ...cookie.split("; ").map((pair) => pair.split("=")[1]),
      "violates",
      "Failing row",
    ];
    return { response, privateValues };
  } finally {
    await db.query("ALTER TABLE comment DROP CONSTRAINT failure_log_probe");
  }
}

type Report = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  reply: (status: number) => void;
};

// A loopback Sentry endpoint named by SENTRY_DSN. It holds each envelope's
// reply until the test sends it, so a caller that waited for Sentry would
// never finish.
async function fakeSentry() {
  const arrived: Report[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    arrived.push({
      path: request.url!,
      headers: request.headers,
      body,
      reply: (status) =>
        void response.writeHead(status, { Connection: "close" }).end(),
    });
  });
  endpoints.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.SENTRY_DSN = `http://public-key@127.0.0.1:${port}/42`;
  return {
    async next() {
      await until(() => arrived.length > 0);
      return arrived.shift()!;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// An envelope is a header line, then one item header and its event.
function envelope(body: string) {
  const lines = body.trimEnd().split("\n");
  assert.equal(lines.length, 3, body);
  const [header, item, event] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(item, { type: "event" });
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(header.event_id, event.event_id);
  return event;
}

// Replaces fetch with a Sentry endpoint that accepts every envelope, and
// returns a function that lists the events sent so far. A report calls fetch
// before logFailure returns, so the list is complete at once.
function acceptReports() {
  process.env.SENTRY_DSN = "https://public-key@sentry.example.test/42";
  const fetch = mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  return () =>
    fetch.mock.calls.map(({ arguments: [url, init] }) => {
      assert.equal(url, "https://sentry.example.test/api/42/envelope/");
      return envelope(String(init?.body));
    });
}

test("an unexpected database failure in a request logs its action, error class, code, constraint, and stack without request data", async () => {
  const printed = captureFailures();
  const { response, privateValues } = await postRejectedComment();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Something went wrong. Please try again.",
  });
  // The request sent no ID, so the line names the one the server generated
  // and returned.
  const requestId = response.headers.get("Screenr-Request-Id");
  assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);
  const { fields, stack } = logged(printed);
  assert.deepEqual(fields, {
    event: "request failed",
    requestId,
    action: "comment",
    method: "POST",
    status: 500,
    error: "DatabaseError",
    code: "23514",
    constraint: "failure_log_probe",
    table: "comment",
  });
  assert.ok(
    stack.some((frame) => frame.includes("src/server/comments.ts")),
    "The stack leads back to the failing query",
  );
  excludes(printed, privateValues);
});

test("an unexpected page failure logs its route kind, error class, code, and stack without the path", async () => {
  const { alice } = await setup();
  const query = "private search words";
  // The search screen reads saved services last, after its other queries.
  await db.query(
    "ALTER TABLE member_streaming_service RENAME TO member_streaming_service_hidden",
  );
  try {
    const printed = captureFailures();
    assert.deepEqual(
      await initialScreen(alice, `/search?q=${encodeURIComponent(query)}`),
      {
        data: null,
        error: "This page could not load. Please try again.",
        status: 500,
      },
    );
    const { fields, stack } = logged(printed);
    assert.deepEqual(fields, {
      event: "page failed",
      route: "search",
      error: "DatabaseError",
      code: "42P01",
    });
    assert.ok(
      stack.some((frame) => frame.includes("src/server/streaming-services.ts")),
    );
    excludes(printed, [query, encodeURIComponent(query), alice, "exist"]);
  } finally {
    await settled();
    await db.query(
      "ALTER TABLE member_streaming_service_hidden RENAME TO member_streaming_service",
    );
  }
});

test("expected page errors show their message and log nothing", async () => {
  const { alice } = await setup();
  const printed = captureFailures();
  assert.deepEqual(await initialScreen(alice, "/watch-together"), {
    data: null,
    error: "Choose one friend from their profile.",
    status: 400,
  });
  await settled();
  assert.deepEqual(printed, []);
});

test("an unparseable screen path is not found and logs nothing", async () => {
  const { alice } = await setup();
  const cookie = await cookieFor(alice);
  const printed = captureFailures();
  const response = await GET(
    new Request(
      `http://localhost:3000/api/screenr/screen?${new URLSearchParams({ path: "//[" })}`,
      { headers: { Cookie: cookie } },
    ),
    { params: Promise.resolve({ action: "screen" }) },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Page not found." });
  assert.deepEqual(printed, []);
});

// Better Auth prints its own unstructured lines beside a failure; only JSON
// lines are failure logs.
const structured = (printed: string[]) =>
  printed.filter((line) => line.startsWith("{"));

// Everything printed through the console, not only failure logs.
function captureOutput() {
  const printed: string[] = [];
  for (const method of ["debug", "info", "log", "warn", "error"] as const)
    mock.method(console, method, (...args: unknown[]) => {
      printed.push(format(...args));
    });
  return printed;
}

test("a sign-in code request whose email cannot be queued logs the callback and error, prints neither the message nor the address, and still answers success", async () => {
  await person("member");
  const message = "Private detail 662607";
  const auth = createAuth({
    rateLimit: false,
    sendCode: async () => {
      throw new TypeError(message);
    },
  });
  const printed = captureOutput();
  const response = await auth.handler(
    new Request(
      "http://localhost:3000/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ email: "member@example.test", type: "sign-in" }),
      },
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  const { fields, stack } = logged(structured(printed));
  assert.deepEqual(fields, {
    event: "auth callback failed",
    callback: "sendVerificationOTP",
    error: "TypeError",
  });
  assert.ok(stack.some((frame) => frame.includes("failure-logs.test.ts")));
  excludes(printed, [message, "member@example.test"]);
});

// Requests a sign-in code for an address, as the web does, and returns the
// code with a sign-in that posts it. A cookie names a new address's
// invitation.
async function emailSignIn(email: string, cookie?: string) {
  let code = "";
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ otp }) => {
      code = otp;
    },
  });
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          ...(cookie && { Cookie: cookie }),
        },
        body: JSON.stringify(body),
      }),
    );
  const request = await post("email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  assert.equal(request.status, 200);
  assert.match(code, /^[0-9]{6}$/);
  return {
    code,
    signIn: () => post("sign-in/email-otp", { email, otp: code }),
  };
}

test("a database failure inside Better Auth during an email code sign-in logs its endpoint pattern, error class, code, and stack without the address or code", async () => {
  await person("member");
  const { code, signIn } = await emailSignIn("member@example.test");
  // Better Auth checks the code against its verification table first.
  await db.query("ALTER TABLE verification RENAME TO verification_hidden");
  try {
    const printed = captureOutput();
    const response = await signIn();
    assert.equal(response.status, 500);
    const { fields, stack } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth endpoint failed",
      endpoint: "/sign-in/email-otp",
      error: "DatabaseError",
      code: "42P01",
    });
    assert.ok(stack.some((frame) => frame.includes("/better-auth/")));
    excludes(printed, [code, "member@example.test", "exist"]);
  } finally {
    await db.query("ALTER TABLE verification_hidden RENAME TO verification");
  }
});

test("a Screenr callback failure that fails a sign-in logs only the callback, not the endpoint as well", async () => {
  const { token } = await createInvitation(null);
  const { signIn } = await emailSignIn(
    "new@example.test",
    `screenr-invite=${token}`,
  );
  // Creating an account for a new address checks its invitation.
  await db.query("ALTER TABLE invitation RENAME TO invitation_hidden");
  try {
    const printed = captureOutput();
    const response = await signIn();
    assert.equal(response.status, 500);
    const { fields } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth callback failed",
      callback: "user.create.before",
      error: "DatabaseError",
      code: "42P01",
    });
    excludes(printed, [token, "new@example.test", "exist"]);
  } finally {
    await db.query("ALTER TABLE invitation_hidden RENAME TO invitation");
  }
});

test("a constraint that fails an invited email code signup logs the endpoint, constraint, and table, and nothing printed quotes the failing row", async () => {
  const email = "probe.person@example.test";
  const { token } = await createInvitation(null);
  const { code, signIn } = await emailSignIn(email, `screenr-invite=${token}`);
  // A probe check constraint rejects the new user row. PostgreSQL's detail
  // repeats the whole row, with the address and the invitation hash.
  await db.query(
    `ALTER TABLE "user" ADD CONSTRAINT failure_log_probe CHECK (email <> '${email}') NOT VALID`,
  );
  try {
    const printed = captureOutput();
    const response = await signIn();
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
    const { fields } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth endpoint failed",
      endpoint: "/sign-in/email-otp",
      error: "DatabaseError",
      code: "23514",
      constraint: "failure_log_probe",
      table: "user",
    });
    excludes(printed, [
      email,
      invitationHash(token),
      token,
      code,
      "violates",
      "Failing row",
    ]);
  } finally {
    await db.query('ALTER TABLE "user" DROP CONSTRAINT failure_log_probe');
  }
});

test("a database failure in Better Auth's rate limit answers a bare 500 and logs the error instead of throwing it to Next", async () => {
  const auth = createAuth();
  const ok = () =>
    auth.handler(new Request("http://localhost:3000/api/auth/ok"));
  // The first request also settles Better Auth's schema check.
  assert.equal((await ok()).status, 200);
  await db.query('ALTER TABLE "rateLimit" RENAME TO rate_limit_hidden');
  try {
    const printed = captureOutput();
    const response = await ok();
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
    const { fields } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth endpoint failed",
      error: "DatabaseError",
      code: "42P01",
    });
    excludes(printed, ["exist"]);
  } finally {
    await db.query('ALTER TABLE rate_limit_hidden RENAME TO "rateLimit"');
  }
});

// The iPhone app's Google sign-in with an ID token from a fake Google, which
// Better Auth verifies for real. The app sends no Origin and names a new
// member's invitation in a header.
function googleIdTokenSignIn(t: TestContext, email: string) {
  const google = fakeGoogle();
  process.env.GOOGLE_IOS_CLIENT_ID = "ios-client.apps.googleusercontent.com";
  t.after(() => delete process.env.GOOGLE_IOS_CLIENT_ID);
  serve(google);
  const auth = createAuth({ rateLimit: false });
  const token = google.idToken({
    sub: "google-probe",
    email,
    aud: process.env.GOOGLE_IOS_CLIENT_ID,
  });
  return {
    token,
    signIn: (invitation: string) =>
      auth.handler(
        new Request("http://localhost:3000/api/auth/sign-in/social", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Screenr-Invitation": invitation,
          },
          body: JSON.stringify({ provider: "google", idToken: { token } }),
        }),
      ),
  };
}

const userCount = async () =>
  (await db.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n;

test("a database failure while a Google ID token signup creates the account logs it once with the endpoint, and Better Auth still answers its own error", async (t) => {
  const email = "probe.person@example.test";
  const { token: invitation } = await createInvitation(null);
  const { token, signIn } = googleIdTokenSignIn(t, email);
  // A probe check constraint rejects the new account row, as a column Better
  // Auth doesn't expect would (issue #181). PostgreSQL's detail repeats the
  // whole row, with the ID token.
  await db.query(
    `ALTER TABLE account ADD CONSTRAINT failure_log_probe CHECK ("accountId" <> 'google-probe') NOT VALID`,
  );
  try {
    const printed = captureOutput();
    const response = await signIn(invitation);
    await assertAuthError(response, 401, { code: "OAUTH_LINK_ERROR" });
    const { fields, stack } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth failure caught",
      endpoint: "/sign-in/social",
      error: "DatabaseError",
      code: "23514",
      constraint: "failure_log_probe",
      table: "account",
    });
    assert.ok(
      stack.some((frame) => frame.includes("/@better-auth/kysely-adapter/")),
    );
    excludes(printed, [
      email,
      token,
      invitation,
      invitationHash(invitation),
      "violates",
      "Failing row",
    ]);
    // Better Auth rolls back the new user with the account.
    assert.equal(await userCount(), 0);
  } finally {
    await db.query("ALTER TABLE account DROP CONSTRAINT failure_log_probe");
  }
});

test("a Screenr callback failure in a Google ID token signup logs only the callback, not Better Auth's caught error as well", async (t) => {
  const { token: invitation } = await createInvitation(null);
  const { signIn } = googleIdTokenSignIn(t, "new@example.test");
  // Creating the user checks its invitation.
  await db.query("ALTER TABLE invitation RENAME TO invitation_hidden");
  try {
    const printed = captureOutput();
    const response = await signIn(invitation);
    await assertAuthError(response, 401, { code: "OAUTH_LINK_ERROR" });
    const { fields } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth callback failed",
      callback: "user.create.before",
      error: "DatabaseError",
      code: "42P01",
    });
    excludes(printed, [invitation, "new@example.test", "exist"]);
  } finally {
    await db.query("ALTER TABLE invitation_hidden RENAME TO invitation");
  }
});

test("a database failure while Better Auth reads a session logs it once with the endpoint, and Better Auth still answers 500", async () => {
  const cookie = await cookieFor(await person("member"));
  const auth = createAuth({ rateLimit: false });
  const session = () =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { Cookie: cookie },
      }),
    );
  // The first request also settles Better Auth's schema check.
  assert.equal((await session()).status, 200);
  await db.query("ALTER TABLE session RENAME TO session_hidden");
  try {
    const printed = captureOutput();
    const response = await session();
    await assertAuthError(response, 500, { code: "FAILED_TO_GET_SESSION" });
    const { fields } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth failure caught",
      endpoint: "/get-session",
      error: "DatabaseError",
      code: "42P01",
    });
    excludes(printed, [
      ...cookie.split("; ").map((pair) => pair.split("=")[1]),
      "member@example.test",
      "exist",
    ]);
  } finally {
    await db.query("ALTER TABLE session_hidden RENAME TO session");
  }
});

test("a session read that fails in an API request logs Better Auth's caught error beside the request's failure, under the same request ID", async () => {
  const cookie = await cookieFor(await person("member"));
  const request = () =>
    GET(
      new Request("http://localhost:3000/api/screenr/screen?path=/", {
        headers: { Cookie: cookie, "Screenr-Request-Id": "session-probe" },
      }),
      { params: Promise.resolve({ action: "screen" }) },
    );
  assert.equal((await request()).status, 200);
  await db.query("ALTER TABLE session RENAME TO session_hidden");
  try {
    const printed = captureOutput();
    assert.equal((await request()).status, 500);
    const lines = structured(printed).map((line) => {
      const { stack: _stack, ...fields } = JSON.parse(line);
      return fields;
    });
    assert.deepEqual(lines, [
      {
        event: "auth failure caught",
        requestId: "session-probe",
        error: "DatabaseError",
        code: "42P01",
      },
      {
        event: "request failed",
        requestId: "session-probe",
        action: "screen",
        method: "GET",
        status: 500,
        error: "APIError",
      },
    ]);
    excludes(printed, [
      ...cookie.split("; ").map((pair) => pair.split("=")[1]),
      "member@example.test",
      "exist",
    ]);
  } finally {
    await db.query("ALTER TABLE session_hidden RENAME TO session");
  }
});

test("an OAuth callback with an unknown or used state logs no failure, while a database failure reading the state does", async (t) => {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "web-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "web-secret",
  });
  t.after(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  const auth = createAuth({ rateLimit: false });
  const state = "unknown-state-6626070";
  const callback = () =>
    auth.handler(
      new Request(
        `http://localhost:3000/api/auth/callback/google?state=${state}&code=private-code`,
      ),
    );
  // A client causes this one: the state is unknown, as a forged or already
  // used state is. Better Auth prints its line and redirects with ?error=.
  let printed = captureOutput();
  let response = await callback();
  assert.equal(response.status, 302);
  assert.equal(
    new URL(response.headers.get("location")!).searchParams.get("error"),
    "state_mismatch",
  );
  assert.deepEqual(structured(printed), []);
  assert.deepEqual(printed, ["ERROR [Better Auth]: Failed to parse state"]);

  mock.restoreAll();
  await db.query("ALTER TABLE verification RENAME TO verification_hidden");
  try {
    printed = captureOutput();
    response = await callback();
    assert.equal(response.status, 302);
    assert.equal(
      new URL(response.headers.get("location")!).searchParams.get("error"),
      "internal_server_error",
    );
    const { fields } = logged(structured(printed));
    assert.deepEqual(fields, {
      event: "auth failure caught",
      endpoint: "/callback/:id",
      error: "DatabaseError",
      code: "42P01",
    });
    excludes(printed, [state, "private-code", "exist"]);
  } finally {
    await db.query("ALTER TABLE verification_hidden RENAME TO verification");
  }
});

test("a Google code exchange that Google rejects for Screenr's web client logs Google's error code and status, while one rejected for the code logs nothing", async (t) => {
  const google = fakeGoogle();
  process.env.GOOGLE_CLIENT_ID = google.webClient.id;
  t.after(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  const origin = "http://localhost:3000";
  // Starts a web Google sign-in with Screenr's secret, then returns to
  // Google's callback with a code, as the browser does. Better Auth keeps the
  // state and exchanges the code at the fake token endpoint for real.
  async function returnWithCode(secret: string) {
    mock.restoreAll();
    serve(google);
    process.env.GOOGLE_CLIENT_SECRET = secret;
    const auth = createAuth({ rateLimit: false });
    const started = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      }),
    );
    assert.equal(started.status, 200, await started.clone().text());
    const state = new URL((await started.json()).url).searchParams.get(
      "state",
    )!;
    const cookie = started.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const printed = captureOutput();
    const response = await auth.handler(
      new Request(
        `${origin}/api/auth/callback/google?state=${state}&code=private-code`,
        { headers: { Cookie: cookie } },
      ),
    );
    assert.equal(response.status, 302);
    assert.equal(
      new URL(response.headers.get("location")!).searchParams.get("error"),
      "invalid_code",
    );
    excludes(printed, [
      state,
      "private-code",
      secret,
      google.webClient.secret,
      "Unauthorized",
      "Bad Request",
    ]);
    return printed;
  }

  // An expired or already used code: a client causes it, so Better Auth
  // prints only its own empty line.
  let printed = await returnWithCode(google.webClient.secret);
  assert.deepEqual(printed, ["ERROR [Better Auth]: "]);

  // A rotated or deleted secret: every web Google sign-in fails until
  // GOOGLE_CLIENT_SECRET is replaced.
  printed = await returnWithCode("rotated-secret");
  assert.deepEqual(
    structured(printed).map((line) => JSON.parse(line)),
    [
      {
        event: "google client rejected",
        status: 401,
        reason: "invalid_client",
      },
    ],
  );
});

test("a request error that reaches Next logs the route pattern, its type, and the method without the path or headers", async () => {
  const printed = captureFailures();
  const message = "Private detail 602214";
  await onRequestError(
    new TypeError(message),
    {
      path: "/people/alice?q=private",
      method: "GET",
      headers: { cookie: "session=private-cookie" },
    },
    {
      routerKind: "App Router",
      routePath: "/[[...path]]",
      routeType: "render",
      renderSource: "server-rendering",
      revalidateReason: undefined,
    },
  );
  const { fields } = logged(printed);
  assert.deepEqual(fields, {
    event: "route failed",
    route: "/[[...path]]",
    type: "render",
    method: "GET",
    error: "TypeError",
  });
  excludes(printed, [message, "alice", "private"]);
});

test("in production, the line Next prints for an error before onRequestError shows only its class, code, and stack, without the message or PostgreSQL detail", async () => {
  const printed = captureFailures();
  const value = "Private value 271828";
  const error = await db
    .query(
      `DO $$ BEGIN RAISE EXCEPTION 'Probe rejected %', '${value}'
        USING DETAIL = 'Failing row contains (${value}).', ERRCODE = '23514';
      END $$`,
    )
    .catch((error: unknown) => error);
  assert.ok(error instanceof Error && error.message.includes(value));
  // Next calls register once at startup. Outside production, whole errors
  // still print, for debugging.
  const unchanged = console.error;
  register();
  assert.equal(console.error, unchanged);
  const env = process.env as Record<string, string | undefined>;
  const mode = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    register();
  } finally {
    if (mode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = mode;
  }
  // What Next's production server does with an error that escapes a route
  // handler or a page render: print it with its own logger, as `⨯` and the
  // error, then call the hook.
  logNextError(error);
  await onRequestError(
    error,
    { path: "/api/photos/alice/0123456789abcdef", method: "GET", headers: {} },
    {
      routerKind: "App Router",
      routePath: "/api/photos/[user]/[version]",
      routeType: "route",
      revalidateReason: undefined,
    },
  );
  assert.equal(printed.length, 2, printed.join("\n"));
  const next = stripVTControlCharacters(printed[0]);
  assert.ok(next.startsWith("⨯ {"), next);
  const { fields, stack } = logged(printed.slice(1));
  assert.deepEqual(fields, {
    event: "route failed",
    route: "/api/photos/[user]/[version]",
    type: "route",
    method: "GET",
    error: "DatabaseError",
    code: "23514",
  });
  assert.deepEqual(JSON.parse(next.slice(2)), {
    error: "DatabaseError",
    code: "23514",
    stack,
  });
  excludes(printed, [value, "Probe rejected", "Failing row"]);
});

test("a failed email worker pass logs its error class, code, and stack", async () => {
  await db.query("ALTER TABLE email_job RENAME TO email_job_hidden");
  try {
    const printed = captureFailures();
    await failWorkerPass(printed);
    const { fields, stack } = logged(printed);
    assert.deepEqual(fields, {
      event: "worker failed",
      failures: 1,
      error: "DatabaseError",
      code: "42P01",
    });
    assert.ok(stack.some((frame) => frame.includes("src/server/email.ts")));
    excludes(printed, ["exist"]);
  } finally {
    await db.query("ALTER TABLE email_job_hidden RENAME TO email_job");
  }
});

test("with a Sentry DSN, a request failure is also sent as an envelope with the logged fields and frames but no message, and the response does not wait for it", async () => {
  const sentry = await fakeSentry();
  const printed = captureFailures();
  const { response, privateValues } = await postRejectedComment();
  // The endpoint has not replied yet.
  assert.equal(response.status, 500);
  const report = await sentry.next();
  report.reply(200);
  await sentry.close();
  assert.equal(report.path, "/api/42/envelope/");
  assert.equal(report.headers["content-type"], "application/x-sentry-envelope");
  assert.match(
    String(report.headers["x-sentry-auth"]),
    /^Sentry sentry_version=7, sentry_key=public-key, sentry_client=screenr\/\S+$/,
  );
  const { fields, stack } = logged(printed);
  const { event_id, timestamp, environment, exception, ...event } = envelope(
    report.body,
  );
  assert.ok(Math.abs(timestamp - Date.now() / 1000) < 60);
  assert.equal(typeof environment, "string");
  // Nothing else is sent: the logged fields, apart from the stack, are the
  // failure context, and no message or log entry is present.
  assert.deepEqual(event, {
    platform: "node",
    level: "error",
    tags: {
      event: "request failed",
      request_id: response.headers.get("Screenr-Request-Id"),
    },
    contexts: { failure: fields },
  });
  assert.equal(exception.values.length, 1);
  const [{ stacktrace, ...thrown }] = exception.values;
  // The log event stands in for the error message.
  assert.deepEqual(thrown, {
    type: "DatabaseError",
    value: "request failed",
    mechanism: { type: "generic", handled: true },
  });
  // Sentry lists frames from the outermost call to the failing one.
  const frames = stacktrace.frames.toReversed();
  assert.equal(frames.length, stack.length);
  frames.forEach((frame: Record<string, unknown>, index: number) =>
    assert.ok(
      stack[index].includes(`:${frame.lineno}:${frame.colno}`),
      stack[index],
    ),
  );
  const query = frames.find(
    (frame: Record<string, unknown>) =>
      frame.filename === "src/server/comments.ts",
  );
  assert.ok(query?.in_app, "The frames lead back to the failing query");
  assert.match(query.abs_path, /^\/.+\/src\/server\/comments\.ts$/);
  excludes([report.body], [...privateValues, "Private comment"]);
});

test("a Sentry report tags the failure's request ID, and a rejected report prints its status without reaching the caller", async () => {
  const sentry = await fakeSentry();
  const printed = captureFailures();
  const message = "Private detail 271828";
  assert.equal(
    logFailure(
      "request failed",
      { action: "comment", requestId: "3f2a9c" },
      new TypeError(message),
    ),
    undefined,
  );
  const report = await sentry.next();
  const event = envelope(report.body);
  assert.deepEqual(event.tags, {
    event: "request failed",
    request_id: "3f2a9c",
  });
  assert.equal(event.contexts.failure.requestId, "3f2a9c");
  report.reply(429);
  await until(() => printed.length === 2);
  await sentry.close();
  assert.deepEqual(JSON.parse(printed[1]), {
    event: "sentry report failed",
    status: 429,
  });
  excludes([report.body, ...printed], [message]);
});

test("an unreachable Sentry endpoint prints the network error without reaching the caller", async () => {
  const sentry = await fakeSentry();
  await sentry.close();
  const printed = captureFailures();
  logFailure("worker failed", {}, new Error("Private detail 314159"));
  await until(() => printed.length === 2);
  assert.deepEqual(JSON.parse(printed[1]), {
    event: "sentry report failed",
    error: "TypeError",
    cause: { error: "Error", code: "ECONNREFUSED" },
  });
});

test("a Sentry DSN without a key and project ID prints that it is invalid and sends nothing", () => {
  process.env.SENTRY_DSN = "https://sentry.example.test/";
  const fetch = mock.method(globalThis, "fetch");
  const printed = captureFailures();
  logFailure("worker failed", {}, new Error("Private detail 141421"));
  assert.equal(printed.length, 2);
  assert.deepEqual(JSON.parse(printed[1]), {
    event: "sentry report failed",
    reason: "invalid DSN",
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("without a Sentry DSN, a failure is only logged", () => {
  const fetch = mock.method(globalThis, "fetch");
  const printed = captureFailures();
  logFailure("worker failed", {}, new Error("Private detail 161803"));
  assert.equal(printed.length, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test("a failed email worker pass is also reported to Sentry", async () => {
  const sentry = await fakeSentry();
  const printed = captureFailures();
  await db.query("ALTER TABLE email_job RENAME TO email_job_hidden");
  try {
    await failWorkerPass(printed);
  } finally {
    await db.query("ALTER TABLE email_job_hidden RENAME TO email_job");
  }
  const report = await sentry.next();
  report.reply(200);
  await sentry.close();
  const event = envelope(report.body);
  assert.deepEqual(event.contexts.failure, {
    event: "worker failed",
    failures: 1,
    error: "DatabaseError",
    code: "42P01",
  });
  assert.equal(event.exception.values[0].value, "worker failed");
  assert.ok(
    event.exception.values[0].stacktrace.frames.some(
      (frame: Record<string, unknown>) =>
        frame.filename === "src/server/email.ts",
    ),
  );
});

test("polls that fail the same way, as in a database outage, each log a line with their request ID, but only the first goes to Sentry, while another action's failure goes at once", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  const sent = acceptReports();
  const printed = captureFailures();
  async function poll(action: string) {
    const response = await GET(
      new Request(`http://localhost:3000/api/screenr/${action}`, {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ action }) },
    );
    assert.equal(response.status, 500);
    return response.headers.get("Screenr-Request-Id");
  }
  // The notification sheet's poll and the screen's poll both read it.
  await db.query(
    "ALTER VIEW visible_notification RENAME TO visible_notification_hidden",
  );
  try {
    const polls = [];
    for (let count = 0; count < 20; count++)
      polls.push(await poll("notifications"));
    const screen = await poll("screen");
    polls.push(await poll("notifications"));
    const lines = printed.map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map(({ action, requestId, error, code }) => ({
        action,
        requestId,
        error,
        code,
      })),
      [...polls.slice(0, 20), screen, polls[20]].map((requestId, index) => ({
        action: index === 20 ? "screen" : "notifications",
        requestId,
        error: "DatabaseError",
        code: "42P01",
      })),
    );
    assert.equal(new Set(lines.map(({ requestId }) => requestId)).size, 22);
    assert.deepEqual(
      sent().map(({ tags, contexts }) => ({
        action: contexts.failure.action,
        request_id: tags.request_id,
        folded: contexts.failure.folded,
      })),
      [
        { action: "notifications", request_id: polls[0], folded: undefined },
        { action: "screen", request_id: screen, folded: undefined },
      ],
    );
  } finally {
    await settled();
    await db.query(
      "ALTER VIEW visible_notification_hidden RENAME TO visible_notification",
    );
  }
});

test("after a kind's first report, Sentry gets the failures folded in the next hour as one report with their number and the latest request ID, hourly while they continue, until an hour passes without one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hour = 60 * 60 * 1000;
  const sent = acceptReports();
  const printed = captureFailures();
  const fail = (requestId: string, code: string) =>
    logFailure(
      "request failed",
      { action: "notifications", method: "GET", status: 500, requestId },
      Object.assign(new Error("Private detail 299792"), { code }),
    );
  const reports = () =>
    sent().map(({ tags, contexts }) => {
      assert.equal(contexts.failure.requestId, tags.request_id);
      const { requestId, folded, code } = contexts.failure;
      return folded === undefined
        ? { requestId, code }
        : { requestId, code, folded };
    });
  fail("a1", "ECONNREFUSED");
  fail("a2", "ECONNREFUSED");
  fail("a3", "ECONNREFUSED");
  // Another code is another kind.
  fail("b1", "57P03");
  assert.deepEqual(reports(), [
    { requestId: "a1", code: "ECONNREFUSED" },
    { requestId: "b1", code: "57P03" },
  ]);
  t.mock.timers.tick(hour - 1);
  assert.equal(reports().length, 2);
  t.mock.timers.tick(1);
  // The second kind folded nothing, so its next failure reports at once.
  fail("b2", "57P03");
  fail("a4", "ECONNREFUSED");
  assert.deepEqual(reports().slice(2), [
    { requestId: "a3", code: "ECONNREFUSED", folded: 2 },
    { requestId: "b2", code: "57P03" },
  ]);
  t.mock.timers.tick(hour);
  assert.deepEqual(reports().slice(4), [
    { requestId: "a4", code: "ECONNREFUSED", folded: 1 },
  ]);
  // An hour without a failure of the kind ends its fold.
  t.mock.timers.tick(hour);
  assert.equal(reports().length, 5);
  fail("a5", "ECONNREFUSED");
  assert.deepEqual(reports().slice(5), [
    { requestId: "a5", code: "ECONNREFUSED" },
  ]);
  // The journal keeps a line for every failure.
  assert.deepEqual(
    printed.map((line) => JSON.parse(line).requestId),
    ["a1", "a2", "a3", "b1", "b2", "a4", "a5"],
  );
  excludes(
    [...printed, ...sent().map((event) => JSON.stringify(event))],
    ["Private detail"],
  );
});

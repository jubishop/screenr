import { test, afterEach, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { format, stripVTControlCharacters } from "node:util";
import {
  useDatabase,
  db,
  setup,
  cookieFor,
  captureFailures,
  assertNotLogged,
  clientAddress,
  person,
  assertAuthError,
} from "./social-fixture";
import {
  logged,
  failWorkerPass,
  postRejectedComment,
  acceptReports,
} from "./failure-fixture";
import { fakeGoogle, serve } from "./identity-providers";
import { error as logNextError } from "next/dist/build/output/log";
import { createReactServerErrorHandler } from "next/dist/server/app-render/create-error-handler";

// What each failure prints, for request, page, Better Auth, Next
// onRequestError, and worker failures (docs/deployment.md#failure-logs).
// sentry-reports.test.ts covers how failures reach Sentry.

const { GET } = await import("../../src/app/api/screenr/[action]/route");
const { initialScreen } = await import("../../src/server/screens");
const { createAuth } = await import("../../src/server/auth");
const { createInvitation, invitationHash } =
  await import("../../src/server/invitations");
const { onRequestError, register } = await import("../../src/instrumentation");
useDatabase();
afterEach(() => {
  mock.restoreAll();
  delete process.env.SENTRY_DSN;
});

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
  assertNotLogged(printed, privateValues);
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
    assertNotLogged(printed, [
      query,
      encodeURIComponent(query),
      alice,
      "exist",
    ]);
  } finally {
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
  assertNotLogged(printed, [message, "member@example.test"]);
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
    assertNotLogged(printed, [code, "member@example.test", "exist"]);
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
    assertNotLogged(printed, [token, "new@example.test", "exist"]);
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
    assertNotLogged(printed, [
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
    auth.handler(
      new Request("http://localhost:3000/api/auth/ok", {
        headers: clientAddress,
      }),
    );
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
    assertNotLogged(printed, ["exist"]);
  } finally {
    await db.query('ALTER TABLE rate_limit_hidden RENAME TO "rateLimit"');
  }
});

// The iPhone app's Google sign-in with an ID token from a fake Google, which
// Better Auth verifies for real. The app sends no Origin and names a new
// member's invitation in a header.
async function googleIdTokenSignIn(t: TestContext, email: string) {
  const google = fakeGoogle();
  process.env.GOOGLE_IOS_CLIENT_ID = "ios-client.apps.googleusercontent.com";
  t.after(() => delete process.env.GOOGLE_IOS_CLIENT_ID);
  serve(google);
  const auth = createAuth({ rateLimit: false });
  // Better Auth reads every table's schema as soon as an instance is created,
  // and renaming any table during that read fails the check, so requests
  // answer 500. A first request waits for the check before a test renames.
  assert.equal(
    (await auth.handler(new Request("http://localhost:3000/api/auth/ok")))
      .status,
    200,
  );
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
  const { token, signIn } = await googleIdTokenSignIn(t, email);
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
    assertNotLogged(printed, [
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
  const { signIn } = await googleIdTokenSignIn(t, "new@example.test");
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
    assertNotLogged(printed, [invitation, "new@example.test", "exist"]);
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
    assertNotLogged(printed, [
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
        cause: { error: "DatabaseError", code: "42P01" },
      },
    ]);
    assertNotLogged(printed, [
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
    assertNotLogged(printed, [state, "private-code", "exist"]);
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
    assertNotLogged(printed, [
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
  // prints only its own line.
  let printed = await returnWithCode(google.webClient.secret);
  assert.deepEqual(printed, [
    "ERROR [Better Auth]: Failed to validate authorization code",
  ]);

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
  assertNotLogged(printed, [message, "alice", "private"]);
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
  inProduction(register);
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
  assertNotLogged(printed, [value, "Probe rejected", "Failing row"]);
});

// Runs code as Next's production server does, with NODE_ENV production.
function inProduction(run: () => void) {
  const env = process.env as Record<string, string | undefined>;
  const mode = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    run();
  } finally {
    if (mode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = mode;
  }
}

// What Next's production server does with an error that escapes a member page
// render: its React server error handler records the error under a digest and
// hands it to the hook. When the error crosses a React server boundary
// carrying that digest, the handler finds the recorded error and hands it to
// the hook again. Each request renders with its own handler.
function failMemberPage(error: Error) {
  const handle = createReactServerErrorHandler(false, false, new Map(), (err) =>
    onRequestError(
      err,
      { path: "/", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/[[...path]]",
        routeType: "render",
        renderSource: "react-server-components",
        revalidateReason: undefined,
      },
    ),
  );
  inProduction(() => {
    const digest = handle(error);
    handle(Object.assign(new Error(error.message), { digest }));
  });
}

test("a member page render failure that Next hands to the hook twice logs one line and one Sentry report, while a separate failure with the same fields logs its own", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hour = 60 * 60 * 1000;
  const sent = acceptReports();
  const printed = captureFailures(t);
  // Made at the same place, so the two failures log identical lines.
  const [first, second] = Array.from({ length: 2 }, () =>
    Object.assign(new Error("Private detail 662607"), { code: "57014" }),
  );
  failMemberPage(first);
  // A repeat of a kind within the hour would reach Sentry when the hour ends,
  // as a second report with `folded`.
  t.mock.timers.tick(hour);
  const { fields } = logged(printed);
  assert.deepEqual(fields, {
    event: "route failed",
    route: "/[[...path]]",
    type: "render",
    method: "GET",
    error: "Error",
    code: "57014",
  });
  assert.equal(sent().length, 1);
  failMemberPage(second);
  t.mock.timers.tick(hour);
  assert.equal(printed.length, 2, printed.join("\n"));
  assert.equal(printed[1], printed[0]);
  assert.deepEqual(
    sent().map(({ contexts }) => contexts.failure),
    [fields, fields],
  );
  assertNotLogged(
    [...printed, ...sent().map((event) => JSON.stringify(event))],
    ["Private detail"],
  );
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
    assertNotLogged(printed, ["exist"]);
  } finally {
    await db.query("ALTER TABLE email_job_hidden RENAME TO email_job");
  }
});

import { before, beforeEach, after, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { testDatabaseURL } from "../../scripts/checkout";
import { failureRecord } from "../../scripts/failure-lines";
import { hang } from "./process-waits";

// Every application suite that uses the test database or server modules
// imports this module first, so this setup runs before any server module loads.
export { testDatabaseURL };
if (!new URL(testDatabaseURL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");
process.env.DATABASE_URL = testDatabaseURL;
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// A developer shell may export real provider credentials. Clear them so no
// application test reaches TMDB, Resend, Google, Apple, or Sentry. Suites
// that exercise a provider set fake values and use a loopback server or a
// replaced fetch.
for (const name of [
  "TMDB_READ_TOKEN",
  "SCREENR_TEST_TMDB_URL",
  "SCREENR_TEST_PAGES_URL",
  "EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_IOS_CLIENT_ID",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APNS_KEY_ID",
  "APNS_PRIVATE_KEY",
  "SENTRY_DSN",
  "SCREENR_IPHONE_INSTALL_URL",
  "SCREENR_OWNER_EMAIL",
  "PUSHOVER_API_KEY",
  "PUSHOVER_USER_KEY",
])
  delete process.env[name];

export const { db } = await import("../../src/server/db");
const { createAuth } = await import("../../src/server/auth");
const { migrate } = await import("../../scripts/migrate");
const { createInvitation, invitationHash, completeSignup } =
  await import("../../src/server/invitations");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity } = await import("../../src/server/title-actions");

// Call once in each feature suite. Node runs test files in separate processes;
// npm test keeps those files serial because they reset the same test database.
// Never register hooks only as an import side effect.
export function useDatabase() {
  before(migrate);

  beforeEach(async () => {
    await idle();
    await db.query(
      'TRUNCATE "user", verification, title RESTART IDENTITY CASCADE',
    );
  });

  after(async () => {
    await db.end();
  });
}

// A test can end while a query it started still runs, as one that stops at a
// failed assertion can. A table reset beside that query could deadlock with
// its locks, so the reset first waits for the pool to go idle (#469). Load or
// a checkpoint can hold that query up for many seconds, so only a hang ends
// the wait.
async function idle() {
  const deadline = performance.now() + hang;
  while (db.idleCount < db.totalCount || db.waitingCount) {
    if (performance.now() > deadline)
      throw new Error("An earlier test's query never finished.");
    await setTimeout(5);
  }
}

// Replaces console.error and console.warn until mock.restoreAll(), or until
// the test ends when given its context, and returns what each call would have
// printed, in order, so tests can read failure logs and Better Auth's own
// lines. failure-guard.ts fails a test that prints either kind of line
// without capturing it.
export function captureFailures(t?: TestContext) {
  const printed: string[] = [];
  for (const method of ["error", "warn"] as const)
    (t?.mock ?? mock).method(console, method, (...args: unknown[]) => {
      printed.push(format(...args));
    });
  return printed;
}

// The events of the failure lines that captureFailures collected.
export function failureEvents(printed: string[]) {
  return printed.flatMap((line) => failureRecord(line)?.event ?? []);
}

// Replaces console.log as captureFailures replaces console.error and
// console.warn, and returns what each call would have printed, parsed when
// it is JSON. Each account deletion prints an "account deleted" record for
// the journal (src/server/account-deletion.ts), which failure-guard.ts
// doesn't flag, so a test that deletes an account captures and asserts it
// to keep npm test's output clean.
export function captureLog(t?: TestContext) {
  const printed: unknown[] = [];
  (t?.mock ?? mock).method(console, "log", (...args: unknown[]) => {
    const line = format(...args);
    try {
      printed.push(JSON.parse(line));
    } catch {
      printed.push(line);
    }
  });
  return printed;
}

// Stack frames, in failure lines and in Sentry reports, name each file in the
// checkout by a path or file URL that begins with the checkout's own path, as
// it is or escaped in JSON. That path can hold any word: every checkout under
// macOS's /private/tmp holds "private" (#487).
const checkoutURL = new URL("../..", import.meta.url).href.replace(/\/$/, "");
const checkoutPath = fileURLToPath(checkoutURL);
const checkoutForms = [
  checkoutURL,
  checkoutPath,
  JSON.stringify(checkoutPath).slice(1, -1),
];

// Asserts that no captured line or report holds any of the values, such as a
// request's path, a cookie, or an error's message. It reads them without the
// checkout's path, so only what was logged can match, wherever the checkout
// is.
export function assertNotLogged(printed: string[], values: string[]) {
  const text = checkoutForms.reduce(
    (rest, form) => rest.replaceAll(form, ""),
    printed.join("\n"),
  );
  for (const value of values)
    assert.ok(!text.includes(value), `Logged ${value}`);
}

// Runs `run` while deletes from `table` fail with a foreign key violation, as
// after a schema change that breaks a delete: every delete, or only those of
// the rows that `when` selects. Its message is a private detail that must
// never be logged.
export async function withFailingDeletes(
  table: string,
  when: string | undefined,
  run: () => Promise<void>,
) {
  await db.query(`CREATE FUNCTION fail_delete() RETURNS trigger
    LANGUAGE plpgsql AS $$BEGIN
      RAISE EXCEPTION 'Private detail 271828' USING ERRCODE='23503';
    END$$`);
  await db.query(
    `CREATE TRIGGER fail_delete BEFORE DELETE ON ${table}
    ${when ? `FOR EACH ROW WHEN (${when})` : ""} EXECUTE FUNCTION fail_delete()`,
  );
  try {
    await run();
  } finally {
    await db.query(`DROP TRIGGER fail_delete ON ${table}`);
    await db.query("DROP FUNCTION fail_delete()");
  }
}

// In production Caddy forwards each client's address in X-Forwarded-For, and
// Better Auth's rate limits key on it. Test requests to a rate-limited auth
// instance send this one; without an address Better Auth warns and counts
// them all in one shared bucket per path, as one address does.
export const clientAddress = { "X-Forwarded-For": "192.0.2.1" };

export async function pending(name: string, token: string, verified = true) {
  const id = randomBytes(24).toString("base64url");
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt","invitationHash")
    VALUES($1,$2,$3,$4,now(),now(),$5)`,
    [id, name, `${name}@example.test`, verified, invitationHash(token)],
  );
  return id;
}

export async function person(name: string) {
  const { token } = await createInvitation(null);
  const id = await pending(name, token);
  await completeSignup(id, name, name);
  return id;
}

// Signs in an existing verified user through email OTP for route tests. The
// web sends its Origin; the iPhone app sends none.
export async function signIn(userId: string, headers: Record<string, string>) {
  const { email } = (
    await db.query('SELECT email FROM "user" WHERE id=$1', [userId])
  ).rows[0];
  let code = "";
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ otp }) => {
      code = otp;
    },
  });
  const post = (path: string, data: unknown) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(data),
      }),
    );
  assert.equal(
    (await post("email-otp/send-verification-otp", { email, type: "sign-in" }))
      .status,
    200,
  );
  const response = await post("sign-in/email-otp", { email, otp: code });
  assert.equal(response.status, 200);
  return response;
}

export async function cookieFor(userId: string) {
  const response = await signIn(userId, { Origin: "http://localhost:3000" });
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

// The session token that sign-in returns in `set-auth-token`, which a native
// client keeps and sends as `Authorization: Bearer <token>`.
export async function bearerFor(userId: string) {
  const token = (await signIn(userId, {})).headers.get("set-auth-token");
  assert.ok(token, "Sign-in returns a set-auth-token header.");
  return token;
}

// The exact errors that denied access raises. Rejection tests match status and
// message, so a different failure, such as a SQL error or another resource's
// 404, cannot pass for the denial a test expects.
export const denied = {
  conversation: { status: 404, message: "Conversation not found." },
  replyTarget: { status: 404, message: "Reply target not found." },
  comment: { status: 404, message: "Comment not found." },
  person: { status: 404, message: "Person not found." },
  friendRequest: { status: 404, message: "Friend request not found." },
  pendingRequest: {
    status: 404,
    message: "This friend request is no longer pending.",
  },
  notification: {
    status: 404,
    message: "Notification is no longer available.",
  },
  watchTogether: { status: 404, message: "Watch together not found." },
  wantToWatch: { status: 404, message: "Want to watch not found." },
  invitation: { status: 404, message: "Invitation not found." },
  unavailableInvitation: {
    status: 403,
    message: "This invitation is no longer available. Ask for a new link.",
  },
  unverified: { status: 403, message: "Verify your email before joining." },
  incompleteProfile: { status: 403, message: "Complete your profile first." },
  origin: { status: 403, message: "Invalid request origin." },
  signedOut: { status: 401, message: "Sign in to continue." },
} as const;

// Better Auth rejections name their reason in the body: Screenr's own hooks
// by message, and Better Auth's checks by code.
export async function assertAuthError(
  response: Response,
  status: number,
  reason: { message: string } | { code: string },
) {
  assert.equal(response.status, status);
  const body = await response.json();
  for (const [key, value] of Object.entries(reason))
    assert.equal(body[key], value);
}
export const invitationRequired = {
  message: "A valid invitation is required to join Screenr.",
};

// Asserts the exact JSON error that an API route returns.
export async function assertRouteError(
  response: Response,
  expected: { status: number; message: string },
) {
  assert.equal(response.status, expected.status);
  assert.deepEqual(await response.json(), { error: expected.message });
}

export async function friend(a: string, b: string) {
  await changeRelationship(a, b, "request");
  await changeRelationship(b, a, "accept");
}

export async function setup() {
  const alice = await person("alice"),
    ben = await person("ben"),
    cam = await person("cam"),
    outsider = await person("outsider");
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Test Movie') ON CONFLICT DO NOTHING",
  );
  const conversation = await updateTitleActivity(
    alice,
    "movie:1",
    "recommended",
    true,
  );
  return { alice, ben, cam, outsider, conversation };
}

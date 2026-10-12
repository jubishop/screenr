import { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Every application suite that uses the test database or server modules
// imports this module first, so this setup runs before any server module loads.
export const testDatabaseURL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(testDatabaseURL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");
process.env.DATABASE_URL = testDatabaseURL;
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// A developer shell may export real provider credentials. Clear them so no
// application test reaches TMDB, Resend, or Google. Suites that exercise a
// provider set fake values and use a loopback server or a replaced fetch.
for (const name of [
  "TMDB_READ_TOKEN",
  "SCREENR_TEST_TMDB_URL",
  "EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
])
  delete process.env[name];

export const { db } = await import("../../src/server/db");
const { createAuth } = await import("../../src/server/auth");
const { migrate } = await import("../../scripts/migrate");
const { createInvitation, invitationHash, completeSignup } =
  await import("../../src/server/invitations");
const { changeRelationship, updateTitleActivity } =
  await import("../../src/server/social");

// Call once in each feature suite. Node runs test files in separate processes;
// npm test keeps those files serial because they reset the same test database.
// Never register hooks only as an import side effect.
export function useDatabase() {
  before(migrate);

  beforeEach(async () => {
    await db.query('TRUNCATE "user", verification RESTART IDENTITY CASCADE');
  });

  after(async () => {
    await db.end();
  });
}

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

// Signs in an existing verified user through email OTP for route tests.
export async function cookieFor(userId: string) {
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
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
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
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
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

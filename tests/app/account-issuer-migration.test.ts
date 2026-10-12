import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { useDatabase, db, person } from "./social-fixture";
const { createAuth } = await import("../../src/server/auth");
const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");

useDatabase();

const migration = "014-nullable-account-issuer.sql";

test("the account issuer migration relaxes only the Better Auth 1.7.2 column and keeps its index", async () => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA account_issuer_migration_test");
    await client.query("SET LOCAL search_path=account_issuer_migration_test");
    const sql = await readFile(`db/${migration}`, "utf8");
    // Databases first created by Better Auth 1.7.3 or later have no issuer.
    await client.query(
      'CREATE TABLE account (id text PRIMARY KEY, "accountId" text NOT NULL)',
    );
    await client.query(sql);
    await client.query(`DROP TABLE account;
      CREATE TABLE account (id text PRIMARY KEY, issuer text NOT NULL,
        "accountId" text NOT NULL, "providerId" text NOT NULL);
      CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON account (issuer, "accountId");
      INSERT INTO account VALUES ('old', 'https://accounts.google.com', 'sub-1', 'google')`);
    await client.query(sql);
    // Better Auth 1.7.3 and later insert accounts without an issuer.
    await client.query(`INSERT INTO account (id, "accountId", "providerId")
      VALUES ('new', 'sub-2', 'google'), ('other', 'sub-2', 'other')`);
    assert.deepEqual(
      (await client.query("SELECT id, issuer FROM account ORDER BY id")).rows,
      [
        { id: "new", issuer: null },
        { id: "old", issuer: "https://accounts.google.com" },
        { id: "other", issuer: null },
      ],
    );
    // Better Auth 1.7.2 still gets its unique account key after a rollback.
    await assert.rejects(
      client.query(
        "INSERT INTO account VALUES ('again', 'https://accounts.google.com', 'sub-1', 'google')",
      ),
      /account_issuer_accountId_uidx/,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("sign-in, sessions, and Google linking work after migrating a database created by Better Auth 1.7.2", async () => {
  // Recreate production's account schema from Better Auth 1.7.2 before this
  // migration ran. Better Auth 1.7.3 and later validate the schema on every
  // request and reject a required column they never write.
  await db.query(`ALTER TABLE account ADD COLUMN IF NOT EXISTS issuer text;
    ALTER TABLE account ALTER COLUMN issuer SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx"
      ON account (issuer, "accountId")`);
  // A Google account that Better Auth 1.7.2 wrote with its issuer.
  const existingId = await person("existing");
  await db.query(
    `INSERT INTO account (id, issuer, "accountId", "providerId", "userId",
      "createdAt", "updatedAt")
    VALUES ('existing', 'https://accounts.google.com', 'existing-google',
      'google', $1, now(), now())`,
    [existingId],
  );
  // Run the file directly. Removing its record would leave it out of order
  // once later migrations exist, and the migration command would refuse it.
  await db.query(await readFile(`db/${migration}`, "utf8"));
  assert.deepEqual(
    (
      await db.query(
        `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'account'
          AND column_name = 'issuer'`,
      )
    ).rows,
    [{ is_nullable: "YES" }],
  );

  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  const codes = new Map<string, string>();
  const auth = createAuth({
    rateLimit: false,
    sendCode: async ({ email, otp }) => {
      codes.set(email, otp);
    },
  });
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const provider = (await auth.$context).socialProviders[0];
  assert.ok(provider);
  // Replace only Google's external identity response, as in the
  // authentication suite. Better Auth's database writes remain real.
  let identity = { id: "existing-google", email: "existing@example.test" };
  provider.idToken = {
    verify: async (token) => token === "test-verified-token",
  };
  provider.getUserInfo = async () => ({
    user: { email: identity.email, name: "Google", emailVerified: true },
    data: { sub: identity.id },
  });
  async function request(path: string, body?: unknown, cookie = "") {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  }
  const social = {
    provider: "google",
    idToken: { token: "test-verified-token" },
  };
  const existingLogin = await request("sign-in/social", social);
  assert.equal((await existingLogin.json()).user.id, existingId);

  const { token } = await createInvitation(null, 2);
  const invite = `screenr-invite=${token}`;
  identity = { id: "google-signup", email: "google@example.test" };
  const googleSignup = await request("sign-in/social", social, invite);
  const googleId = (await googleSignup.json()).user.id;
  await completeSignup(googleId, "Google", "google");

  const email = "email@example.test";
  await request(
    "email-otp/send-verification-otp",
    { email, type: "sign-in" },
    invite,
  );
  const emailSignup = await request(
    "sign-in/email-otp",
    { email, otp: codes.get(email) },
    invite,
  );
  const emailId = (await emailSignup.json()).user.id;
  await completeSignup(emailId, "Email", "email");
  const session = emailSignup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

  // Better Auth 1.7.3 and later write this linked account without an issuer.
  identity = { id: "email-google", email };
  await request("link-social", social, session);
  const googleLogin = await request("sign-in/social", social);
  assert.equal((await googleLogin.json()).user.id, emailId);
  const current = await request("get-session", undefined, session);
  assert.equal((await current.json()).user.id, emailId);
  assert.deepEqual(
    (
      await db.query(
        `SELECT "userId", "accountId" FROM account
        WHERE "providerId" = 'google' ORDER BY "accountId"`,
      )
    ).rows,
    [
      { userId: emailId, accountId: "email-google" },
      { userId: existingId, accountId: "existing-google" },
      { userId: googleId, accountId: "google-signup" },
    ],
  );
});

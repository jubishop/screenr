import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { useDatabase, db, person } from "./social-fixture";
const { createAuth } = await import("../../src/server/auth");
const { createInvitation, completeSignup } =
  await import("../../src/server/invitations");

useDatabase();

// Migration 014 relaxed Better Auth 1.7.2's account.issuer column so 1.7.3
// and later could write accounts; 016 drops it and its index.
async function migrateIssuer(client: { query(sql: string): Promise<unknown> }) {
  for (const name of [
    "014-nullable-account-issuer.sql",
    "016-drop-account-issuer.sql",
  ])
    await client.query(await readFile(`db/${name}`, "utf8"));
}

test("the account issuer migrations drop Better Auth 1.7.2's index and column and leave fresh databases unchanged", async () => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA account_issuer_migration_test");
    await client.query("SET LOCAL search_path=account_issuer_migration_test");
    const shape = async () => ({
      columns: (
        await client.query(
          `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'account'
          ORDER BY ordinal_position`,
        )
      ).rows.map((row) => row.column_name),
      indexes: (
        await client.query(
          `SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'account'
          ORDER BY indexname`,
        )
      ).rows.map((row) => row.indexname),
    });
    const fresh = {
      columns: ["id", "accountId", "providerId"],
      indexes: ["account_pkey"],
    };
    // Databases first created by Better Auth 1.7.3 or later have no issuer.
    await client.query(`CREATE TABLE account (id text PRIMARY KEY,
      "accountId" text NOT NULL, "providerId" text NOT NULL)`);
    await migrateIssuer(client);
    assert.deepEqual(await shape(), fresh);

    await client.query(`DROP TABLE account;
      CREATE TABLE account (id text PRIMARY KEY, issuer text NOT NULL,
        "accountId" text NOT NULL, "providerId" text NOT NULL);
      CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON account (issuer, "accountId");
      INSERT INTO account VALUES ('old', 'https://accounts.google.com', 'sub-1', 'google')`);
    await migrateIssuer(client);
    assert.deepEqual(await shape(), fresh);
    assert.deepEqual((await client.query("SELECT * FROM account")).rows, [
      { id: "old", accountId: "sub-1", providerId: "google" },
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("sign-in, sessions, and Google linking work after migrating a database created by Better Auth 1.7.2", async () => {
  // Recreate production's account schema from Better Auth 1.7.2 before these
  // migrations ran. Better Auth 1.7.3 and later validate the schema on every
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
  // Run the files directly. Removing their records would leave them out of
  // order once later migrations exist, and the migration command would refuse
  // them.
  await migrateIssuer(db);
  assert.deepEqual(
    (
      await db.query(
        `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'account'
          AND column_name = 'issuer'
        UNION ALL SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'account_issuer_accountId_uidx'`,
      )
    ).rows,
    [],
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

  // Better Auth 1.7.3 and later link accounts by provider and account ID.
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

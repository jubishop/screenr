import { before, beforeEach, after } from "node:test";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";

if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");

process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";

process.env.BETTER_AUTH_URL = "http://localhost:3000";
export const { db } = await import("../../src/server/db");
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

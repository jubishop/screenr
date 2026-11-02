import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

// Every process in a checkout, including harness processes and Playwright
// workers, derives the same identity from the checkout's canonical path, even
// when the checkout is reached through a symlink. Concurrent checkouts on one
// machine therefore select separate ports and test databases.
export const checkoutRoot = realpathSync(process.cwd());
const identity = (root: string) =>
  createHash("sha256").update(root).digest("hex");
export const checkoutIdentity = identity(checkoutRoot);

export function checkoutDatabase(kind: "app" | "browser", root = checkoutRoot) {
  return `screenr_${kind}_${identity(root).slice(0, 12)}_test`;
}

// The application tests' database: this checkout's own database on the local
// PostgreSQL server unless TEST_DATABASE_URL names another.
export const testDatabaseURL =
  process.env.TEST_DATABASE_URL ??
  `postgresql://screenr:screenr-local-only@127.0.0.1:5439/${checkoutDatabase("app")}`;

const lock = "screenr-test-databases";
// A claimed database has a name no checkout derives, so a checkout recreated
// at its path gets a new database.
const claimPattern = "^screenr_dropping_[0-9a-f]{12}$";

async function advisory(
  admin: Client,
  call: "pg_advisory_lock" | "pg_try_advisory_lock" | "pg_advisory_unlock",
  key: string,
) {
  const { rows } = await admin.query<{ result: boolean }>(
    `SELECT ${call}(hashtextextended($1, 0)) AS result`,
    [key],
  );
  return rows[0].result;
}

// Creates a test database if it is missing. A checkout's own database also
// records the checkout in its comment, and preparing one drops unused checkout
// databases of removed checkouts or without a record, so they cannot
// accumulate as checkouts come and go. A database named by an override is only
// created.
export async function prepareTestDatabase(
  admin: Client,
  name: string,
  root = checkoutRoot,
) {
  // Preparations take turns, so none sees another's database before its
  // checkout is recorded. In its turn a preparation only claims the databases
  // to drop, and it leaves the drops to the background.
  await advisory(admin, "pg_advisory_lock", lock);
  try {
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } catch (error) {
      if ((error as { code?: string }).code !== "42P04") throw error;
    }
    if (
      name !== checkoutDatabase("app", root) &&
      name !== checkoutDatabase("browser", root)
    )
      return;
    await admin.query(
      `COMMENT ON DATABASE "${name}" IS ${admin.escapeLiteral(root)}`,
    );
    await claimRemovedCheckoutDatabases(admin);
  } finally {
    await advisory(admin, "pg_advisory_unlock", lock);
  }
  await startDroppingClaims(admin);
}

// Each drop waits for a PostgreSQL checkpoint, which took up to 18 seconds in
// a parallel run, so a detached process drops the claims, including any whose
// drop stopped before it finished, and no test start waits for one.
async function startDroppingClaims(admin: Client) {
  const { rowCount } = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname ~ '${claimPattern}' LIMIT 1`,
  );
  if (!rowCount) return;
  spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("drop-test-databases.ts", import.meta.url)),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PGHOST: admin.host,
        PGPORT: String(admin.port),
        PGUSER: admin.user,
        PGPASSWORD: admin.password,
        PGDATABASE: admin.database,
      },
    },
  ).unref();
}

async function claimRemovedCheckoutDatabases(admin: Client) {
  // A browser run holds its database's advisory lock, which
  // scripts/browser-server.ts takes, from before it creates the database until
  // it stops, including while no connection is open, such as during the build.
  const { rows } = await admin.query<{
    name: string;
    checkout: string | null;
    used: boolean;
  }>(
    `SELECT datname AS name, shobj_description(oid, 'pg_database') AS checkout,
      EXISTS (SELECT 1 FROM pg_stat_activity WHERE datid = pg_database.oid)
      OR EXISTS (
        SELECT 1 FROM pg_locks, hashtextextended('screenr-browser:database:' || datname, 0) AS key
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND classid::bigint = ((key >> 32) & 4294967295)
          AND objid::bigint = (key & 4294967295)
      ) AS used
    FROM pg_database WHERE datname ~ '^screenr_(app|browser)_[0-9a-f]{12}_test$'`,
  );
  for (const { name, checkout, used } of rows) {
    // Test databases are disposable; a checkout's next run recreates its own.
    // A recorded database is stale once its checkout is gone. An unrecorded
    // one was left by an interrupted preparation or made by a browser run
    // before checkouts were recorded, so it is stale once nothing uses it.
    const live = checkout && (!isAbsolute(checkout) || existsSync(checkout));
    // Renaming a connected database would also wait several seconds.
    if (used || live) continue;
    const claim = `screenr_dropping_${randomBytes(6).toString("hex")}`;
    try {
      await admin.query(`ALTER DATABASE "${name}" RENAME TO "${claim}"`);
    } catch (error) {
      // A process connected after the check, so a later preparation retries,
      // or a test already dropped its own database.
      const code = (error as { code?: string }).code;
      if (code !== "55006" && code !== "3D000") throw error;
    }
  }
}

// Run by scripts/drop-test-databases.ts. A drop holds a claim's lock until it
// finishes, so concurrent drops skip each other's claims, and the lock of a
// claim whose drop stopped first is free for a later one.
export async function dropClaimedDatabases(admin: Client) {
  const { rows } = await admin.query<{ name: string }>(
    `SELECT datname AS name FROM pg_database WHERE datname ~ '${claimPattern}'`,
  );
  const claimLock = (name: string) => `${lock}:${name}`;
  const held: string[] = [];
  for (const { name } of rows)
    if (await advisory(admin, "pg_try_advisory_lock", claimLock(name)))
      held.push(name);
  for (const name of held) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } catch (error) {
      // A process connected to the claim; a later preparation retries.
      if ((error as { code?: string }).code !== "55006") throw error;
    } finally {
      await advisory(admin, "pg_advisory_unlock", claimLock(name));
    }
  }
}

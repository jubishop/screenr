import { Pool, types, type PoolClient } from "pg";
import { logFailure } from "./log";
import { hasBlockedWord } from "./word-filter";

// The production build copies this module into each server bundle that
// imports it, such as the pages' and the route handlers', and runs every copy
// in the one web process; a development reload runs it again. Every copy uses
// one pool, kept on globalThis, so the process holds at most its `max`
// connections (docs/deployment.md#database-connections). Only the copy that
// opens the pool adds its listeners, and they record broken connections in a
// set that the copies also share.
const shared = globalThis as unknown as {
  screenrPool?: Pool;
  screenrBrokenConnections?: WeakSet<PoolClient>;
};

// pg emits an `error` event when PostgreSQL ends a connection outside a query,
// as a restart or crash recovery does. The pool forwards an idle connection's
// event; a checked-out one, such as one between a transaction's queries,
// emits its own. Unheard, either would stop the process. Each broken
// connection is logged once. The pool then drops it, and the next query on a
// checked-out one fails for its caller to handle.
const brokenConnections = (shared.screenrBrokenConnections ??=
  new WeakSet<PoolClient>());
function connectionFailed(error: Error, client: PoolClient) {
  if (brokenConnections.has(client)) return;
  brokenConnections.add(client);
  logFailure("database connection failed", {}, error);
}
function checkedOutConnectionFailed(this: PoolClient, error: Error) {
  connectionFailed(error, this);
}
function watch(pool: Pool) {
  pool.on("error", connectionFailed);
  pool.on("acquire", (client) =>
    client.on("error", checkedOutConnectionFailed),
  );
  pool.on("release", (_error, client) =>
    client.off("error", checkedOutConnectionFailed),
  );
  return pool;
}

export const db = (shared.screenrPool ??= watch(
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    types: {
      getTypeParser: (oid, format) => {
        // Better Auth performs arithmetic on bigint millisecond timestamps.
        // Keep them numeric; potentially large comment IDs are selected as text.
        if (oid === types.builtins.INT8 && format !== "binary")
          return (value: string) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number))
              throw new Error(
                "Select PostgreSQL integers outside JavaScript's safe range as text.",
              );
            return number;
          };
        return types.getTypeParser(oid, format);
      },
    },
  }),
));

// All domain mutations share this lock. This small invite-only app favors a
// clear ordering between permission changes and content writes.
export const domainLock = 713934201;

export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
  lock = domainLock,
): Promise<T> {
  const client = await db.connect();
  let rolledBack = true;
  try {
    // Bound every lock wait, including the shared lock the email worker holds
    // while it builds an activity email, so queued writes return their pool
    // connections well before the five-second connection timeout that session
    // lookups also use.
    await client.query("BEGIN; SET LOCAL lock_timeout = '2s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lock]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    rolledBack = await rollback(client);
    if ((error as { code?: string }).code === "55P03")
      throw new AppError("Screenr is busy. Please try again.", 503);
    throw error;
  } finally {
    client.release(!rolledBack);
  }
}

// Rolls back a failed transaction and reports whether that worked. A failed
// ROLLBACK, as on a broken connection, must not replace the error that ended
// the transaction, so it is logged instead, unless the broken connection
// already was. Release a client that could not roll back with `true`, so the
// pool closes its connection instead of reusing it.
export async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch (error) {
    if (!brokenConnections.has(client))
      logFailure("database rollback failed", {}, error);
    return false;
  }
}

// Runs independent work, such as queries, side by side as Promise.all does,
// but waits for every part to settle before it rejects, with the first failure
// in `work`'s order. Promise.all rejects at the first failure while the other
// parts run on, so a request could answer while its queries still ran and
// held their locks; a test's table reset then deadlocked with one (#469).
export async function settleAll<const T extends readonly unknown[]>(
  work: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(work);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  return results.map(
    (result) => (result as PromiseFulfilledResult<unknown>).value,
  ) as { -readonly [K in keyof T]: Awaited<T[K]> };
}

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// Lookups compare IDs with the column's own type so PostgreSQL can use its
// index. Only the text PostgreSQL prints for a uuid (lowercase, hyphenated) or
// a positive bigint (no leading zeros) is an ID. Services report any other
// value as not found before it reaches a cast that would fail.
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export const isBigintId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

// Text a member writes for others to read, trimmed: a post, comment, reply,
// review, display name, or username. Text with a blocked word is refused
// (docs/data-and-access.md#blocked-words).
export function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new AppError(`${label} must contain 1–${max} characters.`);
  }
  const content = value.trim();
  if (hasBlockedWord(content))
    throw new AppError(`${label} contains a word Screenr doesn’t allow.`);
  return content;
}

// Control characters, Unicode line and paragraph separators, and bidirectional
// embedding, override, and isolate controls. Zero-width joiners stay allowed
// for emoji sequences. db/012-display-name-characters.sql enforces the same set.
const hiddenCharacters = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export function displayNameText(value: unknown): string {
  const name = text(value, "Display name", 60);
  if (hiddenCharacters.test(name))
    throw new AppError(
      "Remove line breaks and hidden control characters from your display name.",
    );
  return name;
}

export function usernameText(value: unknown): string {
  const username = text(value, "Username", 24).toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username))
    throw new AppError(
      "Use 3–24 letters, numbers, or underscores for your username.",
    );
  return username;
}

import { Pool, type PoolClient } from "pg";

const globalDB = globalThis as unknown as { screenrPool?: Pool };
export const db =
  globalDB.screenrPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
if (process.env.NODE_ENV !== "production") globalDB.screenrPool = db;

export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // All domain mutations share this lock. This small invite-only app favors
    // a clear ordering between permission changes and content writes.
    await client.query("SELECT pg_advisory_xact_lock(713934201)");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new AppError(`${label} must contain 1–${max} characters.`);
  }
  return value.trim();
}

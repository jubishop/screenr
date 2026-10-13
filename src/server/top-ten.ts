import type { PoolClient } from "pg";
import { AppError, db } from "./db";
import type { TopTenEntry } from "../shared";
import { topTenLimit } from "../shared";

// Profile top 10 storage and reads (docs/profile-top-ten.md). Each entry is
// one of the owner's current Recommends, ranked from #1 without gaps. Writes
// run inside a domain transaction, whose lock orders them, and keep the ranks
// contiguous; title-actions.ts keeps the entries in step with Recommend.

// A member's list for anyone who can see their profile: the title's identity,
// public details, and rank only, with no Recommend entry IDs.
export async function topTen(owner: string): Promise<TopTenEntry[]> {
  return (
    await db.query<TopTenEntry>(
      `SELECT t.id,t.name,t.poster_path,e.rank FROM top_ten e
      JOIN title t ON t.id=e.title_id WHERE e.owner_id=$1 ORDER BY e.rank`,
      [owner],
    )
  ).rows;
}

// Each member's rank for one title, by user ID.
export async function topTenRanks(titleId: string) {
  const { rows } = await db.query<{ owner_id: string; rank: number }>(
    "SELECT owner_id,rank FROM top_ten WHERE title_id=$1",
    [titleId],
  );
  return new Map(rows.map((row) => [row.owner_id, row.rank]));
}

async function rankOf(client: PoolClient, owner: string, titleId: string) {
  return (
    (
      await client.query<{ rank: number }>(
        "SELECT rank FROM top_ten WHERE owner_id=$1 AND title_id=$2",
        [owner, titleId],
      )
    ).rows[0]?.rank ?? null
  );
}

// Removes a title and moves the entries below it up. Returns the rank it
// held, or null when it was not listed.
export async function leaveTopTen(
  client: PoolClient,
  owner: string,
  titleId: string,
) {
  const removed = (
    await client.query<{ rank: number }>(
      "DELETE FROM top_ten WHERE owner_id=$1 AND title_id=$2 RETURNING rank",
      [owner, titleId],
    )
  ).rows[0]?.rank;
  if (removed === undefined) return null;
  await client.query(
    "UPDATE top_ten SET rank=rank-1 WHERE owner_id=$1 AND rank>$2",
    [owner, removed],
  );
  return removed;
}

// Adds a recommended title at the next open rank. A full list first removes
// `replace`, so the new title joins at #10. A listed title keeps its rank.
export async function joinTopTen(
  client: PoolClient,
  owner: string,
  titleId: string,
  replace: string | null,
) {
  if (await rankOf(client, owner, titleId)) return;
  if (replace !== null) {
    if ((await leaveTopTen(client, owner, replace)) === null)
      throw new AppError("Choose a title from your top 10 to remove.");
  }
  const { count } = (
    await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM top_ten WHERE owner_id=$1",
      [owner],
    )
  ).rows[0];
  if (count >= topTenLimit)
    throw new AppError("Your top 10 is full. Choose a title to remove.");
  await client.query(
    "INSERT INTO top_ten(owner_id,title_id,rank) VALUES($1,$2,$3)",
    [owner, titleId, count + 1],
  );
}

// Swaps a title with its neighbor above or below. At either end the list
// stays as it is.
export async function moveInTopTen(
  client: PoolClient,
  owner: string,
  titleId: string,
  direction: "up" | "down",
) {
  const rank = await rankOf(client, owner, titleId);
  if (rank === null) throw new AppError("That title is not in your top 10.");
  const target = direction === "up" ? rank - 1 : rank + 1;
  await client.query(
    `UPDATE top_ten SET rank=CASE WHEN rank=$2 THEN $3 ELSE $2 END
    WHERE owner_id=$1 AND rank IN ($2,$3)
      AND EXISTS (SELECT 1 FROM top_ten WHERE owner_id=$1 AND rank=$3)`,
    [owner, rank, target],
  );
}

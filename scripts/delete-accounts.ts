// Erases again, after a restore, the accounts deleted since the backup:
// journalctl ... -o cat | node --import tsx scripts/delete-accounts.ts
// See docs/restore-and-patching.md#repeat-account-deletions.

// Modules load after the environment, so this file imports nothing statically.
export {};

// A local checkout keeps its settings in .env. The server passes its private
// environment instead, and variables already set take precedence.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as { code?: string }).code !== "ENOENT") throw error;
}
const { db } = await import("../src/server/db");
const { redeleteAccounts } = await import("../src/server/account-deletion");

// The journal lines arrive on standard input. Only `account deleted` events
// name accounts; every other line is ignored.
function deletedIds(journal: string) {
  const ids = new Set<string>();
  for (const line of journal.split("\n")) {
    let event: { event?: unknown; userId?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.event === "account deleted" && typeof event.userId === "string")
      ids.add(event.userId);
  }
  return [...ids];
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

try {
  let journal = "";
  for await (const chunk of process.stdin) journal += chunk;
  const ids = deletedIds(journal);
  const deleted = await redeleteAccounts(ids);
  const missing = ids.length - deleted;
  console.log(
    `Deleted ${plural(deleted, "account")} again.` +
      (missing
        ? ` ${plural(missing, "named account")} ${missing === 1 ? "was" : "were"} not in the database.`
        : ""),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}

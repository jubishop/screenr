import { db } from "./db";
import { parseMemberRoute } from "../member-routes";

// Unchanged polls of the friends feed and profiles answer 304 without
// building the screen (docs/data-and-access.md#write-lock-and-refresh-behavior,
// issue #373). Those screens change only when the database does, and every
// write to a table they read advances one change mark
// (db/040-screen-changes.sql). For each reader and screen path, this process
// remembers the version of the body it last sent, with the mark it read
// before building that body. A read that holds that version while the mark
// is unchanged gets 304 after reading only the mark. Versions stay hashes of
// the exact body, so clients see no difference but speed.
//
// A version is remembered only with a mark read before anything in its body,
// so a write that lands during the build moves the mark past it, and the next
// read builds again. Every bundle copy of this module shares one map, as
// db.ts shares its pool, and a restart forgets it.
const shared = globalThis as unknown as {
  screenrScreenVersions?: Map<string, { mark: string; version: string }>;
};
const remembered = (shared.screenrScreenVersions ??= new Map());
// The least recently used drop out past this many reader and path pairs.
const limit = 1000;

// The key that a screen read's versions are remembered under, or undefined
// for a screen that can change without a write, such as a title page's
// catalog data or Find a title's.
export function screenKey(userId: string, path: string) {
  const kind = parseMemberRoute(path).kind;
  if (kind === "feed" || kind === "profile") return `${userId}\n${path}`;
}

export async function changeMark() {
  return (
    await db.query<{ mark: string }>("SELECT mark::text FROM screen_change")
  ).rows[0].mark;
}

// A read's key and the change mark it read before building anything.
export type Remembered = { key: string; mark: string };

// The version last sent under `key`, if the database has not changed since.
export function rememberedVersion({ key, mark }: Remembered) {
  const entry = remembered.get(key);
  if (entry?.mark !== mark) return;
  remembered.delete(key);
  remembered.set(key, entry);
  return entry.version;
}

export function rememberVersion({ key, mark }: Remembered, version: string) {
  remembered.delete(key);
  remembered.set(key, { mark, version });
  if (remembered.size > limit)
    remembered.delete(remembered.keys().next().value!);
}

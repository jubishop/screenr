import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./social-fixture";

// The iPhone app's API fixtures (docs/testing.md#iphone-api-fixtures): real
// responses from the API route, with volatile values replaced by stable
// placeholders. `npm test` compares them with the checked-in files, and
// `npm run fixtures:ios` rewrites the files instead.
export const fixtureRoot = fileURLToPath(
  new URL("../../ios/ScreenrKit/Fixtures/", import.meta.url),
);
export const writingFixtures = process.env.SCREENR_WRITE_IOS_FIXTURES === "1";
export const regenerate = "npm run fixtures:ios";

export type Fixture = {
  description: string;
  // The signed-in member's username, or null for a signed-out request.
  viewer: string | null;
  request: {
    method: "GET" | "POST";
    action: string;
    // The path and query the client requests.
    path: string;
    query?: Record<string, string | string[]>;
    headers?: Record<string, string>;
    // A POST's JSON body.
    body?: unknown;
    // A POST whose body is a file, described instead of included.
    upload?: { contentType: string; bytes: number };
  };
  response: {
    status: number;
    // A GET's weak ETag, computed from the fixture body as the server does.
    etag?: string;
    // The JSON body, or null when the response has none (304).
    body: unknown;
  };
};

// Every timestamp becomes this instant. The API sends two formats, and each
// keeps its form: JavaScript dates (`2026-10-13T12:00:00.000Z`) and
// PostgreSQL JSON timestamps, whose fraction has up to six digits
// (`2026-10-13T12:00:00.000000+00:00`).
const instant = "2026-10-13T12:00:00";
const timestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const joinToken = "(?<=/join/)[A-Za-z0-9_-]{43}";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const digest = (text: string) => createHash("sha256").update(text).digest();

// A version 4 UUID derived from a label, so a named record keeps one ID in
// every fixture and every regeneration.
export function labelUuid(label: string) {
  const hex = digest(`uuid:${label}`).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
// A 43-character invitation token derived from a label, in the real format.
export const labelToken = (label: string) =>
  digest(`token:${label}`).toString("base64url");

// Replaces volatile values. Named values, such as user IDs, records the world
// created, invitation tokens, and ETags, keep the same placeholder in every
// fixture. Other UUIDs and invitation tokens, such as those an action
// creates, are numbered in order of appearance within each fixture.
export class Placeholders {
  readonly #named = new Map<string, string>();

  add(value: string, placeholder: string) {
    this.#named.set(value, placeholder);
  }

  scrub<T>(value: T): T {
    const numbered = new Map<string, string>();
    const counts = { uuid: 0, token: 0 };
    const pattern = new RegExp(
      [
        ...[...this.#named.keys()]
          .sort((a, b) => b.length - a.length)
          .map(escape),
        uuid,
        joinToken,
      ].join("|"),
      "g",
    );
    const placeholder = (match: string) => {
      const known = this.#named.get(match) ?? numbered.get(match);
      if (known) return known;
      const created = new RegExp(`^${uuid}$`).test(match)
        ? `00000000-0000-4000-8000-${String(++counts.uuid).padStart(12, "0")}`
        : labelToken(`unnamed-${++counts.token}`);
      numbered.set(match, created);
      return created;
    };
    const text = (value: string) => {
      const time = timestamp.exec(value);
      if (time)
        return time[1] === "Z" ? `${instant}.000Z` : `${instant}.000000+00:00`;
      return value.replace(pattern, placeholder);
    };
    const walk = (value: unknown, key?: string): unknown => {
      if (typeof value === "string")
        return key === "token" && /^[A-Za-z0-9_-]{43}$/.test(value)
          ? placeholder(value)
          : text(value);
      if (Array.isArray(value)) return value.map((item) => walk(item));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([name, item]) => [
            text(name),
            walk(item, name),
          ]),
        );
      return value;
    };
    return walk(value) as T;
  }
}

const serialize = (fixture: Fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

// Writes the fixture in write mode. Otherwise fails when the checked-in file
// is missing or differs, showing which fields changed.
export async function verifyFixture(file: string, fixture: Fixture) {
  const path = join(fixtureRoot, file);
  const expected = serialize(fixture);
  if (writingFixtures) {
    await mkdir(dirname(path), { recursive: true });
    const current = await readFile(path, "utf8").catch(() => null);
    if (current !== expected) await writeFile(path, expected);
    return;
  }
  const current = await readFile(path, "utf8").catch(() => null);
  assert.ok(
    current !== null,
    `Missing iPhone fixture ${file}. Run ${regenerate} and commit the result.`,
  );
  try {
    assert.deepStrictEqual(fixture, JSON.parse(current));
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    throw new assert.AssertionError({
      message: `The response no longer matches iPhone fixture ${file} (+ response, - fixture). If the change is intended, run ${regenerate} and review the fixture diff.\n${error.message}`,
    });
  }
  assert.equal(
    current,
    expected,
    `${file} is not formatted as generated. Run ${regenerate}.`,
  );
}

// Each fixture file needs a case. Write mode removes the others.
export async function verifyNoStaleFixtures(files: Set<string>) {
  const listed = await readdir(fixtureRoot, { recursive: true }).catch(
    () => [],
  );
  const stale = listed
    .map((file) => file.split(sep).join("/"))
    .filter((file) => file.endsWith(".json") && !files.has(file))
    .sort();
  if (writingFixtures) {
    for (const file of stale) await rm(join(fixtureRoot, file));
    return;
  }
  assert.deepEqual(
    stale,
    [],
    `These iPhone fixtures have no case. Run ${regenerate} to remove them.`,
  );
}

// Copies every table, so each write case can start from the same rows in one
// round trip instead of rebuilding them. Restoring disables the tables' own
// triggers, since the copies already hold the rows they derived, such as
// notifications, and returns each sequence to its saved value.
export async function saveDatabase() {
  const copy = "ios_fixture_world";
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const { rows: tables } = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'screenr_migration'
    ORDER BY c.relname`,
  );
  const { rows: references } = await db.query<{
    child: string;
    parent: string;
  }>(
    `SELECT child.relname AS child,parent.relname AS parent FROM pg_constraint k
    JOIN pg_class child ON child.oid=k.conrelid
    JOIN pg_class parent ON parent.oid=k.confrelid
    JOIN pg_namespace n ON n.oid=child.relnamespace
    WHERE k.contype='f' AND n.nspname='public' AND k.conrelid<>k.confrelid`,
  );
  // Referenced tables are restored before the tables that reference them.
  const order: string[] = [];
  const visit = (table: string) => {
    if (order.includes(table)) return;
    for (const { parent } of references.filter(({ child }) => child === table))
      visit(parent);
    order.push(table);
  };
  for (const { name } of tables) visit(name);
  const { rows: sequences } = await db.query<{
    name: string;
    value: string;
    called: boolean;
  }>(
    `SELECT format('%I.%I',schemaname,sequencename) AS name,
    coalesce(last_value,start_value)::text AS value,last_value IS NOT NULL AS called
    FROM pg_sequences WHERE schemaname='public'`,
  );
  const saved = (table: string) => `${copy}.${quote(table)}`;
  const live = (table: string) => `public.${quote(table)}`;
  await db.query(
    [
      `DROP SCHEMA IF EXISTS ${copy} CASCADE`,
      `CREATE SCHEMA ${copy}`,
      ...order.map(
        (table) => `CREATE TABLE ${saved(table)} AS TABLE ${live(table)}`,
      ),
    ].join(";\n"),
  );
  // A query with several statements runs as one transaction.
  const restore = [
    ...order.map((table) => `ALTER TABLE ${live(table)} DISABLE TRIGGER USER`),
    `TRUNCATE ${order.map(live).join(",")}`,
    ...order.map(
      (table) =>
        `INSERT INTO ${live(table)} OVERRIDING SYSTEM VALUE SELECT * FROM ${saved(table)}`,
    ),
    ...sequences.map(
      ({ name, value, called }) =>
        `SELECT setval('${name}',${value},${called})`,
    ),
    ...order.map((table) => `ALTER TABLE ${live(table)} ENABLE TRIGGER USER`),
  ].join(";\n");
  return {
    restore: () => db.query(restore),
    remove: () => db.query(`DROP SCHEMA ${copy} CASCADE`),
  };
}

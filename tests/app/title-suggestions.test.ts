import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Tests require a dedicated database ending in _test.");
process.env.BETTER_AUTH_SECRET = "screenr-test-secret-only-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const { db } = await import("../../src/server/db");
const { migrate } = await import("../../scripts/migrate");
const { loadScreen } = await import("../../src/server/screens");
const {
  changeRelationship,
  updateTitleActivity,
  addComment,
  createTitleComment,
  thread,
  profileFor,
} = await import("../../src/server/social");

before(migrate);
beforeEach(async () => {
  await db.query('TRUNCATE "user", title RESTART IDENTITY CASCADE');
});
after(() => db.end());

async function person(name: string) {
  await db.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
     VALUES($1,$1,$2,true,now(),now())`,
    [name, `${name}@example.test`],
  );
  await db.query(
    "INSERT INTO profile(user_id,username,display_name) VALUES($1,$1,$1)",
    [name],
  );
  return name;
}
async function friend(a: string, b: string) {
  await changeRelationship(a, b, "request");
  await changeRelationship(b, a, "accept");
}
async function title(id: string, name = id) {
  const [kind, tmdbId] = id.split(":");
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,$2,$3,$4)",
    [id, kind, tmdbId, name],
  );
  return id;
}
async function suggestions(viewer = "alice") {
  const screen = await loadScreen(viewer, "/search");
  assert.equal(screen.kind, "search");
  if (screen.kind !== "search") throw new Error("Expected search screen");
  assert.ok(
    Array.isArray(screen.suggestions),
    "Find a title must include suggestions before searching",
  );
  return screen.suggestions;
}

test("find a title suggests direct and anonymous second-degree choices before searching", async () => {
  for (const name of ["alice", "ben", "secretperson"]) await person(name);
  await friend("alice", "ben");
  await friend("ben", "secretperson");
  await title("movie:1", "Direct pick");
  await title("tv:1", "Second-degree pick");
  await updateTitleActivity("ben", "movie:1", "recommended", true);
  const privateItem = await updateTitleActivity(
    "secretperson",
    "tv:1",
    "want_to_watch",
    true,
  );

  const result = await suggestions();
  assert.deepEqual(
    result.map((item) => item.id),
    ["movie:1", "tv:1"],
  );
  assert.deepEqual(result[0].recommended_by, [
    { username: "ben", display_name: "ben" },
  ]);
  assert.deepEqual(result[1].wanted_by, []);
  assert.equal(result[1].second_degree_wanted, 1);
  assert.equal(result[1].second_degree_recommended, 0);
  assert.ok(!JSON.stringify(result).includes("secretperson"));
  assert.ok(!JSON.stringify(result).includes(privateItem));
  await assert.rejects(thread("alice", privateItem), /not found/);
  assert.equal((await profileFor("alice", "secretperson")).can_read, false);
});

test("suggestions rank recommendations first with 3:1 weights, distinct people, and stable ties", async () => {
  for (const name of ["alice", "ben", "cam", "dee", "eli", "fay", "gia"])
    await person(name);
  await friend("alice", "ben");
  await friend("alice", "cam");
  await friend("ben", "cam"); // A direct friend must not also count as second-degree.
  for (const name of ["dee", "eli", "fay", "gia"]) {
    await friend("ben", name);
    await friend("cam", name); // Two paths to each second-degree person.
  }
  for (const [id, name] of [
    [1, "Direct"],
    [2, "Second"],
    [3, "Different people's actions"],
    [4, "Recent"],
    [5, "Alpha"],
    [6, "Zulu"],
    [7, "Alpha"],
    [8, "Interest"],
    [9, "Two direct"],
  ] as const)
    await title(`movie:${id}`, name);
  await updateTitleActivity("ben", "movie:1", "recommended", true);
  for (const name of ["dee", "eli", "fay", "gia"])
    await updateTitleActivity(name, "movie:2", "recommended", true);
  await updateTitleActivity("ben", "movie:3", "recommended", true);
  await updateTitleActivity("cam", "movie:3", "want_to_watch", true);
  for (const [name, id] of [
    ["dee", 4],
    ["eli", 5],
    ["fay", 6],
    ["gia", 7],
  ] as const)
    await updateTitleActivity(name, `movie:${id}`, "recommended", true);
  for (const name of ["ben", "cam"]) {
    await updateTitleActivity(name, "movie:8", "want_to_watch", true);
    await updateTitleActivity(name, "movie:9", "recommended", true);
  }
  await db.query(`UPDATE feed_item SET activity_at=CASE
    WHEN title_id='movie:4' THEN '2026-01-03'::timestamptz
    WHEN title_id IN ('movie:5','movie:6','movie:7') THEN '2026-01-02'::timestamptz
    ELSE '2026-01-01'::timestamptz END`);
  const result = await suggestions();
  assert.deepEqual(
    result.map((item) => item.id),
    [9, 2, 3, 1, 4, 5, 7, 6, 8].map((n) => `movie:${n}`),
  );
  assert.equal(result[1].second_degree_recommended, 4);
  assert.equal(result[0].recommended_by.length, 2);
  assert.equal(result[0].second_degree_recommended, 0);
  assert.deepEqual(result[2].recommended_by, [
    { username: "ben", display_name: "ben" },
  ]);
  assert.deepEqual(result[2].wanted_by, [
    { username: "cam", display_name: "cam" },
  ]);

  // A fresh reply must not move an old active action above a newer action.
  const item = await updateTitleActivity("eli", "movie:5", "recommended", true);
  await addComment(
    "ben",
    item,
    "A new reply, not a new recommendation.",
    false,
  );
  assert.deepEqual(
    (await suggestions()).map((entry) => entry.id),
    result.map((entry) => entry.id),
  );
});

test("only current viewer and source actions affect eligibility, not comments or history", async () => {
  await person("alice");
  await person("ben");
  await friend("alice", "ben");
  await title("movie:1");
  await title("movie:2");
  const item = await updateTitleActivity("ben", "movie:1", "recommended", true);
  await addComment("alice", item, "Keep this discussion.", false);
  await createTitleComment(
    "alice",
    "movie:1",
    "Already discussed this.",
    false,
  );
  await createTitleComment("ben", "movie:2", "A comment alone.", false);
  assert.deepEqual(
    (await suggestions()).map((entry) => entry.id),
    ["movie:1"],
  );
  await updateTitleActivity("alice", "movie:1", "recommended", true);
  assert.deepEqual(await suggestions(), []);
  await updateTitleActivity("alice", "movie:1", "want_to_watch", true);
  await updateTitleActivity("alice", "movie:1", "recommended", false);
  assert.deepEqual(await suggestions(), []);
  await updateTitleActivity("alice", "movie:1", "want_to_watch", false);
  assert.equal((await suggestions()).length, 1);
  await updateTitleActivity("ben", "movie:1", "recommended", false);
  assert.equal((await thread("alice", item)).comments.length, 1);
  assert.deepEqual(await suggestions(), []);
  await updateTitleActivity("ben", "movie:1", "want_to_watch", true);
  assert.equal((await suggestions())[0].wanted_by.length, 1);
});

test("pending edges, self, outsiders, and more distant people cannot supply suggestions", async () => {
  for (const name of ["alice", "ben", "dee", "eli", "cam", "fay", "gus", "out"])
    await person(name);
  await friend("alice", "ben");
  await friend("ben", "dee");
  await friend("dee", "eli");
  await changeRelationship("alice", "cam", "request");
  await friend("cam", "fay");
  await changeRelationship("ben", "gus", "request");
  for (const [index, name] of [
    "alice",
    "ben",
    "dee",
    "eli",
    "cam",
    "fay",
    "gus",
    "out",
  ].entries()) {
    const id = await title(`movie:${index + 1}`);
    await updateTitleActivity(name, id, "recommended", true);
  }
  assert.deepEqual(
    new Set((await suggestions()).map((entry) => entry.id)),
    new Set(["movie:2", "movie:3"]),
  );
  await changeRelationship("cam", "alice", "accept");
  assert.deepEqual(
    new Set((await suggestions()).map((entry) => entry.id)),
    new Set(["movie:2", "movie:3", "movie:5", "movie:6"]),
  );
  await changeRelationship("gus", "ben", "accept");
  assert.ok((await suggestions()).some((entry) => entry.id === "movie:7"));
});

test("suggestions refresh friendship paths, attribution, blocking, and restoration", async () => {
  for (const name of ["alice", "ben", "cam", "dee"]) await person(name);
  for (const [a, b] of [
    ["alice", "ben"],
    ["alice", "cam"],
    ["ben", "cam"],
    ["ben", "dee"],
    ["cam", "dee"],
  ])
    await friend(a, b);
  await title("movie:1");
  await title("movie:2");
  await updateTitleActivity("dee", "movie:1", "recommended", true);
  await updateTitleActivity("ben", "movie:2", "recommended", true);
  assert.equal(
    (await suggestions()).find((entry) => entry.id === "movie:2")!
      .recommended_by.length,
    1,
  );
  await changeRelationship("alice", "ben", "remove");
  let result = await suggestions();
  const demoted = result.find((entry) => entry.id === "movie:2")!;
  assert.deepEqual(demoted.recommended_by, []);
  assert.equal(demoted.second_degree_recommended, 1);
  assert.ok(!JSON.stringify(result).includes('"ben"'));
  await friend("alice", "ben");
  assert.equal(
    (await suggestions()).find((entry) => entry.id === "movie:2")!
      .recommended_by.length,
    1,
  );
  await changeRelationship("alice", "ben", "block");
  result = await suggestions();
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["movie:1"],
  );
  assert.equal(result[0].second_degree_recommended, 1);
  await changeRelationship("dee", "alice", "block");
  assert.deepEqual(await suggestions(), []);
  await changeRelationship("dee", "alice", "unblock");
  assert.equal((await suggestions()).length, 1);
  await changeRelationship("cam", "dee", "remove");
  assert.deepEqual(await suggestions(), []); // Remaining path uses blocked Ben.
  await friend("cam", "dee");
  await changeRelationship("alice", "cam", "remove");
  assert.deepEqual(await suggestions(), []);
});

test("blocking either edge suppresses a path even with a retained accepted friendship", async () => {
  for (const name of ["alice", "ben", "dee"]) await person(name);
  await friend("alice", "ben");
  await friend("ben", "dee");
  await title("movie:1");
  await updateTitleActivity("dee", "movie:1", "recommended", true);
  for (const [a, b] of [
    ["alice", "ben"],
    ["ben", "alice"],
    ["ben", "dee"],
    ["dee", "ben"],
    ["alice", "dee"],
    ["dee", "alice"],
  ]) {
    await db.query("INSERT INTO block(blocker_id,blocked_id) VALUES($1,$2)", [
      a,
      b,
    ]);
    assert.deepEqual(await suggestions(), [], `${a} blocking ${b}`);
    await db.query("DELETE FROM block WHERE blocker_id=$1 AND blocked_id=$2", [
      a,
      b,
    ]);
    assert.equal((await suggestions()).length, 1);
  }
});

test("suggestions include every eligible title without catalog requests or a fixed limit", async () => {
  await person("alice");
  await person("ben");
  await friend("alice", "ben");
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name)
    SELECT 'movie:'||n,'movie',n,'Title '||n FROM generate_series(1,205) AS n`);
  for (let n = 1; n <= 205; n++)
    await updateTitleActivity("ben", `movie:${n}`, "want_to_watch", true);
  const result = await suggestions();
  assert.equal(result.length, 205);
  assert.equal(new Set(result.map((entry) => entry.id)).size, 205);
  assert.equal(typeof result[0].tmdb_id, "number");
  await changeRelationship("alice", "ben", "remove");
  assert.deepEqual(await suggestions(), []);
});

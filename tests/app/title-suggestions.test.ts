import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, denied } from "./social-fixture";

const { migrate } = await import("../../scripts/migrate");
const { loadScreen } = await import("../../src/server/screens");
const { profileFor } = await import("../../src/server/profiles");
const { changeRelationship } = await import("../../src/server/relationships");
const { thread } = await import("../../src/server/feed");
const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");
const { addComment, createTitleComment } =
  await import("../../src/server/comments");

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
async function friendsOf(via: string, ...names: string[]) {
  for (const name of names) {
    await person(name);
    await friend(via, name);
  }
  return names;
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
  for (const name of ["alice", "ben"]) await person(name);
  await friend("alice", "ben");
  const hidden = await friendsOf(
    "ben",
    "secretone",
    "secrettwo",
    "secretthree",
  );
  await title("movie:1", "Direct pick");
  await title("tv:1", "Second-degree pick");
  await updateTitleActivity("ben", "movie:1", "recommended", true);
  const privateItems: string[] = [];
  for (const name of hidden)
    privateItems.push(
      await updateTitleActivity(name, "tv:1", "want_to_watch", true),
    );

  const result = await suggestions();
  assert.deepEqual(
    result.map((item) => item.id),
    ["movie:1", "tv:1"],
  );
  assert.deepEqual(result[0].recommended_by, [
    { username: "ben", display_name: "ben", rank: null },
  ]);
  assert.deepEqual(result[1].wanted_by, []);
  assert.equal(result[1].second_degree_wanted, 3);
  assert.equal(result[1].second_degree_recommended, 0);
  for (const value of [...hidden, ...privateItems])
    assert.ok(!JSON.stringify(result).includes(value));
  await assert.rejects(thread("alice", privateItems[0]), denied.conversation);
  assert.equal((await profileFor("alice", "secretone")).can_read, false);
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
  // Three second-degree recommendations score 3, tying one direct-friend
  // recommendation, so the latest action and then the name break ties.
  for (const [id, names] of [
    [4, ["dee", "eli", "fay"]],
    [5, ["eli", "fay", "gia"]],
    [6, ["fay", "gia", "dee"]],
    [7, ["gia", "dee", "eli"]],
  ] as const)
    for (const name of names)
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
    [9, 2, 3, 4, 5, 7, 6, 1, 8].map((n) => `movie:${n}`),
  );
  assert.equal(result[1].second_degree_recommended, 4);
  assert.equal(result[3].second_degree_recommended, 3);
  assert.equal(result[0].recommended_by.length, 2);
  assert.equal(result[0].second_degree_recommended, 0);
  assert.deepEqual(result[2].recommended_by, [
    { username: "ben", display_name: "ben", rank: null },
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

test("one or two friends of friends cannot qualify, rank, or label a title; three can", async () => {
  for (const name of ["alice", "ben", "cam"]) await person(name);
  await friend("alice", "ben");
  await friend("alice", "cam");
  const [dee, eli, fay, gia, hal] = await friendsOf(
    "ben",
    "dee",
    "eli",
    "fay",
    "gia",
    "hal",
  );
  // A second path to each person must not count them twice.
  for (const name of [dee, eli, fay, gia, hal]) await friend("cam", name);
  const plan = [
    [1, "One", [dee], []],
    [2, "Two", [dee, eli], []],
    [3, "Three", [dee, eli, fay], []],
    [4, "Split", [dee, eli], [fay, gia]],
    [5, "Wanted", [gia, hal], [dee, eli, fay]],
    [6, "Zulu direct", ["ben", dee, eli], []],
    [7, "Alpha direct", ["ben"], []],
    [8, "Also wanted", [], [dee, eli, fay]],
  ] as const;
  for (const [id, name, recommenders, wanters] of plan) {
    await title(`movie:${id}`, name);
    for (const source of recommenders)
      await updateTitleActivity(source, `movie:${id}`, "recommended", true);
    for (const source of wanters)
      await updateTitleActivity(source, `movie:${id}`, "want_to_watch", true);
  }
  // Ignored signals are the newest, so counting them in ranking or the
  // latest-action tie-break would move Zulu direct and Wanted earlier.
  await db.query(`UPDATE feed_item SET activity_at=CASE
    WHEN (title_id='movie:6' AND owner_id<>'ben')
      OR (title_id='movie:5' AND item_type='recommended')
    THEN '2026-01-05'::timestamptz ELSE '2026-01-01'::timestamptz END`);

  const result = await suggestions();
  assert.deepEqual(
    result.map((entry) => entry.id),
    [7, 3, 6, 8, 5].map((n) => `movie:${n}`),
  );
  const counts = result.map((entry) => [
    entry.second_degree_recommended,
    entry.second_degree_wanted,
  ]);
  assert.deepEqual(counts, [
    [0, 0],
    [3, 0],
    [0, 0],
    [0, 3],
    [0, 3],
  ]);
  assert.deepEqual(result[2].recommended_by, [
    { username: "ben", display_name: "ben", rank: null },
  ]);
  for (const name of [dee, eli, fay, gia, hal])
    assert.ok(!JSON.stringify(result).includes(`"${name}"`));
});

// Recommends a title and stores its rank in the owner's top 10 directly, so
// a test can pick any rank. tests/app/top-ten.test.ts covers the list rules.
async function rankIn(owner: string, id: string, rank: number) {
  await updateTitleActivity(owner, id, "recommended", true);
  await db.query(
    "INSERT INTO top_ten(owner_id,title_id,rank) VALUES($1,$2,$3)",
    [owner, id, rank],
  );
}

test("top 10 Recommends count 1.5× at #10 up to 1.95× at #1 in groups that meet the minimum", async () => {
  for (const name of ["alice", "ben", "cam", "dee"]) await person(name);
  for (const name of ["ben", "cam", "dee"]) await friend("alice", name);
  const [eve, fin, gus, hep, ivy] = await friendsOf(
    "ben",
    "eve",
    "fin",
    "gus",
    "hep",
    "ivy",
  );
  for (const [id, name] of [
    [1, "A direct #1"],
    [2, "B direct #10"],
    [3, "C direct plain"],
    [4, "D second-degree #1"],
    [5, "E second-degree #2, #5, #10"],
    [6, "F two second-degree #1"],
    [7, "G second-degree plain"],
    [8, "H direct mixed"],
    [9, "I wanted"],
  ] as const)
    await title(`movie:${id}`, name);
  // Scores in twentieths: a plain Recommend is 20 and #N is 40 - N, times
  // 3 for a direct friend or 1 for a friend of a friend.
  await rankIn("ben", "movie:1", 1); // 3 × 39 = 117
  await rankIn("cam", "movie:2", 10); // 3 × 30 = 90
  await updateTitleActivity("dee", "movie:3", "recommended", true); // 60
  for (const name of [eve, fin, gus]) await rankIn(name, "movie:4", 1); // 117
  await rankIn(eve, "movie:5", 2); // 38
  await rankIn(fin, "movie:5", 5); // + 35
  await rankIn(gus, "movie:5", 10); // + 30 = 103
  // Two friends of friends are below the minimum, so their #1 boost is
  // ignored with the rest of their signal: 60, not 60 + 78.
  await updateTitleActivity("dee", "movie:6", "recommended", true);
  for (const name of [hep, ivy]) await rankIn(name, "movie:6", 1);
  for (const name of [eve, fin, gus])
    await updateTitleActivity(name, "movie:7", "recommended", true); // 60
  await updateTitleActivity("ben", "movie:8", "recommended", true);
  await rankIn("cam", "movie:8", 3);
  await rankIn("dee", "movie:8", 2); // 60 + 111 + 114 = 285
  // Recommendation totals still come before Want to watch totals.
  for (const name of ["ben", "cam", "dee"])
    await updateTitleActivity(name, "movie:9", "want_to_watch", true);
  await db.query("UPDATE feed_item SET activity_at='2026-01-01'");

  const result = await suggestions();
  // Equal scores fall back to the title name.
  assert.deepEqual(
    result.map((entry) => entry.id),
    [8, 1, 4, 5, 2, 3, 6, 7, 9].map((n) => `movie:${n}`),
  );
  const byId = new Map(result.map((entry) => [entry.id, entry]));
  // Direct friends carry their rank, top 10 first by rank, then by username.
  assert.deepEqual(byId.get("movie:8")!.recommended_by, [
    { username: "dee", display_name: "dee", rank: 2 },
    { username: "cam", display_name: "cam", rank: 3 },
    { username: "ben", display_name: "ben", rank: null },
  ]);
  assert.deepEqual(byId.get("movie:1")!.recommended_by, [
    { username: "ben", display_name: "ben", rank: 1 },
  ]);
  assert.deepEqual(byId.get("movie:6")!.recommended_by, [
    { username: "dee", display_name: "dee", rank: null },
  ]);
  // Second-degree counts stay plain counts, and nothing returns a score or
  // a friend of a friend's rank.
  assert.equal(byId.get("movie:4")!.second_degree_recommended, 3);
  assert.equal(byId.get("movie:5")!.second_degree_recommended, 3);
  assert.equal(byId.get("movie:6")!.second_degree_recommended, 0);
  for (const entry of result) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "id",
      "kind",
      "name",
      "overview",
      "poster_path",
      "recommended_by",
      "release",
      "release_date",
      "second_degree_recommended",
      "second_degree_wanted",
      "second_degree_watching",
      "tmdb_id",
      "viewing",
      "wanted_by",
      "watching_by",
    ]);
    for (const friend of entry.recommended_by)
      assert.deepEqual(Object.keys(friend).sort(), [
        "display_name",
        "rank",
        "username",
      ]);
    for (const friend of [...entry.wanted_by, ...entry.watching_by])
      assert.deepEqual(Object.keys(friend).sort(), [
        "display_name",
        "username",
      ]);
  }
  for (const name of [eve, fin, gus, hep, ivy])
    assert.ok(!JSON.stringify(result).includes(`"${name}"`));
});

test("the second-degree minimum counts only current, unblocked, connected people", async () => {
  for (const name of ["alice", "ben"]) await person(name);
  await friend("alice", "ben");
  const [dee, eli, fay, gia] = await friendsOf(
    "ben",
    "dee",
    "eli",
    "fay",
    "gia",
  );
  await title("movie:1", "Direct pick");
  await title("movie:2", "Interest");
  for (const name of ["ben", dee, eli])
    await updateTitleActivity(name, "movie:1", "recommended", true);
  for (const name of [dee, eli])
    await updateTitleActivity(name, "movie:2", "want_to_watch", true);
  const shown = async () =>
    (await suggestions()).map((entry) => [
      entry.id,
      entry.second_degree_recommended,
      entry.second_degree_wanted,
    ]);
  assert.deepEqual(await shown(), [["movie:1", 0, 0]]);

  await updateTitleActivity(fay, "movie:1", "recommended", true);
  await updateTitleActivity(fay, "movie:2", "want_to_watch", true);
  assert.deepEqual(await shown(), [
    ["movie:1", 3, 0],
    ["movie:2", 0, 3],
  ]);

  await changeRelationship("alice", eli, "block");
  assert.deepEqual(await shown(), [["movie:1", 0, 0]]);
  await changeRelationship("alice", eli, "unblock");
  assert.equal((await shown()).length, 2);

  await updateTitleActivity(dee, "movie:2", "want_to_watch", false);
  assert.deepEqual(await shown(), [["movie:1", 3, 0]]);
  await updateTitleActivity(gia, "movie:2", "want_to_watch", true);
  assert.equal((await shown()).length, 2);

  await changeRelationship("ben", dee, "remove");
  assert.deepEqual(await shown(), [
    ["movie:1", 0, 0],
    ["movie:2", 0, 3],
  ]);
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

test("friends' Watching and Caught up suggest titles; Finished, Stopped, and cleared statuses do not", async () => {
  for (const name of ["alice", "ben", "cam"]) await person(name);
  await friend("alice", "ben");
  await friend("alice", "cam");
  for (const [id, name] of [
    ["movie:1", "Watching"],
    ["tv:1", "Caught up"],
    ["movie:2", "Finished"],
    ["movie:3", "Stopped"],
    ["movie:4", "Cleared"],
  ])
    await title(id, name);
  await updateWatchStatus("ben", "movie:1", "watching");
  await updateWatchStatus("cam", "movie:1", "watching");
  await updateWatchStatus("cam", "tv:1", "caught_up");
  await updateWatchStatus("ben", "movie:2", "finished");
  await updateWatchStatus("cam", "movie:3", "stopped");
  await updateWatchStatus("ben", "movie:4", "watching");
  await updateWatchStatus("ben", "movie:4", null);

  const result = await suggestions();
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["movie:1", "tv:1"],
  );
  assert.deepEqual(result[0].watching_by, [
    { username: "ben", display_name: "ben" },
    { username: "cam", display_name: "cam" },
  ]);
  assert.deepEqual(result[1].watching_by, [
    { username: "cam", display_name: "cam" },
  ]);
  for (const entry of result) {
    assert.deepEqual(entry.recommended_by, []);
    assert.deepEqual(entry.wanted_by, []);
    assert.equal(entry.second_degree_watching, 0);
  }

  // Finishing a show moves it out; watching it again brings it back.
  await updateWatchStatus("cam", "tv:1", "finished");
  assert.deepEqual(
    (await suggestions()).map((entry) => entry.id),
    ["movie:1"],
  );
  await updateWatchStatus("cam", "tv:1", "watching");
  assert.equal((await suggestions()).length, 2);
});

test("any current viewer status excludes a title until the viewer clears it", async () => {
  for (const name of ["alice", "ben"]) await person(name);
  await friend("alice", "ben");
  await title("movie:1");
  await title("tv:1");
  await updateTitleActivity("ben", "movie:1", "recommended", true);
  await updateWatchStatus("ben", "tv:1", "watching");
  const shown = async () => (await suggestions()).map((entry) => entry.id);
  assert.deepEqual(await shown(), ["movie:1", "tv:1"]);
  for (const status of [
    "want_to_watch",
    "watching",
    "caught_up",
    "finished",
    "stopped",
  ]) {
    await updateWatchStatus("alice", "tv:1", status);
    assert.deepEqual(await shown(), ["movie:1"], status);
    await updateWatchStatus(
      "alice",
      "movie:1",
      status === "caught_up" ? "watching" : status,
    );
    assert.deepEqual(await shown(), [], status);
    await updateWatchStatus("alice", "tv:1", null);
    await updateWatchStatus("alice", "movie:1", null);
    assert.deepEqual(await shown(), ["movie:1", "tv:1"], status);
  }
  // Recommend alongside a cleared status still excludes the title.
  await updateWatchStatus("alice", "tv:1", "finished");
  await updateTitleActivity("alice", "tv:1", "recommended", true);
  await updateWatchStatus("alice", "tv:1", null);
  assert.deepEqual(await shown(), ["movie:1"]);
});

test("Watching ranks after Recommend and Want to watch with 3:1 weights and its own latest activity", async () => {
  for (const name of ["alice", "ben", "cam", "dee", "eli", "fay", "gia"])
    await person(name);
  await friend("alice", "ben");
  await friend("alice", "cam");
  for (const name of ["dee", "eli", "fay", "gia"]) {
    await friend("ben", name);
    await friend("cam", name); // Two paths must not count anyone twice.
  }
  for (const [id, name] of [
    [1, "Direct watching"],
    [2, "Four watching"],
    [3, "Wanted"],
    [4, "Second-degree recommendation"],
    [5, "Older tie"],
    [6, "Newer tie"],
    [7, "Wanted and watching"],
  ] as const)
    await title(`movie:${id}`, name);
  await updateWatchStatus("ben", "movie:1", "watching");
  for (const name of ["dee", "eli", "fay", "gia"])
    await updateWatchStatus(name, "movie:2", "watching");
  await updateTitleActivity("cam", "movie:3", "want_to_watch", true);
  for (const name of ["dee", "eli", "fay"])
    await updateTitleActivity(name, "movie:4", "recommended", true);
  // Three second-degree watchers score 3, tying one direct watcher.
  for (const name of ["eli", "fay", "gia"])
    await updateWatchStatus(name, "movie:5", "watching");
  await updateWatchStatus("cam", "movie:6", "watching");
  await updateTitleActivity("ben", "movie:7", "want_to_watch", true);
  await updateWatchStatus("cam", "movie:7", "watching");
  await db.query(`UPDATE feed_item SET activity_at='2026-01-01'`);
  await db.query(`UPDATE watch_progress SET activity_at=CASE
    WHEN title_id='movie:6' THEN '2026-01-04'::timestamptz
    WHEN title_id='movie:1' THEN '2026-01-03'::timestamptz
    ELSE '2026-01-02'::timestamptz END`);

  const result = await suggestions();
  assert.deepEqual(
    result.map((entry) => entry.id),
    [4, 7, 3, 2, 6, 1, 5].map((n) => `movie:${n}`),
  );
  const byId = new Map(result.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("movie:2")!.second_degree_watching, 4);
  assert.equal(byId.get("movie:5")!.second_degree_watching, 3);
  assert.deepEqual(byId.get("movie:7")!.wanted_by, [
    { username: "ben", display_name: "ben" },
  ]);
  assert.deepEqual(byId.get("movie:7")!.watching_by, [
    { username: "cam", display_name: "cam" },
  ]);
  assert.deepEqual(byId.get("movie:1")!.watching_by, [
    { username: "ben", display_name: "ben" },
  ]);
});

test("second-degree Watching needs three people of its own and stays anonymous", async () => {
  for (const name of ["alice", "ben"]) await person(name);
  await friend("alice", "ben");
  const [dee, eli, fay, gia] = await friendsOf(
    "ben",
    "dee",
    "eli",
    "fay",
    "gia",
  );
  await title("movie:1", "Two watching");
  await title("movie:2", "Split groups");
  await title("tv:1", "Three watching");
  await title("movie:3", "Direct recommendation");
  for (const name of [dee, eli])
    await updateWatchStatus(name, "movie:1", "watching");
  // Four people, but neither group reaches three on its own.
  for (const name of [dee, eli])
    await updateTitleActivity(name, "movie:2", "want_to_watch", true);
  for (const name of [fay, gia])
    await updateWatchStatus(name, "movie:2", "watching");
  await updateWatchStatus(dee, "tv:1", "watching");
  await updateWatchStatus(eli, "tv:1", "caught_up");
  await updateWatchStatus(fay, "tv:1", "watching");
  await updateWatchStatus(gia, "tv:1", "finished");
  await updateTitleActivity("ben", "movie:3", "recommended", true);
  // Two second-degree watchers add no count to a title direct activity qualifies.
  for (const name of [dee, eli])
    await updateWatchStatus(name, "movie:3", "watching");

  const shown = async () =>
    (await suggestions()).map((entry) => [
      entry.id,
      entry.second_degree_watching,
      entry.second_degree_wanted,
    ]);
  assert.deepEqual(await shown(), [
    ["movie:3", 0, 0],
    ["tv:1", 3, 0],
  ]);
  const result = await suggestions();
  assert.deepEqual(result[1].watching_by, []);
  for (const name of [dee, eli, fay, gia])
    assert.ok(!JSON.stringify(result).includes(`"${name}"`));

  // The newest Watching entry breaks the tie between equal Watching scores.
  await updateWatchStatus(fay, "movie:1", "watching");
  assert.deepEqual(await shown(), [
    ["movie:3", 0, 0],
    ["movie:1", 3, 0],
    ["tv:1", 3, 0],
  ]);
  await changeRelationship("alice", fay, "block");
  assert.deepEqual(await shown(), [["movie:3", 0, 0]]);
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
  // Two eligible friends of friends recommend every title, so a title's
  // second-degree signal qualifies only when its source person also counts.
  const anchors = await friendsOf("ben", "kit", "lou");
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
    for (const source of [name, ...anchors])
      await updateTitleActivity(source, id, "recommended", true);
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
  // Two friends of friends through Cam recommend both titles, so each
  // second-degree signal depends on whether Ben or Dee also counts.
  const anchors = await friendsOf("cam", "kit", "lou");
  await title("movie:1");
  await title("movie:2");
  for (const name of ["dee", ...anchors])
    await updateTitleActivity(name, "movie:1", "recommended", true);
  for (const name of ["ben", ...anchors])
    await updateTitleActivity(name, "movie:2", "recommended", true);
  let promoted = (await suggestions()).find((entry) => entry.id === "movie:2")!;
  assert.equal(promoted.recommended_by.length, 1);
  assert.equal(promoted.second_degree_recommended, 0);
  await changeRelationship("alice", "ben", "remove");
  let result = await suggestions();
  const demoted = result.find((entry) => entry.id === "movie:2")!;
  assert.deepEqual(demoted.recommended_by, []);
  assert.equal(demoted.second_degree_recommended, 3);
  assert.ok(!JSON.stringify(result).includes('"ben"'));
  await friend("alice", "ben");
  promoted = (await suggestions()).find((entry) => entry.id === "movie:2")!;
  assert.equal(promoted.recommended_by.length, 1);
  assert.equal(promoted.second_degree_recommended, 0);
  await changeRelationship("alice", "ben", "block");
  result = await suggestions();
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["movie:1"],
  );
  assert.equal(result[0].second_degree_recommended, 3);
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
  for (const name of ["alice", "ben", "cam", "dee"]) await person(name);
  await friend("alice", "ben");
  await friend("alice", "cam");
  await friend("ben", "dee");
  await title("movie:1");
  // Two friends of friends through Cam, whom these blocks don't affect, also
  // recommend the title, so it qualifies only while Dee's path counts.
  for (const name of ["dee", ...(await friendsOf("cam", "kit", "lou"))])
    await updateTitleActivity(name, "movie:1", "recommended", true);
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

test("suggestions include every eligible title without a fixed limit", async () => {
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

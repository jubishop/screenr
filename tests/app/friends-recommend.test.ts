import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, person } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity, updateWatchStatus } =
  await import("../../src/server/title-actions");
const { addComment, createTitleComment } =
  await import("../../src/server/comments");

useDatabase();

async function titles(count: number) {
  for (let id = 1; id <= count; id++)
    for (const kind of ["movie", "tv"])
      await db.query(
        `INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`,
        [
          `${kind}:${id}`,
          kind,
          id,
          `${kind === "tv" ? "Show" : "Movie"} ${id}`,
        ],
      );
}
async function people(...names: string[]) {
  const ids: string[] = [];
  for (const name of names) ids.push(await person(name));
  return ids;
}
async function recommend(owner: string, title: string, at?: string) {
  const item = await updateTitleActivity(owner, title, "recommended", true);
  if (at)
    await db.query("UPDATE feed_item SET activity_at=$2 WHERE id=$1", [
      item,
      at,
    ]);
  return item;
}
// The viewer's Friends recommend tab on Find a title.
async function recommendations(viewer: string) {
  const screen = await loadScreen(viewer, "/search?tab=friends-recommend");
  assert.ok(screen.kind === "search");
  return screen.recommendations;
}
// Each listed title with its recommending friends' display names.
async function listed(viewer: string) {
  return (await recommendations(viewer)).map((title) => [
    title.id,
    title.recommended_by.map((friend) => friend.display_name),
  ]);
}

test("Friends recommend sorts by recommending friends, then the most recent recommendation, naming friends newest first", async () => {
  await titles(6);
  const [viewer, maya, sam, theo, ana] = await people(
    "viewer",
    "maya",
    "sam",
    "theo",
    "ana",
  );
  for (const id of [maya, sam, theo, ana]) await friend(viewer, id);
  assert.deepEqual(await listed(viewer), []);

  // More friends outrank a newer recommendation.
  for (const id of [theo, ana, maya]) await recommend(id, "tv:3", "2026-01-01");
  await recommend(maya, "movie:1", "2026-01-02");
  await recommend(sam, "movie:1", "2026-01-04");
  await recommend(theo, "movie:2", "2026-01-06");
  // Equal counts and dates fall back to the title name, then its ID.
  await db.query(
    "UPDATE title SET name=CASE id WHEN 'movie:6' THEN 'Alpha' ELSE 'alpha' END WHERE id IN ('movie:4','movie:5','movie:6')",
  );
  await recommend(ana, "movie:6", "2026-01-03");
  await recommend(sam, "movie:5", "2026-01-03");
  await recommend(theo, "movie:4", "2026-01-03");

  assert.deepEqual(await listed(viewer), [
    ["tv:3", ["ana", "maya", "theo"]],
    ["movie:1", ["sam", "maya"]],
    ["movie:2", ["theo"]],
    ["movie:4", ["theo"]],
    ["movie:5", ["sam"]],
    ["movie:6", ["ana"]],
  ]);
  const [show] = await recommendations(viewer);
  assert.deepEqual(
    { ...show, recommended_by: show.recommended_by.slice(0, 1) },
    {
      id: "tv:3",
      kind: "tv",
      tmdb_id: 3,
      name: "Show 3",
      overview: "",
      poster_path: null,
      release_date: "",
      recommended_by: [{ username: "ana", display_name: "ana" }],
      viewer_status: null,
      viewer_recommended: false,
      viewing: show.viewing,
    },
  );

  // Recommending again after withdrawing moves the title by its new date.
  await updateTitleActivity(theo, "movie:4", "recommended", false);
  await updateTitleActivity(theo, "movie:4", "recommended", true);
  assert.deepEqual((await listed(viewer)).slice(0, 4), [
    ["tv:3", ["ana", "maya", "theo"]],
    ["movie:1", ["sam", "maya"]],
    ["movie:4", ["theo"]],
    ["movie:2", ["theo"]],
  ]);
});

test("Friends recommend counts only current, unblocked direct friends", async () => {
  await titles(2);
  const [viewer, maya, pat, ozzy, fofi, uma, bob, bea, rex, rae] = await people(
    "viewer",
    "maya",
    "pat",
    "ozzy",
    "fofi",
    "uma",
    "bob",
    "bea",
    "rex",
    "rae",
  );
  for (const id of [maya, uma, bob, bea, rex, rae]) await friend(viewer, id);
  await friend(maya, fofi);
  await changeRelationship(pat, viewer, "request");
  await changeRelationship(viewer, uma, "remove");
  await changeRelationship(viewer, bob, "block");
  await changeRelationship(bea, viewer, "block");
  // A block hides a friend even while the accepted friendship remains.
  await db.query(
    "INSERT INTO block(blocker_id,blocked_id) VALUES($1,$2),($3,$1)",
    [viewer, rex, rae],
  );
  const excluded = [pat, ozzy, fofi, uma, bob, bea, rex, rae];
  await recommend(maya, "movie:1", "2026-01-01");
  for (const id of excluded) {
    await recommend(id, "movie:1");
    await recommend(id, "movie:2");
  }
  assert.deepEqual(await listed(viewer), [["movie:1", ["maya"]]]);
  const payload = JSON.stringify(await recommendations(viewer));
  for (const name of ["pat", "ozzy", "fofi", "uma", "bob", "bea", "rex", "rae"])
    assert.ok(!payload.includes(`"${name}"`), name);

  // Current relationships decide each read.
  await changeRelationship(viewer, pat, "accept");
  await db.query("DELETE FROM block WHERE blocker_id=$1 AND blocked_id=$2", [
    viewer,
    rex,
  ]);
  await changeRelationship(viewer, maya, "remove");
  assert.deepEqual(
    (await listed(viewer)).map(([id, names]) => [id, [...names].sort()]),
    // Each friend recommended movie:2 last.
    [
      ["movie:2", ["pat", "rex"]],
      ["movie:1", ["pat", "rex"]],
    ],
  );
});

test("Friends recommend lists only active Recommends, not other actions or the viewer's own", async () => {
  await titles(7);
  const [viewer, maya] = await people("viewer", "maya");
  await friend(viewer, maya);
  // A withdrawn Recommend keeps its discussion but no longer counts.
  const withdrawn = await recommend(maya, "movie:1");
  await addComment(viewer, withdrawn, "Still worth it?", false);
  await updateTitleActivity(maya, "movie:1", "recommended", false);
  // Switching to Want to watch withdraws the Recommend.
  await recommend(maya, "movie:2");
  await updateTitleActivity(maya, "movie:2", "want_to_watch", true);
  await updateTitleActivity(maya, "movie:3", "want_to_watch", true);
  await updateWatchStatus(maya, "tv:4", "watching");
  await updateWatchStatus(maya, "movie:5", "finished");
  await createTitleComment(maya, "movie:6", "Loved it", false);
  await recommend(viewer, "movie:7");
  assert.deepEqual(await listed(viewer), []);

  // Recommend goes with any status except Want to watch.
  await recommend(maya, "tv:4");
  await recommend(maya, "movie:1");
  assert.deepEqual(
    (await listed(viewer)).map(([id]) => id),
    ["movie:1", "tv:4"],
  );
});

test("each title carries the viewer's own status and Recommend, and none hides it", async () => {
  await titles(4);
  const [viewer, maya] = await people("viewer", "maya");
  await friend(viewer, maya);
  for (const [title, at] of [
    ["movie:1", "2026-01-04"],
    ["movie:2", "2026-01-03"],
    ["tv:3", "2026-01-02"],
    ["movie:4", "2026-01-01"],
  ])
    await recommend(maya, title, at);
  await updateTitleActivity(viewer, "movie:1", "want_to_watch", true);
  await updateWatchStatus(viewer, "movie:2", "finished");
  await recommend(viewer, "tv:3");
  await recommend(viewer, "movie:4");
  await updateWatchStatus(viewer, "movie:4", "watching");

  assert.deepEqual(
    (await recommendations(viewer)).map((title) => [
      title.id,
      title.recommended_by.map((friend) => friend.username),
      title.viewer_status,
      title.viewer_recommended,
    ]),
    [
      ["movie:1", ["maya"], "want_to_watch", false],
      ["movie:2", ["maya"], "finished", false],
      ["tv:3", ["maya"], null, true],
      ["movie:4", ["maya"], "watching", true],
    ],
  );
});

test("Friends recommend data names friends without entry or account IDs", async () => {
  await titles(1);
  const [viewer, maya] = await people("viewer", "maya");
  await friend(viewer, maya);
  const item = await recommend(maya, "movie:1");
  const payload = JSON.stringify(await recommendations(viewer));
  assert.ok(payload.includes('"maya"'));
  for (const id of [item, maya, viewer]) assert.ok(!payload.includes(id), id);
});

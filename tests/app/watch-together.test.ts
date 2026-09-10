import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship, updateTitleActivity, addComment } =
  await import("../../src/server/social");

useDatabase();

test("watch together lists every current shared choice, newest shared first", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('tv:1','tv',1,'Shared Show'),
    ('movie:2','movie',2,'Only Alice'),
    ('movie:3','movie',3,'Only Ben'),
    ('movie:4','movie',4,'Recommended Only'),
    ('movie:5','movie',5,'Removed Choice') ON CONFLICT DO NOTHING`);
  for (const user of [alice, ben]) {
    for (const title of ["movie:1", "tv:1", "movie:5"])
      await updateTitleActivity(user, title, "want_to_watch", true);
    await updateTitleActivity(user, "movie:4", "recommended", true);
  }
  await updateTitleActivity(alice, "movie:2", "want_to_watch", true);
  await updateTitleActivity(cam, "movie:2", "want_to_watch", true);
  await updateTitleActivity(ben, "movie:3", "want_to_watch", true);
  const removed = await updateTitleActivity(
    ben,
    "movie:5",
    "want_to_watch",
    true,
  );
  await addComment(alice, removed, "Keep this conversation visible.", false);
  await updateTitleActivity(ben, "movie:5", "want_to_watch", false);
  await db.query(
    `UPDATE feed_item SET activity_at=CASE
    WHEN title_id='movie:1' AND owner_id=$1 THEN '2026-01-04'::timestamptz
    WHEN title_id='tv:1' THEN '2026-01-03'::timestamptz
    ELSE '2026-01-01'::timestamptz END`,
    [ben],
  );
  // Replies must not reorder the shared choices.
  const show = await updateTitleActivity(ben, "tv:1", "want_to_watch", true);
  await addComment(alice, show, "New conversation on an older match.", false);
  const screen = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(screen.kind, "watch-together");
  if (screen.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    screen.participants.map((p) => p.username),
    ["alice", "ben"],
  );
  assert.deepEqual(
    screen.titles.map((t) => t.id),
    ["movie:1", "tv:1"],
  );
  const reverse = await loadScreen(ben, "/watch-together?with=alice");
  assert.equal(reverse.kind, "watch-together");
  if (reverse.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(reverse.titles, screen.titles);
  await updateTitleActivity(ben, "tv:1", "recommended", true);
  const afterRecommendation = await loadScreen(
    alice,
    "/watch-together?with=ben",
  );
  assert.equal(afterRecommendation.kind, "watch-together");
  if (afterRecommendation.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    afterRecommendation.titles.map((title) => title.id),
    ["movie:1"],
  );
  await updateTitleActivity(ben, "tv:1", "want_to_watch", true);

  await updateTitleActivity(alice, "tv:1", "want_to_watch", false);
  const afterRemoval = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(afterRemoval.kind, "watch-together");
  if (afterRemoval.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    afterRemoval.titles.map((t) => t.id),
    ["movie:1"],
  );
  await updateTitleActivity(alice, "tv:1", "want_to_watch", true);
  const afterReturn = await loadScreen(alice, "/watch-together?with=ben");
  assert.equal(afterReturn.kind, "watch-together");
  if (afterReturn.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    afterReturn.titles.map((t) => t.id),
    ["tv:1", "movie:1"],
  );
});

test("watch together requires one current accepted friend and revokes access after unfriend or block", async () => {
  const { alice, ben, cam } = await setup();
  const path = "/watch-together?with=ben";
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await changeRelationship(alice, ben, "request");
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await changeRelationship(ben, alice, "accept");
  const empty = await loadScreen(alice, path);
  assert.equal(empty.kind, "watch-together");
  if (empty.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(empty.titles, []);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  for (const invalid of [
    "/watch-together",
    "/watch-together?with=",
    "/watch-together?with=alice",
    "/watch-together?with=missing",
    "/watch-together?with=ben&with=cam",
    "/watch-together?with=ben&with=ben",
  ])
    await assert.rejects(loadScreen(alice, invalid));
  await friend(alice, cam);
  await assert.rejects(loadScreen(cam, path), /not found/i);
  await changeRelationship(ben, alice, "remove");
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await friend(alice, ben);
  const restored = await loadScreen(alice, path);
  assert.equal(restored.kind, "watch-together");
  if (restored.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.deepEqual(
    restored.titles.map((t) => t.id),
    ["movie:1"],
  );
  await changeRelationship(ben, alice, "block");
  await assert.rejects(loadScreen(alice, path), /not found/i);
  await assert.rejects(
    loadScreen(ben, "/watch-together?with=alice"),
    /not found/i,
  );
});

test("watch together returns all shared titles without a feed-sized cutoff", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name)
    SELECT 'movie:' || n, 'movie', n, 'Shared ' || n FROM generate_series(100,159) n
    ON CONFLICT DO NOTHING`);
  for (let n = 100; n < 160; n++)
    for (const user of [alice, ben])
      await updateTitleActivity(user, `movie:${n}`, "want_to_watch", true);
  const screen = await loadScreen(alice, "/watch-together?with=BEN");
  assert.equal(screen.kind, "watch-together");
  if (screen.kind !== "watch-together")
    throw new Error("Expected watch together");
  assert.equal(screen.titles.length, 60);
  assert.equal(new Set(screen.titles.map((t) => t.id)).size, 60);
});

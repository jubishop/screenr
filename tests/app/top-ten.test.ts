import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  cookieFor,
  denied,
  friend,
  person,
} from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { conversations } = await import("../../src/server/feed");
const { updateTitleActivity, updateWatchStatus, updateTopTen } =
  await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");
const { POST } = await import("../../src/app/api/screenr/[action]/route");

// Profile top 10: docs/profile-top-ten.md
useDatabase();

// Twelve stored titles, movie:101 through movie:112, named "Pick 1" onward.
// Titles outlast each test, so these replace any stored details.
async function titles() {
  for (let index = 1; index <= 12; index++)
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name,poster_path) VALUES($1,'movie',$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,poster_path=excluded.poster_path`,
      [
        `movie:${100 + index}`,
        100 + index,
        `Pick ${index}`,
        `/pick${index}.jpg`,
      ],
    );
}
const pick = (index: number) => `movie:${100 + index}`;
// The owner's list as title IDs in rank order, checking ranks have no gaps.
async function list(owner: string) {
  const { rows } = await db.query(
    "SELECT title_id,rank FROM top_ten WHERE owner_id=$1 ORDER BY rank",
    [owner],
  );
  assert.deepEqual(
    rows.map((row) => row.rank),
    rows.map((_, index) => index + 1),
  );
  return rows.map((row) => row.title_id as string);
}
// The owner's active Recommend and Want to watch actions for a title.
async function actions(owner: string, title: string) {
  return (
    await db.query(
      `SELECT item_type FROM feed_item WHERE owner_id=$1 AND title_id=$2 AND active
      ORDER BY item_type`,
      [owner, title],
    )
  ).rows.map((row) => row.item_type);
}
// Every feed entry, notification, and activity date, to show that list
// changes add or move none of them.
async function activity() {
  return {
    entries: (
      await db.query("SELECT id,active,activity_at FROM feed_item ORDER BY id")
    ).rows,
    notifications: (
      await db.query("SELECT count(*)::int AS count FROM notification")
    ).rows[0].count,
  };
}
async function fill(owner: string, count: number) {
  for (let index = 1; index <= count; index++)
    await updateTopTen(owner, pick(index), "add");
}

test("adding recommends the title, clears Want to watch, and takes the next rank", async () => {
  await titles();
  const alice = await person("alice");
  await updateTitleActivity(alice, pick(1), "want_to_watch", true);
  await updateWatchStatus(alice, pick(2), "watching");
  const before = await activity();

  await updateTopTen(alice, pick(1), "add");
  assert.deepEqual(await actions(alice, pick(1)), ["recommended"]);
  assert.deepEqual(await list(alice), [pick(1)]);
  // Adding uses the existing Recommend path: one new Recommend entry.
  const after = await activity();
  assert.equal(after.entries.length, before.entries.length + 1);
  assert.equal(after.notifications, before.notifications);

  // Recommend goes with a progress status, which stays current.
  await updateTopTen(alice, pick(2), "add");
  assert.deepEqual(await actions(alice, pick(2)), ["recommended"]);
  assert.equal(
    (
      await db.query(
        "SELECT status FROM watch_progress WHERE owner_id=$1 AND title_id=$2 AND active",
        [alice, pick(2)],
      )
    ).rows[0].status,
    "watching",
  );

  // A title already recommended keeps its entry and activity date, and a
  // title already listed keeps its rank.
  await updateTitleActivity(alice, pick(3), "recommended", true);
  const recommended = await activity();
  await updateTopTen(alice, pick(3), "add");
  await updateTopTen(alice, pick(1), "add");
  assert.deepEqual(await activity(), recommended);
  assert.deepEqual(await list(alice), [pick(1), pick(2), pick(3)]);

  await assert.rejects(updateTopTen(alice, "movie:999", "add"), {
    status: 404,
    message: "Title not found.",
  });
  assert.deepEqual(await list(alice), [pick(1), pick(2), pick(3)]);
});

test("a full list adds only by removing a chosen entry, which stays recommended", async () => {
  await titles();
  const alice = await person("alice");
  await fill(alice, 10);
  const full = await list(alice);
  await assert.rejects(updateTopTen(alice, pick(11), "add"), {
    message: "Your top 10 is full. Choose a title to remove.",
  });
  // The refused addition changes nothing, including Recommend.
  assert.deepEqual(await list(alice), full);
  assert.deepEqual(await actions(alice, pick(11)), []);
  await assert.rejects(
    updateTopTen(alice, pick(11), "add", { replace: pick(12) }),
    {
      message: "Choose a title from your top 10 to remove.",
    },
  );
  assert.deepEqual(await actions(alice, pick(11)), []);

  const before = await activity();
  await updateTopTen(alice, pick(11), "add", { replace: pick(3) });
  // Entries below #3 move up and the new title joins at #10.
  assert.deepEqual(await list(alice), [
    pick(1),
    pick(2),
    pick(4),
    pick(5),
    pick(6),
    pick(7),
    pick(8),
    pick(9),
    pick(10),
    pick(11),
  ]);
  assert.deepEqual(await actions(alice, pick(3)), ["recommended"]);
  assert.deepEqual(await actions(alice, pick(11)), ["recommended"]);
  const after = await activity();
  assert.equal(after.entries.length, before.entries.length + 1);
  assert.equal(after.notifications, before.notifications);
});

test("moving and removing keep ranks contiguous, keep Recommend, and add no activity", async () => {
  await titles();
  const alice = await person("alice");
  await fill(alice, 4);
  const before = await activity();

  await updateTopTen(alice, pick(3), "up");
  assert.deepEqual(await list(alice), [pick(1), pick(3), pick(2), pick(4)]);
  await updateTopTen(alice, pick(1), "down");
  assert.deepEqual(await list(alice), [pick(3), pick(1), pick(2), pick(4)]);
  // Moving past either end changes nothing.
  await updateTopTen(alice, pick(3), "up");
  await updateTopTen(alice, pick(4), "down");
  assert.deepEqual(await list(alice), [pick(3), pick(1), pick(2), pick(4)]);

  await updateTopTen(alice, pick(1), "remove");
  assert.deepEqual(await list(alice), [pick(3), pick(2), pick(4)]);
  assert.deepEqual(await actions(alice, pick(1)), ["recommended"]);
  // Removing a title that is not listed changes nothing.
  await updateTopTen(alice, pick(1), "remove");
  await assert.rejects(updateTopTen(alice, pick(1), "up"), {
    message: "That title is not in your top 10.",
  });
  assert.deepEqual(await list(alice), [pick(3), pick(2), pick(4)]);
  assert.deepEqual(await activity(), before);
});

test("moving to a rank shifts the entries between by one, keeps Recommend, and adds no activity", async () => {
  await titles();
  const alice = await person("alice");
  await fill(alice, 6);
  const before = await activity();
  const move = (index: number, rank: unknown) =>
    updateTopTen(alice, pick(index), "move", { rank });
  const order = (...indexes: number[]) => indexes.map((index) => pick(index));

  // Moving down moves the entries between up one, and moving up moves them
  // down one; neither swaps.
  await move(2, 5);
  assert.deepEqual(await list(alice), order(1, 3, 4, 5, 2, 6));
  await move(6, 2);
  assert.deepEqual(await list(alice), order(1, 6, 3, 4, 5, 2));
  // To either end.
  await move(1, 6);
  assert.deepEqual(await list(alice), order(6, 3, 4, 5, 2, 1));
  await move(2, 1);
  assert.deepEqual(await list(alice), order(2, 6, 3, 4, 5, 1));
  // The same rank changes nothing.
  await move(3, 3);
  assert.deepEqual(await list(alice), order(2, 6, 3, 4, 5, 1));

  // A rank outside the list, a title not in it, or a rank that is not a
  // whole number changes nothing.
  for (const rank of [0, -1, 7, 10, 11])
    await assert.rejects(move(4, rank), {
      message: "Choose a rank in your top 10.",
    });
  await assert.rejects(move(7, 1), {
    message: "That title is not in your top 10.",
  });
  for (const rank of [undefined, null, 1.5, "2"])
    await assert.rejects(move(4, rank), {
      message: "Invalid top 10 change.",
    });
  assert.deepEqual(await list(alice), order(2, 6, 3, 4, 5, 1));
  for (let index = 1; index <= 6; index++)
    assert.deepEqual(await actions(alice, pick(index)), ["recommended"]);
  assert.deepEqual(await activity(), before);
});

test("withdrawing Recommend or switching to Want to watch removes the entry for good", async () => {
  await titles();
  const alice = await person("alice");
  await fill(alice, 5);
  const before = await activity();

  await updateTitleActivity(alice, pick(2), "recommended", false);
  assert.deepEqual(await list(alice), [pick(1), pick(3), pick(4), pick(5)]);
  await updateTitleActivity(alice, pick(3), "want_to_watch", true);
  assert.deepEqual(await list(alice), [pick(1), pick(4), pick(5)]);
  await updateWatchStatus(alice, pick(4), "want_to_watch");
  assert.deepEqual(await list(alice), [pick(1), pick(5)]);
  // Progress statuses go with Recommend, so the entry stays.
  for (const status of ["watching", "finished", "stopped", null])
    await updateWatchStatus(alice, pick(5), status);
  assert.deepEqual(await list(alice), [pick(1), pick(5)]);
  // Recommending again does not restore the place.
  await updateTitleActivity(alice, pick(2), "recommended", true);
  assert.deepEqual(await list(alice), [pick(1), pick(5)]);
  // Only the Recommend changes add activity.
  assert.equal((await activity()).notifications, before.notifications);
});

// Migration 026 dropped the database guard, so Recommend writes keep the
// list valid themselves.
test("Recommend withdrawals and switches keep the list contiguous without a database trigger", async () => {
  await titles();
  const alice = await person("alice");
  assert.deepEqual(
    (
      await db.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid='feed_item'::regclass AND NOT tgisinternal",
      )
    ).rows,
    [],
  );
  await fill(alice, 5);
  // The first, a middle, and the last entry, each through another path.
  await updateWatchStatus(alice, pick(1), "want_to_watch");
  assert.deepEqual(await list(alice), [pick(2), pick(3), pick(4), pick(5)]);
  await updateTitleActivity(alice, pick(3), "recommended", false);
  assert.deepEqual(await list(alice), [pick(2), pick(4), pick(5)]);
  await updateTitleActivity(alice, pick(5), "want_to_watch", true);
  assert.deepEqual(await list(alice), [pick(2), pick(4)]);
  // Adding after a removal takes the next rank.
  await updateTopTen(alice, pick(6), "add");
  assert.deepEqual(await list(alice), [pick(2), pick(4), pick(6)]);
});

test("migration 025 stores one entry per title and per rank, ranks 1 through 10", async () => {
  await titles();
  const alice = await person("alice");
  await fill(alice, 3);
  const insert = (title: string, rank: number) =>
    db.query("INSERT INTO top_ten(owner_id,title_id,rank) VALUES($1,$2,$3)", [
      alice,
      title,
      rank,
    ]);
  await assert.rejects(insert(pick(1), 4), { code: "23505" });
  await assert.rejects(insert(pick(4), 3), { code: "23505" });
  for (const rank of [0, 11])
    await assert.rejects(insert(pick(4), rank), { code: "23514" });
  await assert.rejects(insert("movie:999", 4), { code: "23503" });
  assert.deepEqual(await list(alice), [pick(1), pick(2), pick(3)]);
});

test("any signed-in, unblocked member sees a profile's top 10 without its Recommend entries", async () => {
  await titles();
  const [alice, ben, cam, dee] = [
    await person("alice"),
    await person("ben"),
    await person("cam"),
    await person("dee"),
  ];
  await friend(alice, ben);
  await fill(alice, 2);
  const entries = (
    await db.query(
      "SELECT id::text FROM feed_item WHERE owner_id=$1 AND item_type='recommended'",
      [alice],
    )
  ).rows.map((row) => row.id as string);
  await addComment(ben, entries[0], "Friends-only discussion", false);
  const expected = [
    { id: pick(1), name: "Pick 1", poster_path: "/pick1.jpg", rank: 1 },
    { id: pick(2), name: "Pick 2", poster_path: "/pick2.jpg", rank: 2 },
  ];
  const profile = async (viewer: string) => {
    const screen = await loadScreen(viewer, "/people/alice");
    assert.ok(screen.kind === "profile");
    return screen;
  };

  for (const viewer of [alice, ben, cam]) {
    const screen = await profile(viewer);
    assert.deepEqual(screen.topTen, expected);
  }
  // A non-friend gets the list but no entry IDs, discussions, or activity.
  const nonFriend = await profile(cam);
  assert.deepEqual(nonFriend.conversations, []);
  const data = JSON.stringify(nonFriend);
  for (const hidden of [...entries, "Friends-only discussion"])
    assert.ok(!data.includes(hidden), hidden);
  // The friend's activity is unchanged.
  assert.ok((await profile(ben)).conversations.length >= 2);
  // Another member with no entries shows an empty list.
  const empty = await loadScreen(alice, "/people/dee");
  assert.ok(empty.kind === "profile");
  assert.deepEqual(empty.topTen, []);

  // Blocking in either direction hides the profile and its list. Neither
  // blocking nor unfriending changes the list.
  await changeRelationship(alice, dee, "block");
  await assert.rejects(loadScreen(dee, "/people/alice"), denied.person);
  await changeRelationship(cam, alice, "block");
  await assert.rejects(loadScreen(cam, "/people/alice"), denied.person);
  await changeRelationship(ben, alice, "remove");
  await changeRelationship(alice, dee, "unblock");
  assert.deepEqual((await profile(dee)).topTen, expected);
  assert.deepEqual((await profile(ben)).topTen, expected);
  assert.deepEqual(await list(alice), [pick(1), pick(2)]);
});

test("title pages and feed entries carry the reader's own top 10", async () => {
  await titles();
  const [alice, ben] = [await person("alice"), await person("ben")];
  await friend(alice, ben);
  await fill(alice, 3);
  await updateTitleActivity(ben, pick(2), "recommended", true);
  await updateTitleActivity(ben, pick(5), "recommended", true);

  const page = await loadScreen(alice, `/titles/movie/${100 + 2}`);
  assert.ok(page.kind === "title");
  assert.deepEqual(
    page.topTen.map((entry) => [entry.id, entry.rank]),
    [
      [pick(1), 1],
      [pick(2), 2],
      [pick(3), 3],
    ],
  );
  // Each entry carries the reader's rank for its title, for the confirmation
  // before withdrawing; titles outside the list carry none.
  const ranks = Object.fromEntries(
    (await conversations(alice, { owner: ben })).map((item) => [
      item.title_id,
      item.viewer_top_ten_rank,
    ]),
  );
  assert.deepEqual(ranks, { [pick(2)]: 2, [pick(5)]: null });
  // Ben's own list is empty, so Alice's entries carry no rank for him.
  for (const item of await conversations(ben, { owner: alice }))
    assert.equal(item.viewer_top_ten_rank, null);
});

test("top 10 changes validate their input through the action route", async () => {
  await titles();
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  const post = (data: unknown) =>
    POST(
      new Request("http://localhost:3000/api/screenr/top-ten", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify(data),
      }),
      { params: Promise.resolve({ action: "top-ten" }) },
    );
  for (const change of ["Add", "move", 3, null, undefined]) {
    const response = await post({ title: pick(1), change });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.deepEqual(await response.json(), {
      error: "Invalid top 10 change.",
    });
  }
  assert.deepEqual(await list(alice), []);
  for (const index of [1, 2]) {
    const added = await post({ title: pick(index), change: "add" });
    assert.equal(added.status, 200);
    assert.deepEqual(await added.json(), { ok: true });
  }
  assert.equal((await post({ title: pick(2), change: "up" })).status, 200);
  assert.deepEqual(await list(alice), [pick(2), pick(1)]);
  // Moving to a rank needs a whole-number rank.
  for (const rank of ["1", 1.5, undefined]) {
    const response = await post({ title: pick(1), change: "move", rank });
    assert.equal(response.status, 400, JSON.stringify(rank));
  }
  assert.equal(
    (await post({ title: pick(1), change: "move", rank: 1 })).status,
    200,
  );
  assert.deepEqual(await list(alice), [pick(1), pick(2)]);
  assert.equal((await post({ title: pick(2), change: "remove" })).status, 200);
  assert.deepEqual(await list(alice), [pick(1)]);
  assert.deepEqual(await actions(alice, pick(2)), ["recommended"]);
  await fill(alice, 10);
  const replaced = await post({
    title: pick(11),
    change: "add",
    replace: pick(1),
  });
  assert.equal(replaced.status, 200);
  assert.equal((await list(alice)).at(-1), pick(11));
});

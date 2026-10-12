import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useDatabase, db, cookieFor, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { thread, conversations } = await import("../../src/server/feed");
const { updateTitleActivity, updateWatchStatus, setFinishedDate, watchStatus } =
  await import("../../src/server/title-actions");
const { addComment, removeComment } = await import("../../src/server/comments");
const { setReaction } = await import("../../src/server/reactions");
const { POST } = await import("../../src/app/api/screenr/[action]/route");

useDatabase();

async function show() {
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('tv:8','tv',8,'Test Show') ON CONFLICT DO NOTHING",
  );
}
const pacificToday = async () =>
  (
    await db.query(
      "SELECT ((now() AT TIME ZONE 'America/Los_Angeles')::date)::text AS today",
    )
  ).rows[0].today as string;
const time = (value: string) => new Date(value).getTime();
// Sets a status that has an entry and returns the entry's ID.
async function setEntry(...args: Parameters<typeof updateWatchStatus>) {
  const id = await updateWatchStatus(...args);
  assert.ok(id);
  return id;
}
const own = async (viewer: string, title = "movie:1") =>
  (await conversations(viewer, { title, owner: viewer })).map((entry) => [
    entry.item_type,
    entry.active,
  ]);

test("members set and clear each status, with Caught up only for TV shows", async () => {
  const { alice } = await setup();
  await show();
  for (const [title, statuses] of [
    ["movie:1", ["want_to_watch", "watching", "finished", "stopped"]],
    ["tv:8", ["want_to_watch", "watching", "caught_up", "finished", "stopped"]],
  ] as const) {
    assert.deepEqual(await watchStatus(alice, title), {
      status: null,
      finished_on: null,
    });
    for (const status of statuses) {
      await updateWatchStatus(alice, title, status);
      assert.equal((await watchStatus(alice, title)).status, status);
    }
    await updateWatchStatus(alice, title, null);
    assert.equal((await watchStatus(alice, title)).status, null);
  }
  await updateWatchStatus(alice, "movie:1", "watching");
  await assert.rejects(updateWatchStatus(alice, "movie:1", "caught_up"), {
    message: "Caught up is only for TV shows.",
  });
  assert.equal((await watchStatus(alice, "movie:1")).status, "watching");

  // Finished records the date the member gives, or today in Pacific time.
  await updateWatchStatus(alice, "tv:8", "finished", "2026-10-01");
  assert.deepEqual(await watchStatus(alice, "tv:8"), {
    status: "finished",
    finished_on: "2026-10-01",
  });
  await updateWatchStatus(alice, "movie:1", "finished");
  assert.deepEqual(await watchStatus(alice, "movie:1"), {
    status: "finished",
    finished_on: await pacificToday(),
  });
  const screen = await loadScreen(alice, "/titles/tv/8");
  assert.equal(screen.kind, "title");
  if (screen.kind !== "title") throw new Error("Expected a title screen");
  assert.deepEqual(screen.watch, {
    status: "finished",
    finished_on: "2026-10-01",
  });
});

test("status actions validate their input through the action route", async () => {
  const { alice } = await setup();
  await show();
  const cookie = await cookieFor(alice);
  const post = (action: string, data: unknown) =>
    POST(
      new Request(`http://localhost:3000/api/screenr/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
          Cookie: cookie,
        },
        body: JSON.stringify(data),
      }),
      { params: Promise.resolve({ action }) },
    );
  const rejects = async (action: string, data: unknown, error: string) => {
    const response = await post(action, data);
    assert.equal(response.status, 400, JSON.stringify(data));
    assert.deepEqual(await response.json(), { error });
  };
  await rejects(
    "finished-date",
    { title: "movie:1", date: "2026-10-01" },
    "Choose a watch status before adding a finished date.",
  );
  for (const status of ["Watching", "recommended", 3, true, undefined])
    await rejects(
      "watch-status",
      { title: "movie:1", status },
      "Invalid watch status.",
    );
  await rejects(
    "watch-status",
    { title: "movie:1", status: "caught_up" },
    "Caught up is only for TV shows.",
  );
  await rejects(
    "watch-status",
    { title: "movie:1", status: "want_to_watch", surface: "elsewhere" },
    "Invalid watch status.",
  );
  await rejects(
    "watch-status",
    { title: "movie:1", status: "watching", finishedOn: "2026-10-01" },
    "Only Finished takes a finished date.",
  );
  const future = new Date(Date.now() + 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const finishedOn of [
    "2026-02-30",
    "2026-1-01",
    "10/01/2026",
    "1899-12-31",
    future,
    5,
  ])
    await rejects(
      "watch-status",
      { title: "movie:1", status: "finished", finishedOn },
      "Enter a finished date from 1900 through today.",
    );
  assert.equal((await watchStatus(alice, "movie:1")).status, null);

  const saved = await post("watch-status", {
    title: "tv:8",
    status: "finished",
    finishedOn: "2026-10-01",
  });
  assert.equal(saved.status, 200);
  const { id } = await saved.json();
  assert.equal((await thread(alice, id)).conversation.item_type, "progress");
  for (const date of ["2026-02-29", "2026-13-01", "1899-12-31", future, ""])
    await rejects(
      "finished-date",
      { title: "tv:8", date },
      "Enter a finished date from 1900 through today.",
    );
  assert.equal(
    (await post("finished-date", { title: "tv:8", date: "2024-02-29" })).status,
    200,
  );
  assert.equal((await watchStatus(alice, "tv:8")).finished_on, "2024-02-29");
  assert.equal(
    (await post("finished-date", { title: "tv:8", date: null })).status,
    200,
  );
  assert.equal((await watchStatus(alice, "tv:8")).finished_on, null);
  assert.equal(
    (await post("watch-status", { title: "tv:8", status: null })).status,
    200,
  );
  assert.equal((await watchStatus(alice, "tv:8")).status, null);
});

test("progress statuses replace Want to watch and coexist with Recommend", async () => {
  const { alice, ben } = await setup(); // alice recommends movie:1
  await friend(alice, ben);
  await updateWatchStatus(alice, "movie:1", "watching");
  assert.deepEqual(await own(alice), [
    ["progress", true],
    ["recommended", true],
  ]);
  await updateTitleActivity(alice, "movie:1", "recommended", false);
  await updateTitleActivity(alice, "movie:1", "recommended", true);
  assert.equal((await watchStatus(alice, "movie:1")).status, "watching");

  // Choosing Want to watch replaces the status and still removes Recommend.
  const want = await updateWatchStatus(alice, "movie:1", "want_to_watch");
  assert.equal((await watchStatus(alice, "movie:1")).status, "want_to_watch");
  assert.deepEqual(
    (await own(alice)).filter(([, active]) => active),
    [["want_to_watch", true]],
  );
  // Recommend removes Want to watch, leaving no status.
  await updateTitleActivity(alice, "movie:1", "recommended", true);
  assert.equal((await watchStatus(alice, "movie:1")).status, null);

  // The one-tap Want to watch action also replaces a progress status and
  // keeps the last-finished date; turning it off leaves a status alone.
  await updateWatchStatus(alice, "movie:1", "finished", "2026-10-01");
  assert.equal(
    await updateTitleActivity(alice, "movie:1", "want_to_watch", true),
    want,
  );
  assert.deepEqual(await watchStatus(alice, "movie:1"), {
    status: "want_to_watch",
    finished_on: "2026-10-01",
  });
  await updateWatchStatus(alice, "movie:1", null);
  assert.deepEqual(
    (await own(alice)).filter(([, active]) => active),
    [],
  );
  await updateWatchStatus(alice, "movie:1", "stopped");
  await updateTitleActivity(alice, "movie:1", "want_to_watch", false);
  assert.equal((await watchStatus(alice, "movie:1")).status, "stopped");
  // Each reader's controls show their own status, never the owner's.
  await updateWatchStatus(ben, "movie:1", "finished");
  for (const [viewer, status] of [
    [alice, "stopped"],
    [ben, "finished"],
  ] as const)
    for (const entry of await conversations(viewer, { title: "movie:1" })) {
      assert.equal(entry.viewer_status, status);
      assert.equal(entry.viewer_want_to_watch, false);
    }
});

// A later migration drops the previous release's guard trigger, so status
// writes must keep one current status themselves.
test("Want to watch replaces a progress status without the database trigger", async () => {
  const { alice } = await setup();
  await db.query(
    "ALTER TABLE feed_item DISABLE TRIGGER feed_item_withdraw_progress",
  );
  try {
    for (const save of [
      () => updateTitleActivity(alice, "movie:1", "want_to_watch", true),
      () => updateWatchStatus(alice, "movie:1", "want_to_watch"),
    ]) {
      await updateWatchStatus(alice, "movie:1", "watching");
      await save();
      assert.deepEqual(
        (
          await db.query(
            `SELECT 'progress' AS entry FROM watch_progress WHERE owner_id=$1 AND active
            UNION ALL SELECT item_type FROM feed_item WHERE owner_id=$1 AND active`,
            [alice],
          )
        ).rows,
        [{ entry: "want_to_watch" }],
      );
    }
  } finally {
    await db.query(
      "ALTER TABLE feed_item ENABLE TRIGGER feed_item_withdraw_progress",
    );
  }
});

test("one progress entry updates in place, keeps its discussion, and follows the removal rule", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const wanted = await setEntry(alice, "movie:1", "want_to_watch");
  const wantReply = await addComment(ben, wanted, "Saved it too", false);
  const wantedBefore = await thread(ben, wanted);
  const progress = await setEntry(alice, "movie:1", "watching");
  assert.notEqual(progress, wanted);
  // Want to watch is switched off under its lifecycle: kept with its replies.
  const withdrawn = await thread(ben, wanted);
  assert.equal(withdrawn.conversation.active, false);
  assert.deepEqual(
    withdrawn.conversation.activity_at,
    wantedBefore.conversation.activity_at,
  );
  assert.equal(withdrawn.comments[0].id, wantReply);

  let entry = (await thread(ben, progress)).conversation;
  assert.equal(entry.item_type, "progress");
  assert.equal(entry.status, "watching");
  assert.equal(entry.finished_on, null);
  assert.equal(entry.active, true);
  const reply = await addComment(ben, progress, "No spoilers!", false);
  await setReaction(ben, progress, null, "love");
  const discussion = await thread(ben, progress);

  // Each change updates the same entry and moves it up.
  for (const status of ["finished", "stopped", "watching"] as const) {
    const before = (await thread(ben, progress)).conversation.activity_at;
    assert.equal(await updateWatchStatus(alice, "movie:1", status), progress);
    const after = await thread(ben, progress);
    assert.equal(after.conversation.status, status);
    assert.ok(time(after.conversation.activity_at) > time(before));
    assert.deepEqual(after.comments, discussion.comments);
    assert.deepEqual(
      after.conversation.reactions,
      discussion.conversation.reactions,
    );
  }
  assert.equal(
    (await conversations(ben, { owner: alice })).filter(
      (item) => item.item_type === "progress",
    ).length,
    1,
  );
  // Choosing the current status again changes nothing.
  entry = (await thread(ben, progress)).conversation;
  await updateWatchStatus(alice, "movie:1", "watching");
  assert.deepEqual(
    (await thread(ben, progress)).conversation.activity_at,
    entry.activity_at,
  );

  // A rewatch keeps the last-finished date; finishing again replaces it.
  await updateWatchStatus(alice, "movie:1", "finished", "2026-09-30");
  await updateWatchStatus(alice, "movie:1", "finished", "2026-10-05");
  assert.equal(
    (await thread(ben, progress)).conversation.finished_on,
    "2026-09-30",
  );
  await updateWatchStatus(alice, "movie:1", "watching");
  assert.equal(
    (await thread(ben, progress)).conversation.finished_on,
    "2026-09-30",
  );
  await updateWatchStatus(alice, "movie:1", "finished", "2026-10-05");
  entry = (await thread(ben, progress)).conversation;
  assert.equal(entry.finished_on, "2026-10-05");
  // Changing or clearing the date does not move the entry.
  await setFinishedDate(alice, "movie:1", "2026-10-03");
  assert.equal(
    (await thread(ben, progress)).conversation.finished_on,
    "2026-10-03",
  );
  await setFinishedDate(alice, "movie:1", null);
  const undated = (await thread(ben, progress)).conversation;
  assert.equal(undated.finished_on, null);
  assert.deepEqual(undated.activity_at, entry.activity_at);

  // Clearing keeps an entry with visible replies, marked inactive, in place.
  await updateWatchStatus(alice, "movie:1", null);
  const cleared = await thread(ben, progress);
  assert.equal(cleared.conversation.active, false);
  assert.deepEqual(cleared.conversation.activity_at, entry.activity_at);
  assert.deepEqual(cleared.comments, discussion.comments);
  // Without visible replies it is hidden, but kept for reuse.
  await removeComment(ben, reply);
  await assert.rejects(thread(ben, progress), /not found/);
  for (const viewer of [alice, ben])
    assert.ok(
      !(await conversations(viewer)).some((item) => item.id === progress),
    );
  assert.equal(await updateWatchStatus(alice, "movie:1", "stopped"), progress);
  const restored = await thread(ben, progress);
  assert.equal(restored.conversation.active, true);
  assert.ok(time(restored.conversation.activity_at) > time(entry.activity_at));
  assert.deepEqual(
    restored.conversation.reactions,
    discussion.conversation.reactions,
  );

  // Moving back to Want to watch removes the progress entry without moving
  // it, and reactivates the original Want to watch entry with its replies.
  await addComment(ben, progress, "Still here", false);
  const stopped = (await thread(alice, progress)).conversation.activity_at;
  assert.deepEqual(stopped, restored.conversation.activity_at);
  assert.equal(
    await updateWatchStatus(alice, "movie:1", "want_to_watch"),
    wanted,
  );
  const removed = (await thread(alice, progress)).conversation;
  assert.equal(removed.active, false);
  assert.deepEqual(removed.activity_at, stopped);
  const rewanted = await thread(ben, wanted);
  assert.equal(rewanted.conversation.active, true);
  assert.ok(
    time(rewanted.conversation.activity_at) >
      time(wantedBefore.conversation.activity_at),
  );
  assert.equal(rewanted.comments[0].id, wantReply);
  await assert.rejects(setFinishedDate(ben, "movie:1", "2026-10-01"), {
    message: "Choose a watch status before adding a finished date.",
  });
});

test("progress entries follow the audience and blocking rules in every feed and send no notifications", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, cam);
  await db.query("UPDATE profile SET activity_email=true");
  const notifications = async () =>
    (await db.query("SELECT count(*)::int AS count FROM notification")).rows[0]
      .count as number;
  const before = await notifications();
  const progress = await setEntry(alice, "movie:1", "watching");
  await updateWatchStatus(alice, "movie:1", "finished");
  await updateWatchStatus(alice, "movie:1", null);
  await updateWatchStatus(alice, "movie:1", "stopped");
  assert.equal(await notifications(), before);
  const filters = [{}, { title: "movie:1" }, { owner: alice }];
  const sees = async (viewer: string) => {
    const found = await Promise.all(
      filters.map(async (filter) =>
        (await conversations(viewer, filter)).some(
          (item) => item.id === progress,
        ),
      ),
    );
    assert.ok(found.every((value) => value === found[0]));
    return found[0];
  };
  for (const viewer of [alice, ben, cam])
    assert.equal(await sees(viewer), true);
  assert.equal(await sees(outsider), false);
  await assert.rejects(thread(outsider, progress), /not found/);
  await assert.rejects(
    addComment(outsider, progress, "Not my circle", false),
    /not found/,
  );
  await assert.rejects(setReaction(outsider, progress, null, "like"), {
    message: "Conversation not found.",
  });

  // Comments on a progress entry notify its owner like other entries.
  await addComment(ben, progress, "How was it?", false);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS count FROM visible_notification WHERE recipient_id=$1 AND item_id=$2",
        [alice, progress],
      )
    ).rows[0].count,
    1,
  );
  await changeRelationship(cam, alice, "block");
  assert.equal(await sees(cam), false);
  await changeRelationship(ben, alice, "remove");
  assert.equal(await sees(ben), false);
  await friend(alice, ben);
  assert.equal(await sees(ben), true);
});

test("a progress entry's discussion counts toward the conversation measure", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const { usageReport } = await import("../../src/server/usage");
  const progress = await setEntry(alice, "movie:1", "watching");
  const [before] = await usageReport({ weeks: 1 });
  await addComment(ben, progress, `Thoughts ${randomUUID()}`, false);
  const [after] = await usageReport({ weeks: 1 });
  assert.equal(after.conversations, before.conversations + 1);
});

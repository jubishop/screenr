import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  useDatabase,
  db,
  friend,
  person,
  setup,
  cookieFor,
} from "./social-fixture";
const { POST, GET } = await import("../../src/app/api/screenr/[action]/route");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { pruneUsage, usageReport } = await import("../../src/server/usage");

useDatabase();

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const pacificToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
    new Date(),
  );

function post(action: string, cookie: string, data: unknown) {
  return POST(
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
}
function get(cookie: string, action: string, query = "") {
  return GET(
    new Request(`http://localhost:3000/api/screenr/${action}${query}`, {
      headers: { Cookie: cookie },
    }),
    { params: Promise.resolve({ action }) },
  );
}
async function activeDays() {
  return (
    await db.query(
      "SELECT to_jsonb(a) AS row FROM member_active_day a ORDER BY user_id,day",
    )
  ).rows.map((r) => r.row);
}
async function saves() {
  return (
    await db.query(
      "SELECT to_jsonb(s)-'id' AS row FROM want_to_watch_save s ORDER BY id",
    )
  ).rows.map((r) => r.row);
}
async function titles(...ids: number[]) {
  for (const id of ids)
    await db.query(
      `INSERT INTO title(id,kind,tmdb_id,name) VALUES($1,'movie',$2,$3) ON CONFLICT DO NOTHING`,
      [`movie:${id}`, id, `Telemetry Movie ${id}`],
    );
}

test("actions record one Pacific day per member with no page or time; background reads do not", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const cookie = await cookieFor(ben);
  for (const [action, query] of [
    ["screen", "?path=%2F"],
    ["screen", "?path=%2Ftitles%2Fmovie%2F1"],
    ["notifications", ""],
    ["notifications", "?unread=true"],
  ])
    assert.equal((await get(cookie, action, query)).status, 200);
  assert.deepEqual(await activeDays(), []);

  assert.equal(
    (await post("reaction", cookie, { item: conversation, kind: "like" }))
      .status,
    200,
  );
  assert.equal(
    (
      await post("activity", cookie, {
        title: "movie:1",
        field: "recommended",
        value: true,
      })
    ).status,
    200,
  );
  // A rejected action still shows the member was active.
  assert.equal(
    (await post("comment", cookie, { conversation, body: "", spoiler: false }))
      .status,
    400,
  );
  assert.deepEqual(await activeDays(), [{ user_id: ben, day: pacificToday() }]);

  // Submitting a title search is a member action.
  await db.query("DELETE FROM member_active_day");
  assert.equal((await get(cookie, "search", "?q=x")).status, 200);
  assert.deepEqual(await activeDays(), [{ user_id: ben, day: pacificToday() }]);

  // Requests without a member session record nothing.
  await db.query("DELETE FROM member_active_day");
  assert.equal(
    (await post("reaction", "", { item: conversation })).status,
    401,
  );
  assert.deepEqual(await activeDays(), []);
});

test("Want to watch saves record the surface and whether a direct friend recommends, never who", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await titles(2, 3);
  const dana = await person("dana");
  await friend(alice, ben);
  await friend(alice, dana);
  await changeRelationship(alice, cam, "request");
  const cookies = new Map<string, string>();
  const save = async (
    member: string,
    title: string,
    value: boolean,
    surface?: unknown,
  ) => {
    if (!cookies.has(member)) cookies.set(member, await cookieFor(member));
    return post("activity", cookies.get(member)!, {
      title,
      field: "want_to_watch",
      value,
      surface,
    });
  };
  const today = pacificToday();
  const row = (
    user_id: string,
    title_id: string,
    surface: string | null,
    friend_recommending: boolean,
  ) => ({ user_id, title_id, saved_on: today, surface, friend_recommending });

  assert.equal(
    (await save(ben, "movie:1", true, "friend_recommendation")).status,
    200,
  );
  // Repeating an active save or removing it records nothing.
  assert.equal(
    (await save(ben, "movie:1", true, "friend_recommendation")).status,
    200,
  );
  assert.equal((await save(ben, "movie:1", false, "title")).status, 200);
  assert.equal((await save(ben, "movie:1", true, "title")).status, 200);
  // A pending friend request is not a friendship, and old clients send no surface.
  assert.equal((await save(cam, "movie:1", true, "title")).status, 200);
  assert.equal((await save(outsider, "movie:1", true)).status, 200);
  // Only an active Recommend from someone else counts.
  await updateTitleActivity(alice, "movie:2", "want_to_watch", true);
  await updateTitleActivity(dana, "movie:3", "recommended", true);
  await updateTitleActivity(alice, "movie:3", "recommended", true);
  await updateTitleActivity(alice, "movie:3", "recommended", false);
  assert.equal((await save(dana, "movie:2", true, "friend_entry")).status, 200);
  assert.equal(
    (await save(dana, "movie:3", true, "suggestion_recommendation")).status,
    200,
  );
  assert.equal((await save(ben, "movie:2", true, "not-a-surface")).status, 400);
  assert.equal(
    (
      await post("activity", cookies.get(ben)!, {
        title: "movie:3",
        field: "recommended",
        value: true,
        surface: "title",
      })
    ).status,
    200,
  );

  // Each row holds exactly the saver, title, Pacific date, surface, and a
  // yes-or-no friend recommendation, never the recommending friend.
  assert.deepEqual(await saves(), [
    row(ben, "movie:1", "friend_recommendation", true),
    row(ben, "movie:1", "title", true),
    row(cam, "movie:1", "title", false),
    row(outsider, "movie:1", null, false),
    row(alice, "movie:2", null, false),
    row(dana, "movie:2", "friend_entry", false),
    row(dana, "movie:3", "suggestion_recommendation", false),
  ]);
  const feed = await db.query(
    "SELECT 1 FROM feed_item WHERE owner_id=$1 AND title_id='movie:2' AND active",
    [ben],
  );
  assert.equal(feed.rowCount, 0);
});

async function members(...names: string[]) {
  const ids: string[] = [];
  for (const name of names) ids.push(await person(name));
  return ids;
}

test("weekly returns use Monday-to-Sunday Pacific weeks and count the week before the range", async () => {
  const [alice, ben, cam, dana, erin] = await members(
    "alice",
    "ben",
    "cam",
    "dana",
    "erin",
  );
  for (const [user, day] of [
    [dana, "2026-10-18"],
    [dana, "2026-10-19"],
    [alice, "2026-10-25"],
    [alice, "2026-10-26"],
    [cam, "2026-10-26"],
    [cam, "2026-10-28"],
    [ben, "2026-11-01"],
    [ben, "2026-11-02"],
    [cam, "2026-11-08"],
    [erin, "2026-11-09"],
  ])
    await db.query("INSERT INTO member_active_day(user_id,day) VALUES($1,$2)", [
      user,
      day,
    ]);
  const weeks = await usageReport({ weeks: 3, through: "2026-11-08" });
  assert.deepEqual(
    weeks.map((w) => [
      w.week,
      w.inProgress,
      w.activeMembers,
      w.activePreviousWeek,
    ]),
    [
      ["2026-10-19", false, 2, 1],
      ["2026-10-26", false, 3, 1],
      ["2026-11-02", false, 2, 2],
    ],
  );
  // Any day selects its whole week; the current week is marked in progress.
  const [current] = await usageReport({ weeks: 1 });
  assert.equal(current.inProgress, true);
  const monday = (
    await db.query(
      "SELECT date_trunc('week',(now() AT TIME ZONE 'America/Los_Angeles')::date::timestamp)::date::text AS monday",
    )
  ).rows[0].monday;
  assert.equal(current.week, monday);
  assert.deepEqual(
    (await usageReport({ weeks: 1, through: "2026-10-28" })).map((w) => w.week),
    ["2026-10-26"],
  );
  await assert.rejects(usageReport({ weeks: 0 }));
  await assert.rejects(usageReport({ weeks: 1, through: "next week" }));
});

test("saves report observed and inferred lines once per member and title each week", async () => {
  const [ben, cam, dana, erin, frank] = await members(
    "ben",
    "cam",
    "dana",
    "erin",
    "frank",
  );
  await titles(1, 2);
  for (const [user, title, day, surface, recommending] of [
    [ben, "movie:1", "2026-10-26", "friend_recommendation", true],
    [ben, "movie:1", "2026-10-27", "friend_recommendation", true],
    [cam, "movie:1", "2026-11-01", "title", true],
    [dana, "movie:2", "2026-10-30", "suggestion_recommendation", false],
    [erin, "movie:2", "2026-10-31", "friend_entry", false],
    [frank, "movie:1", "2026-10-28", null, true],
    [ben, "movie:2", "2026-11-02", "friends_recommend", true],
    [cam, "movie:2", "2026-11-03", "watch_together", false],
    [dana, "movie:1", "2026-11-08", "suggestion", false],
    [erin, "movie:1", "2026-11-09", "friend_recommendation", true],
  ] as const)
    await db.query(
      `INSERT INTO want_to_watch_save(user_id,title_id,saved_on,surface,friend_recommending)
      VALUES($1,$2,$3,$4,$5)`,
      [user, title, day, surface, recommending],
    );
  const weeks = await usageReport({ weeks: 3, through: "2026-11-08" });
  assert.deepEqual(
    weeks.map((w) => [w.week, w.saves, w.observedSaves, w.inferredSaves]),
    [
      ["2026-10-19", 0, 0, 0],
      ["2026-10-26", 5, 2, 3],
      ["2026-11-02", 3, 1, 1],
    ],
  );
});

test("conversation measures count two-person, back-and-forth, and repeat activity at Pacific week boundaries", async () => {
  const [alice, ben, cam, dana] = await members("alice", "ben", "cam", "dana");
  await titles(1, 2);
  await friend(alice, ben);
  await friend(cam, ben);
  await friend(dana, ben);
  const recommendation = await updateTitleActivity(
    alice,
    "movie:1",
    "recommended",
    true,
  );
  const wanted = await updateTitleActivity(
    dana,
    "movie:1",
    "want_to_watch",
    true,
  );
  const standaloneId = await createTitleComment(
    cam,
    "movie:2",
    "Anyone seen this?",
    false,
  );
  await db.query(
    "UPDATE feed_item SET created_at='2026-10-20T12:00:00Z' WHERE id IN ($1,$2)",
    [recommendation, wanted],
  );
  await db.query(
    "UPDATE title_comment SET created_at='2026-10-20T12:00:00Z' WHERE id=$1",
    [standaloneId],
  );
  const comment = async (entry: string, author: string, at: string) =>
    (
      await db.query(
        `INSERT INTO comment(feed_item_id,title_comment_id,conversation_id,author_id,body,created_at)
        SELECT f.id,t.id,coalesce(f.conversation_id,t.conversation_id),$2,'Fixture comment',$3
        FROM (SELECT $1::uuid AS id) e
        LEFT JOIN feed_item f ON f.id=e.id LEFT JOIN title_comment t ON t.id=e.id
        RETURNING id::text`,
        [entry, author, at],
      )
    ).rows[0].id as string;
  // Daylight saving time ends on Sunday, November 1, 2026, so the week of
  // October 26 ends at 08:00 UTC rather than 07:00 UTC.
  await comment(recommendation, ben, "2026-11-02T07:59:59Z");
  await comment(recommendation, alice, "2026-11-02T08:00:00Z");
  await comment(standaloneId, cam, "2026-10-27T12:00:00Z");
  const removed = await comment(standaloneId, ben, "2026-11-03T12:00:00Z");
  await removeComment(ben, removed);
  await comment(wanted, ben, "2026-10-26T06:59:59Z");
  await comment(wanted, ben, "2026-10-26T07:00:00Z");
  await comment(wanted, dana, "2026-10-28T12:00:00Z");
  await comment(wanted, ben, "2026-10-29T12:00:00Z");

  const weeks = await usageReport({ weeks: 3, through: "2026-11-08" });
  assert.deepEqual(
    weeks.map((w) => [
      w.week,
      w.conversations,
      w.backAndForth,
      w.repeatCommenters,
    ]),
    [
      ["2026-10-19", 1, 0, 0],
      ["2026-10-26", 2, 1, 1],
      ["2026-11-02", 2, 1, 1],
    ],
  );
});

test("npm run report:usage prints weekly totals without identifying members", async () => {
  const [alice, ben] = await members("reportalice", "reportben");
  await titles(1);
  await friend(alice, ben);
  const recommendation = await updateTitleActivity(
    alice,
    "movie:1",
    "recommended",
    true,
  );
  await db.query(
    "UPDATE feed_item SET created_at='2026-10-20T12:00:00Z' WHERE id=$1",
    [recommendation],
  );
  for (const [user, day] of [
    [alice, "2026-10-28"],
    [ben, "2026-10-28"],
    [ben, "2026-11-03"],
  ])
    await db.query("INSERT INTO member_active_day(user_id,day) VALUES($1,$2)", [
      user,
      day,
    ]);
  await db.query(
    `INSERT INTO want_to_watch_save(user_id,title_id,saved_on,surface,friend_recommending)
    VALUES($1,'movie:1','2026-10-28','friend_recommendation',true)`,
    [ben],
  );
  await db.query(
    `INSERT INTO comment(feed_item_id,conversation_id,author_id,body,created_at)
    SELECT id,conversation_id,$2,'Report fixture','2026-10-29T12:00:00Z' FROM feed_item WHERE id=$1`,
    [recommendation, ben],
  );
  const { stdout } = await execute(
    "npm",
    [
      "run",
      "--silent",
      "report:usage",
      "--",
      "--weeks",
      "2",
      "--through",
      "2026-11-08",
    ],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    },
  );
  assert.equal(
    stdout,
    `Screenr usage for the 2 weeks starting 2026-10-26
Weeks run Monday through Sunday, Pacific time. Totals only.

Members who return each week
Week of     Active members  Also active the week before
2026-10-26               2                            0
2026-11-02               1                            1

Want to watch saves from friends' recommendations
Week of     Saves  Observed  Inferred
2026-10-26      1         1         1
2026-11-02      0         0         0
Observed: saved where a friend's recommendation was shown.
Inferred: saved while a direct friend was recommending the title.
Watch statuses are not built yet (#100), so saves are not yet followed to
Watching, Caught up, or Finished.

Conversations with at least two people
Week of     Conversations  Back-and-forth  Repeat commenters
2026-10-26              1               0                  0
2026-11-02              0               0                  0
`,
  );
  for (const value of [
    alice,
    ben,
    "reportalice",
    "reportben",
    "Telemetry Movie",
  ])
    assert.ok(!stdout.includes(value));
});

test("worker cleanup deletes active days and saves older than 12 months and keeps conversations", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "Old talk", false);
  await db.query("UPDATE comment SET created_at=now()-interval '3 years'");
  const { cutoff } = (
    await db.query(
      `SELECT (((now() AT TIME ZONE 'America/Los_Angeles') - interval '12 months')::date)::text AS cutoff`,
    )
  ).rows[0];
  for (const offset of [-400, -1, 0, 1, 30]) {
    await db.query(
      "INSERT INTO member_active_day(user_id,day) VALUES($1,$2::date+$3::int)",
      [ben, cutoff, offset],
    );
    await db.query(
      `INSERT INTO want_to_watch_save(user_id,title_id,saved_on,surface,friend_recommending)
      VALUES($1,'movie:1',$2::date+$3::int,'title',true)`,
      [ben, cutoff, offset],
    );
  }
  await pruneUsage();
  const kept = (
    await db.query(
      `SELECT (SELECT array_agg(day-$1::date ORDER BY day) FROM member_active_day) AS days,
        (SELECT array_agg(saved_on-$1::date ORDER BY saved_on) FROM want_to_watch_save) AS saves,
        (SELECT count(*)::int FROM comment) AS comments`,
      [cutoff],
    )
  ).rows[0];
  assert.deepEqual(kept, { days: [0, 1, 30], saves: [0, 1, 30], comments: 1 });
});

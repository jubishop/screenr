import { test, afterEach, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  useDatabase,
  db,
  assertRouteError,
  captureFailures,
  cookieFor,
  failureEvents,
  friend,
  person,
  setup,
} from "./social-fixture";
import type { FeedItem } from "../../src/shared";

const { POST: action } =
  await import("../../src/app/api/screenr/[action]/route");
const { POST: review } = await import("../../src/app/api/reports/route");
const { GET: photo } =
  await import("../../src/app/api/reports/photo/[report]/route");
const { conversations, feedPage } = await import("../../src/server/feed");
const { profileFor } = await import("../../src/server/profiles");
const { addComment, createDiscussionPost, createTitleComment, removeComment } =
  await import("../../src/server/comments");
const { saveReview } = await import("../../src/server/reviews");
const { updateWatchStatus } = await import("../../src/server/title-actions");
const { uploadPhoto } = await import("../../src/server/photos");
const { changeRelationship } = await import("../../src/server/relationships");
const { notifications } = await import("../../src/server/notifications");
const { changePushDevice } = await import("../../src/server/push");
const {
  dailyReportLimit,
  isOwner,
  pendingReports,
  reportContent,
  reviewReport,
} = await import("../../src/server/reports");
const { deliverOne } = await import("../../src/server/email");
const { deliverPushover, pushoverFromEnvironment, runAlertPass } =
  await import("../../src/server/owner-alerts");

useDatabase();
afterEach(() => mock.restoreAll());

// Members' reports and the owner's review
// (docs/data-and-access.md#content-reports).

const origin = "http://localhost:3000";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

// Names the owner and turns on both alerts for one test.
function configureAlerts(t: TestContext, owner = "owner@example.test") {
  const settings: Record<string, string> = {
    SCREENR_OWNER_EMAIL: owner,
    EMAIL_TRANSPORT: "resend",
    RESEND_API_KEY: "test-key-never-used-on-the-network",
    EMAIL_FROM: "Screenr <screenr@example.test>",
    PUSHOVER_API_KEY: "test-pushover-app-token",
    PUSHOVER_USER_KEY: "test-pushover-user-key",
  };
  Object.assign(process.env, settings);
  t.after(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
  });
}

// A member whose account email the owner setting names.
async function owner(t: TestContext) {
  const id = await person("owner");
  configureAlerts(t);
  return id;
}

const ids = (items: FeedItem[]) => items.map((item) => item.id);
const comment = (items: FeedItem[], entry: string, reply: string) =>
  items.find((item) => item.id === entry)!.comments.find((c) => c.id === reply);

async function reports() {
  return (
    await db.query(
      `SELECT kind,reporter_id,author_id,reason,note,body,rating,title_name,display_name,
        photo IS NOT NULL AS photo,resolution FROM content_report ORDER BY created_at,id`,
    )
  ).rows;
}

function post(path: string, data: unknown, cookie: string, from = origin) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: from,
    },
    body: JSON.stringify(data),
  });
}
const send = (cookie: string, data: unknown) =>
  action(post("/api/screenr/report", data, cookie), {
    params: Promise.resolve({ action: "report" }),
  });
const act = (cookie: string, data: unknown, from?: string) =>
  review(post("/api/reports", data, cookie, from), {});

test("members report posts, comments, reviews, and replies, which then leave only the reporter's feeds", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, cam);
  const postId = await createDiscussionPost(ben, "Rude post", false);
  const titleComment = await createTitleComment(
    ben,
    "movie:1",
    "Rude comment",
    true,
  );
  const reviewId = await saveReview(ben, "movie:1", 2, "Rude review", false);
  const reply = await addComment(ben, postId, "Rude reply", false);
  const answer = await addComment(cam, postId, "Cam answers", false, reply);
  const kept = await addComment(ben, titleComment, "Kept reply", false);

  // A reported entry hides its replies too, so the reply goes first.
  for (const fields of [
    { item: titleComment, reply: kept, reason: "other" },
    { item: postId, reason: "harassment", note: "  Again and again.  " },
    { item: titleComment, reason: "spam" },
    { item: reviewId, reason: "hate", note: "" },
  ])
    await reportContent(alice, fields);
  assert.deepEqual(
    (await reports()).map(
      ({ kind, reason, note, body, rating, title_name }) => ({
        kind,
        reason,
        note,
        body,
        rating,
        title_name,
      }),
    ),
    [
      {
        kind: "comment",
        reason: "other",
        note: null,
        body: "Kept reply",
        rating: null,
        title_name: "Test Movie",
      },
      {
        kind: "post",
        reason: "harassment",
        note: "Again and again.",
        body: "Rude post",
        rating: null,
        title_name: null,
      },
      {
        kind: "comment",
        reason: "spam",
        note: null,
        body: "Rude comment",
        rating: null,
        title_name: "Test Movie",
      },
      {
        kind: "review",
        reason: "hate",
        note: null,
        body: "Rude review",
        rating: 2,
        title_name: "Test Movie",
      },
    ],
  );
  // The reporter no longer sees the entries; a reported reply is
  // unavailable to them, as a blocked author's is.
  const reporter = (await feedPage(alice, { before: Infinity })).conversations;
  for (const entry of [postId, titleComment, reviewId])
    assert.ok(!ids(reporter).includes(entry));
  assert.ok(
    !ids(await conversations(alice, { title: "movie:1" })).includes(reviewId),
  );
  // Other readers see everything.
  const other = (await feedPage(cam, { before: Infinity })).conversations;
  for (const entry of [postId, titleComment, reviewId])
    assert.ok(ids(other).includes(entry));
  assert.equal(comment(other, titleComment, kept)?.body, "Kept reply");
  // A reported reply keeps its place for the replies beneath it.
  await reportContent(cam, { item: postId, reply, reason: "spam" });
  const camView = (await feedPage(cam, { before: Infinity })).conversations;
  assert.deepEqual(
    { ...comment(camView, postId, reply), reactions: undefined },
    {
      ...comment(camView, postId, reply),
      body: "",
      unavailable: true,
      author_id: null,
      username: null,
      display_name: null,
      photo: null,
      reactions: undefined,
    },
  );
  assert.equal(comment(camView, postId, answer)?.body, "Cam answers");
});

test("a review in a combined card is reported by its own ID and hides the card from the reporter", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await updateWatchStatus(ben, "movie:1", "finished");
  const reviewId = await saveReview(ben, "movie:1", 1, "Hated it", false);
  const card = (await conversations(alice, { title: "movie:1" })).find(
    (item) => item.owner_id === ben,
  )!;
  assert.ok(
    card.id === reviewId ||
      card.combined.some((entry) => entry.id === reviewId),
  );
  await reportContent(alice, { item: reviewId, reason: "other" });
  assert.equal((await reports())[0].body, "Hated it");
  assert.ok(
    !(await conversations(alice, { title: "movie:1" })).some(
      (item) => item.owner_id === ben,
    ),
  );
});

test("a profile report keeps its name and photo, and the profile stays visible", async () => {
  const { alice, outsider } = await setup();
  await uploadPhoto(outsider, jpeg);
  await reportContent(alice, {
    person: outsider,
    reason: "sexual",
    note: "The photo.",
  });
  const [row] = await reports();
  assert.equal(row.kind, "profile");
  assert.equal(row.display_name, "outsider");
  assert.equal(row.photo, true);
  assert.equal(row.author_id, outsider);
  assert.equal((await profileFor(alice, "outsider")).user_id, outsider);
});

test("reports refuse the reporter's own content, other entry kinds, hidden items, and bad fields", async () => {
  const { alice, ben, outsider, conversation } = await setup();
  await friend(alice, ben);
  const own = await createDiscussionPost(alice, "Mine", false);
  const hidden = await createDiscussionPost(outsider, "Not for Alice", false);
  const removed = await createDiscussionPost(ben, "Gone", false);
  await removeComment(ben, removed);
  await changeRelationship(alice, outsider, "block");
  for (const [fields, status, message] of [
    [{ item: own, reason: "spam" }, 400, "You can’t report your own content."],
    [
      { person: alice, reason: "spam" },
      400,
      "You can’t report your own content.",
    ],
    [
      { item: conversation, reason: "spam" },
      400,
      "Only posts, reviews, comments, and profiles can be reported.",
    ],
    [{ item: hidden, reason: "spam" }, 404, "Item not found."],
    [{ item: removed, reason: "spam" }, 404, "Item not found."],
    [{ item: "not-a-uuid", reason: "spam" }, 404, "Item not found."],
    [{ item: ben, reason: "spam" }, 404, "Item not found."],
    [{ person: outsider, reason: "spam" }, 404, "Person not found."],
    [
      { item: conversation, reply: "1", reason: "spam" },
      404,
      "Comment not found.",
    ],
    [{ person: ben }, 400, "Choose why you’re reporting it."],
    [{ person: ben, reason: "rude" }, 400, "Choose why you’re reporting it."],
    [{ reason: "spam" }, 400, "Choose what to report."],
    [{ person: ben, item: own, reason: "spam" }, 400, "Choose what to report."],
    [{ person: ben, reason: "spam", note: 5 }, 400, "Invalid note."],
    [
      { person: ben, reason: "spam", note: "x".repeat(501) },
      400,
      "Notes must contain at most 500 characters.",
    ],
  ] as const)
    await assert.rejects(reportContent(alice, fields), { status, message });
  assert.deepEqual(await reports(), []);
});

test("a second open report of the same item changes nothing, and a member's reports a day are limited", async (t) => {
  const { alice, ben } = await setup();
  await owner(t);
  await friend(alice, ben);
  const postId = await createDiscussionPost(ben, "Spam", false);
  await reportContent(alice, { item: postId, reason: "spam" });
  await reportContent(alice, { person: ben, reason: "spam" });
  await reportContent(alice, { person: ben, reason: "other" });
  assert.equal((await reports()).length, 2);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM pushover_job")).rows[0].n,
    2,
  );
  // A dismissed report lets the member report the profile again.
  const [first] = await pendingReports();
  await reviewReport(
    (await db.query(`SELECT id FROM "user" WHERE email='owner@example.test'`))
      .rows[0].id,
    first.id,
    "dismiss",
  );
  await reportContent(alice, { person: ben, reason: "other" });
  assert.equal((await reports()).length, 3);
  const others = [];
  for (let index = 0; index < dailyReportLimit; index++)
    others.push(await person(`spammer${index}`));
  for (const other of others.slice(0, dailyReportLimit - 3))
    await reportContent(alice, { person: other, reason: "spam" });
  await assert.rejects(
    reportContent(alice, { person: others.at(-1), reason: "spam" }),
    {
      status: 429,
      message: "You’ve sent a lot of reports today. Please try again tomorrow.",
    },
  );
});

test("reporting a reply hides its notification from the reporter and updates their badge", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const postId = await createDiscussionPost(alice, "My post", false);
  const reply = await addComment(ben, postId, "Mean reply", false);
  await changePushDevice(alice, await sessionOf(alice), {
    action: "register",
    token: "ab".repeat(32),
    environment: "sandbox",
    topic: "com.artisanalsoftware.Screenr.dev",
    build: 1,
  });
  await db.query("DELETE FROM push_job");
  const kinds = async () =>
    (await notifications(alice)).items.map((item) => item.kind).sort();
  assert.deepEqual(await kinds(), ["comment", "friend_accepted"]);
  await reportContent(alice, { item: postId, reply, reason: "harassment" });
  assert.deepEqual(await kinds(), ["friend_accepted"]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM push_job WHERE notification_id IS NULL",
      )
    ).rows[0].n,
    1,
  );
});

async function sessionOf(userId: string) {
  await cookieFor(userId);
  return (
    await db.query<{ id: string }>(
      'SELECT id FROM session WHERE "userId"=$1 LIMIT 1',
      [userId],
    )
  ).rows[0].id;
}

test("a new report sends the owner one email and one Pushover alert without member content", async (t) => {
  const { alice, ben } = await setup();
  await owner(t);
  await friend(alice, ben);
  const postId = await createDiscussionPost(ben, "Secret insult", false);
  await reportContent(alice, {
    item: postId,
    reason: "harassment",
    note: "Private note",
  });
  const emails: Record<string, unknown>[] = [];
  const alerts: URLSearchParams[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url === "https://api.resend.com/emails") {
      emails.push(JSON.parse(String(init.body)));
      return Response.json({ id: "sent" });
    }
    assert.equal(url, "https://api.pushover.net/1/messages.json");
    alerts.push(init.body as URLSearchParams);
    return Response.json({ status: 1 });
  });
  assert.equal(await deliverOne(), true);
  assert.equal(await deliverOne(), false);
  await runAlertPass(pushoverFromEnvironment(), 1);
  assert.equal(emails.length, 1);
  assert.deepEqual(
    { to: emails[0].to, subject: emails[0].subject, text: emails[0].text },
    {
      to: ["owner@example.test"],
      subject: "New report on Screenr",
      text: "A member reported a post on Screenr. Review it within 24 hours at http://localhost:3000/reports",
    },
  );
  assert.equal(alerts.length, 1);
  assert.deepEqual(Object.fromEntries(alerts[0]), {
    token: "test-pushover-app-token",
    user: "test-pushover-user-key",
    title: "Screenr report",
    message: "A member reported a post on Screenr. Review it within 24 hours.",
    url: "http://localhost:3000/reports",
    url_title: "Review reports",
  });
  for (const text of [JSON.stringify(emails), String(alerts[0])])
    for (const value of ["Secret insult", "Private note", "ben", "alice"])
      assert.ok(!text.includes(value), `${value} reached an alert`);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM pushover_job")).rows[0].n,
    0,
  );
});

test("without the owner or Pushover settings, reports send no alerts", async () => {
  const { alice, ben } = await setup();
  await reportContent(alice, { person: ben, reason: "spam" });
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM email_job")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM pushover_job")).rows[0].n,
    0,
  );
});

test("Pushover failures retry until a rejection, and partial settings log", async (t) => {
  const { alice, ben } = await setup();
  await owner(t);
  await reportContent(alice, { person: ben, reason: "spam" });
  const printed = captureFailures();
  const statuses = [503, 400];
  mock.method(globalThis, "fetch", async () =>
    Response.json({ status: 0 }, { status: statuses.shift() }),
  );
  const pushover = { token: "test-token", user: "test-user" };
  assert.equal(await deliverPushover(pushover), true);
  const [job] = (
    await db.query(
      "SELECT attempts,last_error,available_at>now() AS delayed FROM pushover_job",
    )
  ).rows;
  assert.deepEqual(job, {
    attempts: 1,
    last_error: "Pushover HTTP 503",
    delayed: true,
  });
  assert.equal(await deliverPushover(pushover), false);
  await db.query("UPDATE pushover_job SET available_at=now()");
  assert.equal(await deliverPushover(pushover), true);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM pushover_job")).rows[0].n,
    0,
  );
  assert.equal(pushoverFromEnvironment({ PUSHOVER_API_KEY: "token" }), null);
  assert.deepEqual(failureEvents(printed), [
    "pushover delivery failed",
    "pushover delivery failed",
    "pushover delivery off",
  ]);
  const lines = printed.map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map(({ status, final, missing }) => ({ status, final, missing })),
    [
      { status: 503, final: false, missing: undefined },
      { status: 400, final: true, missing: undefined },
      { status: undefined, final: undefined, missing: "PUSHOVER_USER_KEY" },
    ],
  );
});

test("only the owner reviews reports, and removal hides each kind from everyone", async (t) => {
  const { alice, ben, cam } = await setup();
  const ownerId = await owner(t);
  await friend(alice, ben);
  await friend(cam, ben);
  await uploadPhoto(ben, jpeg);
  const postId = await createDiscussionPost(ben, "Rude post", false);
  const titleComment = await createTitleComment(ben, "movie:1", "Rude", false);
  const reviewId = await saveReview(ben, "movie:1", 1, "Rude review", false);
  const reply = await addComment(ben, postId, "Rude reply", false);
  for (const fields of [
    { item: postId, reply, reason: "spam" },
    { item: postId, reason: "spam" },
    { item: titleComment, reason: "spam" },
    { item: reviewId, reason: "spam" },
    { person: ben, reason: "spam" },
  ])
    await reportContent(alice, fields);
  // Cam reported the same post, so removing it resolves both reports.
  await reportContent(cam, { item: postId, reason: "hate" });

  assert.equal(await isOwner(ownerId), true);
  assert.equal(await isOwner(alice), false);
  const pending = await pendingReports();
  assert.deepEqual(
    pending.map((report) => report.kind),
    ["post", "profile", "review", "comment", "post", "comment"],
  );
  const profileReport = pending.find((report) => report.kind === "profile")!;
  assert.deepEqual(profileReport.author, {
    user_id: ben,
    username: "ben",
    display_name: "ben",
  });
  assert.deepEqual(profileReport.reporter, {
    username: "alice",
    display_name: "alice",
  });
  assert.equal(profileReport.photo, true);

  // Other members, and requests from other sites, get nothing.
  const memberCookie = await cookieFor(alice);
  const ownerCookie = await cookieFor(ownerId);
  await assertRouteError(
    await act(memberCookie, { report: profileReport.id, action: "remove" }),
    { status: 404, message: "Page not found." },
  );
  await assertRouteError(
    await act(
      ownerCookie,
      { report: profileReport.id, action: "remove" },
      "https://evil.example",
    ),
    { status: 403, message: "Invalid request origin." },
  );
  await assertRouteError(
    await act(ownerCookie, { report: profileReport.id, action: "explode" }),
    { status: 400, message: "Unknown review action." },
  );
  await assertRouteError(
    await act(ownerCookie, { report: "missing", action: "dismiss" }),
    { status: 404, message: "Report not found." },
  );
  const photoRequest = (cookie: string) =>
    photo(
      new Request(`${origin}/api/reports/photo/${profileReport.id}`, {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ report: profileReport.id }) },
    );
  assert.equal((await photoRequest(memberCookie)).status, 404);
  const served = await photoRequest(ownerCookie);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), jpeg);

  for (const report of pending.filter(
    (report) => report.reporter.username === "alice",
  ))
    assert.equal(
      (await act(ownerCookie, { report: report.id, action: "remove" })).status,
      200,
    );
  assert.deepEqual(await pendingReports(), []);
  assert.deepEqual(
    (await reports()).map((row) => row.resolution),
    ["removed", "removed", "removed", "removed", "removed", "removed"],
  );
  // The report keeps what its reporter saw.
  assert.deepEqual(
    (await reports()).map((row) => row.body),
    ["Rude reply", "Rude post", "Rude", "Rude review", null, "Rude post"],
  );
  // Gone for everyone, the author included.
  for (const viewer of [ben, cam]) {
    const items = (await feedPage(viewer, { before: Infinity })).conversations;
    assert.ok(!ids(items).includes(titleComment));
    assert.ok(!ids(items).includes(reviewId));
    const removed = items.find((item) => item.id === postId);
    assert.ok(!removed || (!removed.active && removed.body === ""));
    assert.ok(
      (removed?.comments ?? []).every((c) => c.body === "" && c.removed),
    );
  }
  const profile = await profileFor(cam, "ben");
  assert.equal(profile.photo, null);
  assert.equal(profile.display_name, "ben");
});

test("removing a profile resets a display name that differs from the username, and dismissing leaves content alone", async (t) => {
  const { alice, ben } = await setup();
  const ownerId = await owner(t);
  await friend(alice, ben);
  await db.query(
    "UPDATE profile SET display_name='Rude Name' WHERE user_id=$1",
    [ben],
  );
  const postId = await createDiscussionPost(ben, "Fine post", false);
  await reportContent(alice, { person: ben, reason: "hate" });
  await reportContent(alice, { item: postId, reason: "other" });
  const [postReport, profileReport] = await pendingReports();
  await reviewReport(ownerId, postReport.id, "dismiss");
  assert.ok(
    ids((await feedPage(ben, { before: Infinity })).conversations).includes(
      postId,
    ),
  );
  await reviewReport(ownerId, profileReport.id, "remove");
  assert.equal((await profileFor(alice, "ben")).display_name, "ben");
  await assert.rejects(reviewReport(ownerId, profileReport.id, "dismiss"), {
    status: 404,
    message: "Report not found.",
  });
  await assert.rejects(reviewReport(alice, profileReport.id, "dismiss"), {
    status: 404,
    message: "Page not found.",
  });
});

test("the report action answers the iPhone app and the web alike", async () => {
  const { alice, ben } = await setup();
  const cookie = await cookieFor(alice);
  const response = await send(cookie, { person: ben, reason: "spam" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  await assertRouteError(await send(cookie, { person: ben }), {
    status: 400,
    message: "Choose why you’re reporting it.",
  });
});

test("a pending report notes when its author already deleted the item", async (t) => {
  const { alice, ben } = await setup();
  await owner(t);
  await friend(alice, ben);
  const postId = await createDiscussionPost(ben, "Soon gone", false);
  await reportContent(alice, { item: postId, reason: "spam" });
  assert.equal((await pendingReports())[0].gone, false);
  await removeComment(ben, postId);
  assert.equal((await pendingReports())[0].gone, true);
});

test("deployment accepts the owner and Pushover settings only when well formed and complete", async () => {
  const env = {
    ...process.env,
    BETTER_AUTH_URL: "https://screenr.example",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    TMDB_READ_TOKEN: "token",
    EMAIL_TRANSPORT: "resend",
    EMAIL_FROM: "Screenr <screenr@example.test>",
    RESEND_API_KEY: "key",
  };
  const check = (settings: Record<string, string>) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/validate-config.ts"],
      { env: { ...env, ...settings }, timeout: 15_000 },
    );
  const rejects = (settings: Record<string, string>, message: RegExp) =>
    assert.rejects(check(settings), (error: { stderr: string }) => {
      assert.match(error.stderr, message);
      return true;
    });
  await Promise.all([
    check({}),
    check({
      SCREENR_OWNER_EMAIL: "owner@example.test",
      PUSHOVER_API_KEY: "app",
      PUSHOVER_USER_KEY: "user",
    }),
    rejects(
      { SCREENR_OWNER_EMAIL: "not an address" },
      /SCREENR_OWNER_EMAIL must be an email address\./,
    ),
    rejects(
      { PUSHOVER_API_KEY: "app" },
      /Set both PUSHOVER_API_KEY and PUSHOVER_USER_KEY, or neither\./,
    ),
  ]);
});

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  useDatabase,
  setup,
  friend,
  db,
  captureFailures,
  failureEvents,
} from "./social-fixture";
import { changeRelationship } from "../../src/server/relationships";
import { addComment, removeComment } from "../../src/server/comments";
import {
  notifications,
  readNotification,
  saveActivityEmail,
} from "../../src/server/notifications";
import { setReaction } from "../../src/server/reactions";
import { updateTitleActivity } from "../../src/server/title-actions";
import { deliverOne, queueCode } from "../../src/server/email";
import { domainLock } from "../../src/server/db";

useDatabase();
process.env.EMAIL_TRANSPORT = "resend";
process.env.RESEND_API_KEY = "test-key-never-used-on-the-network";
process.env.EMAIL_FROM = "Screenr <screenr@example.test>";
let sent: { to: string[]; subject: string; text: string; key: string }[];
let fail = false;
// Set by `hang`: the next Resend request waits until the test answers it.
let hung: { request: () => void; answer: Promise<void> } | undefined;
beforeEach(async () => {
  await db.query("TRUNCATE email_job CASCADE");
  sent = [];
  fail = false;
  hung = undefined;
  mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.resend.com/emails");
      sent.push({
        ...JSON.parse(String(options.body)),
        key: new Headers(options.headers).get("Idempotency-Key"),
      });
      if (hung) {
        const { request, answer } = hung;
        hung = undefined;
        request();
        await answer;
      }
      return fail
        ? new Response("Unavailable", { status: 503 })
        : Response.json({ id: "fixture" });
    },
  );
});
afterEach(() => mock.restoreAll());
const due = () =>
  db.query(
    "UPDATE notification SET created_at=now()-interval '11 minutes' WHERE email_pending",
  );
const retry = () =>
  db.query("UPDATE email_job SET available_at=now() WHERE sent_at IS NULL");
// Makes Resend hang on the next request, as during a provider incident.
// `requested` settles once the request arrives; `answer` lets Resend reply.
function hang() {
  let request!: () => void;
  let answer!: () => void;
  const requested = new Promise<void>((resolve) => (request = resolve));
  hung = {
    request,
    answer: new Promise<void>((resolve) => (answer = resolve)),
  };
  return { requested, answer };
}

test("email is opt-in without a backlog, waits ten minutes, groups unread events, and sends them once", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "Before opt-in", false);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "First unread secret", true);
  await addComment(ben, conversation, "Already read", false);
  await readNotification(alice, (await notifications(alice)).items[0].id);
  assert.equal(await deliverOne(), false);
  assert.equal(sent.length, 0);
  await due();
  const latest = await addComment(
    ben,
    conversation,
    "Within the same window",
    false,
  );
  await Promise.all([deliverOne(), deliverOne()]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["alice@example.test"]);
  assert.equal(sent[0].subject, "2 unread notifications on Screenr");
  assert.ok(sent[0].text.includes(`reply=${latest}`));
  assert.ok(!/secret|Already read|Before opt-in/.test(sent[0].text));
  assert.match(
    sent[0].text,
    /Manage activity emails: http:\/\/localhost:3000\/account/,
  );
  assert.equal(await deliverOne(), false);
});

test("pending emails recheck removal, blocking, friendship, and read state before retry", async () => {
  // Each failed send logs a failure line, which this test reads.
  const printed = captureFailures();
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await saveActivityEmail(alice, true);
  const removed = await addComment(ben, conversation, "Remove this", false);
  await addComment(cam, conversation, "Block this", false);
  await due();
  fail = true;
  await deliverOne();
  assert.equal(sent.length, 1);
  await removeComment(alice, removed);
  await changeRelationship(alice, cam, "block");
  await retry();
  fail = false;
  await deliverOne();
  assert.equal(
    sent.length,
    1,
    "No inaccessible content reaches the provider again",
  );
  await addComment(ben, conversation, "Read before retry", false);
  await due();
  fail = true;
  await deliverOne();
  await readNotification(alice, (await notifications(alice)).items[0].id);
  await retry();
  await deliverOne();
  assert.equal(sent.length, 2);
  await addComment(ben, conversation, "Unfriend before delivery", false);
  await changeRelationship(alice, ben, "remove");
  await due();
  await deliverOne();
  assert.equal(sent.length, 2);
  assert.deepEqual(failureEvents(printed), [
    "email delivery failed",
    "email delivery failed",
  ]);
});

test("retries reuse their key and fixed batch, while sign-in codes retain delivery priority", async () => {
  // Each failed send logs a failure line, which this test reads.
  const printed = captureFailures();
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "First batch", false);
  await due();
  fail = true;
  await deliverOne();
  assert.equal(await deliverOne(), false, "Retry observes its backoff");
  await addComment(ben, conversation, "Next window", false);
  await retry();
  await queueCode({ email: "login@example.test", otp: "123456" });
  fail = false;
  await deliverOne();
  assert.equal(sent[1].subject, "Your Screenr sign-in code");
  await deliverOne();
  assert.equal(sent[0].key, sent[2].key);
  assert.equal(sent[2].subject, "1 unread notification on Screenr");
  assert.equal(await deliverOne(), false);
  await due();
  await deliverOne();
  assert.equal(sent.length, 4);
  assert.notEqual(sent[3].key, sent[2].key);
  assert.deepEqual(failureEvents(printed), ["email delivery failed"]);
});

test("opt-out cancels queued retries and pending windows, even if the member opts back in", async () => {
  // Each failed send logs a failure line, which this test reads.
  const printed = captureFailures();
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "Queued", false);
  await due();
  fail = true;
  await deliverOne();
  await addComment(ben, conversation, "Not queued yet", false);
  await saveActivityEmail(alice, false);
  await saveActivityEmail(alice, true);
  await retry();
  await due();
  assert.equal(await deliverOne(), false);
  assert.equal(sent.length, 1);
  assert.deepEqual(failureEvents(printed), ["email delivery failed"]);
});

test("a database error while building an activity email still records the attempt and its backoff", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "Queued", false);
  await due();
  const printed = captureFailures();
  // Reading the email's notifications fails, which aborts the transaction.
  await db.query(
    "ALTER VIEW visible_notification RENAME TO visible_notification_hidden",
  );
  try {
    assert.equal(await deliverOne(), true);
  } finally {
    await db.query(
      "ALTER VIEW visible_notification_hidden RENAME TO visible_notification",
    );
  }
  const { rows } = await db.query(
    "SELECT id,attempts,available_at>now() AS delayed,sent_at FROM email_job",
  );
  assert.deepEqual(
    rows.map(({ id, ...job }) => job),
    [{ attempts: 1, delayed: true, sent_at: null }],
  );
  assert.equal(await deliverOne(), false, "The retry waits for its backoff");
  assert.equal(printed.length, 1, printed.join("\n"));
  const { stack, ...failure } = JSON.parse(printed[0]);
  assert.ok(stack.length > 0);
  assert.deepEqual(failure, {
    event: "email delivery failed",
    job: rows[0].id,
    kind: "activity",
    attempt: 1,
    final: false,
    error: "DatabaseError",
    code: "42P01",
  });
  await retry();
  assert.equal(await deliverOne(), true);
  assert.equal(sent.length, 1);
});

test("a changed retry omits read events and uses a key for its current content", async () => {
  // Each failed send logs a failure line, which this test reads.
  const printed = captureFailures();
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "Keep", false);
  const omit = await addComment(ben, conversation, "Omit", false);
  await due();
  fail = true;
  await deliverOne();
  await readNotification(alice, (await notifications(alice)).items[0].id);
  await retry();
  fail = false;
  await deliverOne();
  assert.equal(sent[1].subject, "1 unread notification on Screenr");
  assert.ok(!sent[1].text.includes(`reply=${omit}`));
  assert.notEqual(sent[0].key, sent[1].key);
  assert.deepEqual(failureEvents(printed), ["email delivery failed"]);
});

test("a slow sign-in email does not delay an unrelated friendship request", async () => {
  const { alice, ben } = await setup();
  await queueCode({ email: "slow@example.test", otp: "234567" });
  let started!: () => void;
  let finish!: () => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mock.method(globalThis, "fetch", async () => {
    started();
    await provider;
    return Response.json({ id: "slow-provider" });
  });
  const delivery = deliverOne();
  await sending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      changeRelationship(ben, alice, "request"),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Friend request waited for unrelated sign-in delivery"),
            ),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    finish();
    await delivery;
  }
});

test("member writes go ahead while Resend hangs on an activity email", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "Queued", false);
  await due();
  const resend = hang();
  const delivery = deliverOne();
  try {
    await resend.requested;
    // A write that waited on a worker holding the write lock would fail
    // after two seconds with "Screenr is busy".
    await addComment(cam, conversation, "While Resend hangs", false);
    await setReaction(cam, conversation, null, "love");
    await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
    await changeRelationship(ben, cam, "request");
    await readNotification(alice, (await notifications(alice)).items[0].id);
  } finally {
    resend.answer();
    await delivery;
  }
  assert.equal(sent.length, 1);
  assert.equal(await deliverOne(), false);
});

// The worker passes every second. When no activity email is due, a pass
// leaves the write lock that member writes share alone, so it never waits
// behind them or makes them wait.
test("a worker pass with no email due doesn't take the write lock", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await saveActivityEmail(alice, true);
  await addComment(ben, conversation, "Not due for ten minutes", false);
  const writer = await db.connect();
  let pass: Promise<boolean> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT pg_advisory_xact_lock($1)", [domainLock]);
    pass = deliverOne();
    assert.equal(
      await Promise.race([pass, sleep(1000, "waited for the lock")]),
      false,
    );
  } finally {
    await writer.query("COMMIT");
    writer.release();
    await pass;
  }
  assert.equal(sent.length, 0);
  // Once the window is due, a pass queues and sends it under the lock.
  await due();
  assert.equal(await deliverOne(), true);
  assert.equal(sent.length, 1);
});

test("a block or opt-out committed before a send starts sends nothing", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(ben, cam);
  await saveActivityEmail(alice, true);
  await saveActivityEmail(ben, true);
  const own = await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  await addComment(ben, conversation, "Blocked before the send", false);
  await addComment(cam, own, "Opted out before the send", false);
  await due();
  const printed = captureFailures();
  fail = true;
  while (await deliverOne()) {
    /* Queue both emails, whose first sends fail. */
  }
  assert.equal(sent.length, 2);
  await changeRelationship(alice, ben, "block");
  await saveActivityEmail(ben, false);
  fail = false;
  await retry();
  while (await deliverOne()) {
    /* Drain all due jobs. */
  }
  assert.equal(sent.length, 2);
  // Only the two failed first sends log.
  assert.deepEqual(failureEvents(printed), [
    "email delivery failed",
    "email delivery failed",
  ]);
});

for (const [change, during] of [
  [
    "a block",
    (alice: string, ben: string) => changeRelationship(alice, ben, "block"),
  ],
  [
    "an opt-out",
    async (alice: string) => {
      await saveActivityEmail(alice, false);
      await saveActivityEmail(alice, true);
    },
  ],
] as const)
  test(`${change} committed during a failed send leaves the job stale, and it is never retried`, async () => {
    const { alice, ben, cam, conversation } = await setup();
    await friend(alice, ben);
    await friend(alice, cam);
    await saveActivityEmail(alice, true);
    await addComment(ben, conversation, "From Ben", false);
    // Cam's notification stays visible, so a retry would still send it.
    await addComment(cam, conversation, "From Cam", false);
    await due();
    const printed = captureFailures();
    const resend = hang();
    fail = true;
    const delivery = deliverOne();
    try {
      await resend.requested;
      await during(alice, ben);
    } finally {
      resend.answer();
      await delivery;
    }
    const { id } = (await db.query("SELECT id FROM email_job")).rows[0];
    assert.deepEqual(
      printed.map((line) => JSON.parse(line)),
      [
        {
          event: "email delivery failed",
          job: id,
          kind: "activity",
          attempt: 1,
          status: 503,
          final: true,
          stale: true,
        },
      ],
    );
    fail = false;
    await retry();
    assert.equal(await deliverOne(), false);
    assert.equal(sent.length, 1);
  });

test("email summaries order all new replies from newest to oldest across ID digit boundaries", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await saveActivityEmail(alice, true);
  const replies: string[] = [];
  for (let i = 0; i < 12; i++)
    replies.push(await addComment(ben, conversation, `Reply ${i}`, false));
  await due();
  await deliverOne();
  assert.deepEqual(
    [...sent[0].text.matchAll(/reply=(\d+)/g)].map((match) => match[1]),
    replies.reverse(),
  );
});

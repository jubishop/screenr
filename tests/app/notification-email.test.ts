import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, setup, friend, db } from "./social-fixture";
import {
  addComment,
  changeRelationship,
  removeComment,
} from "../../src/server/social";
import {
  notifications,
  readNotification,
  saveActivityEmail,
} from "../../src/server/notifications";
import { deliverOne, queueCode } from "../../src/server/email";

useDatabase();
process.env.EMAIL_TRANSPORT = "resend";
process.env.RESEND_API_KEY = "test-key-never-used-on-the-network";
process.env.EMAIL_FROM = "Screenr <screenr@example.test>";
let sent: { to: string[]; subject: string; text: string; key: string }[];
let fail = false;
beforeEach(async () => {
  await db.query("TRUNCATE email_job CASCADE");
  sent = [];
  fail = false;
  mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.resend.com/emails");
      sent.push({
        ...JSON.parse(String(options.body)),
        key: new Headers(options.headers).get("Idempotency-Key"),
      });
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
});

test("retries reuse their key and fixed batch, while sign-in codes retain delivery priority", async () => {
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
});

test("opt-out cancels queued retries and pending windows, even if the member opts back in", async () => {
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
});

test("a changed retry omits read events and uses a key for its current content", async () => {
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

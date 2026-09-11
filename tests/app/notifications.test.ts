import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, setup, friend, db, pending } from "./social-fixture";
import {
  addComment,
  changeRelationship,
  removeComment,
  createTitleComment,
  updateProfile,
  updateTitleActivity,
  setReaction,
} from "../../src/server/social";
import { loadScreen } from "../../src/server/screens";
import {
  notifications,
  readNotification,
  readAllNotifications,
  saveActivityEmail,
} from "../../src/server/notifications";
import { createInvitation, completeSignup } from "../../src/server/invitations";

useDatabase();

async function unread(viewer: string) {
  const screen = await loadScreen(viewer, "/");
  return (screen as typeof screen & { unreadNotifications: number })
    .unreadNotifications;
}

test("screens count incoming requests once and replace them with the acceptance for the requester", async () => {
  const { alice, ben } = await setup();
  await changeRelationship(ben, alice, "request");
  await changeRelationship(ben, alice, "request");
  assert.equal(await unread(alice), 1);
  assert.equal(await unread(ben), 0);
  await changeRelationship(alice, ben, "accept");
  assert.equal(await unread(alice), 0);
  assert.equal(await unread(ben), 1);
});

test("notifications link to exact replies, use current names, and omit spoiler text", async () => {
  const { alice, ben } = await setup();
  await db.query("UPDATE title SET name='Test Movie' WHERE id='movie:1'");
  await friend(alice, ben);
  const post = await createTitleComment(
    alice,
    "movie:1",
    "Secret ending",
    true,
  );
  const reply = await addComment(ben, post, "More secret ending", true);
  await updateProfile(ben, "Benjamin", "benjamin");
  const page = await notifications(alice);
  assert.equal(
    page.items[0].message,
    "Benjamin commented on your post about Test Movie.",
  );
  assert.equal(
    page.items[0].href,
    `/titles/movie/1?item=${post}&reply=${reply}`,
  );
  assert.ok(!JSON.stringify(page).includes("secret ending"));
  assert.ok(!JSON.stringify(page).includes("Secret ending"));
  const selected = await readNotification(alice, page.items[0].id);
  assert.equal(selected.href, page.items[0].href);
  assert.equal((await notifications(alice)).items[0].read, true);
});

test("read ownership, id validation, and the bulk-read boundary preserve unseen new events", async () => {
  const { alice, ben, outsider, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "First", false);
  const page = await notifications(alice);
  await assert.rejects(
    readNotification(outsider, page.items[0].id),
    /no longer available/,
  );
  for (const invalid of [null, 1, "-1", "1.2", "9223372036854775808", "oops"])
    await assert.rejects(
      readNotification(alice, invalid),
      /Invalid notification/,
    );
  await addComment(ben, conversation, "New after the snapshot", false);
  await readAllNotifications(alice, page.through);
  assert.equal(await unread(alice), 1);
  const unreadPage = await notifications(alice, null, true);
  assert.equal(unreadPage.items.length, 1);
  await readNotification(alice, unreadPage.items[0].id);
  assert.equal(await unread(alice), 0);
  assert.equal((await notifications(alice)).items.length, 3);
});

test("pagination orders numeric IDs and reaches all older notifications without marking any read", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  for (let i = 0; i < 34; i++)
    await addComment(ben, conversation, `Comment ${i}`, false);
  const first = await notifications(alice);
  assert.equal(first.items.length, 30);
  const second = await notifications(alice, first.next);
  assert.equal(second.items.length, 5);
  assert.equal(second.next, null);
  const ids = [...first.items, ...second.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 35);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => Number(BigInt(b) - BigInt(a))),
  );
  assert.equal(await unread(alice), 35);
});

test("older-page snapshots leave newer unseen notifications unread until returning to latest", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  for (let i = 0; i < 34; i++)
    await addComment(ben, conversation, `Comment ${i}`, false);
  const first = await notifications(alice);
  await addComment(ben, conversation, "Arrived after the latest page", false);
  const older = await notifications(alice, first.next, false, first.through);
  assert.equal(older.through, first.through);
  assert.equal(older.items.length, 5);
  assert.equal(older.unread, 36);
  await readAllNotifications(alice, older.through);
  const latest = await notifications(alice, null, true);
  assert.equal(latest.items.length, 1);
  assert.equal(latest.unread, 1);
  assert.notEqual(latest.through, first.through);
  await readAllNotifications(alice, latest.through);
  assert.equal(await unread(alice), 0);
});

test("current access removes notices and counts, and restored comments retain their read state", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(ben, conversation, "Ben parent", false);
  const reply = await addComment(cam, conversation, "Cam reply", false, parent);
  const benNotice = (await notifications(ben)).items[0];
  await readNotification(ben, benNotice.id);
  await changeRelationship(ben, cam, "block");
  assert.equal((await notifications(ben)).items.length, 0);
  await assert.rejects(
    readNotification(ben, benNotice.id),
    /no longer available/,
  );
  await changeRelationship(ben, cam, "unblock");
  assert.equal((await notifications(ben)).items[0].read, true);
  await changeRelationship(alice, cam, "remove");
  assert.equal((await notifications(ben)).items.length, 0);
  await friend(alice, cam);
  assert.equal((await notifications(ben)).items[0].id, benNotice.id);
  await removeComment(alice, reply);
  assert.equal((await notifications(ben)).items.length, 0);
  await changeRelationship(alice, ben, "remove");
  assert.equal((await notifications(ben)).items.length, 0);
});

test("withdrawn requests and previous friendships never become notifications for a replacement friendship", async () => {
  const { alice, ben } = await setup();
  await changeRelationship(ben, alice, "request");
  const old = (await notifications(alice)).items[0];
  await changeRelationship(ben, alice, "remove");
  assert.equal(await unread(alice), 0);
  await friend(ben, alice);
  assert.equal((await notifications(alice)).items.length, 0);
  await assert.rejects(readNotification(alice, old.id), /no longer available/);
  assert.equal((await notifications(ben)).items.length, 1);
  await changeRelationship(ben, alice, "remove");
  await friend(ben, alice);
  assert.equal((await notifications(ben)).items.length, 1);
});

test("invited signup notifies only the inviter once, while routine activity and reactions do not notify", async () => {
  const { alice, ben, conversation } = await setup();
  const { token } = await createInvitation(alice);
  const newcomer = await pending("newcomer", token);
  await completeSignup(newcomer, "Newcomer", "newcomer");
  await completeSignup(newcomer, "Newcomer", "newcomer");
  assert.equal(await unread(alice), 1);
  assert.equal(await unread(newcomer), 0);
  await friend(alice, ben);
  const previous = await unread(alice);
  await updateTitleActivity(ben, "movie:1", "recommended", true);
  await setReaction(ben, conversation, null, "like");
  assert.equal(await unread(alice), previous);
  assert.equal(
    ((await loadScreen(alice, "/account")) as { activityEmail: boolean })
      .activityEmail,
    false,
  );
  await assert.rejects(saveActivityEmail(alice, "true"), /Choose whether/);
  await saveActivityEmail(alice, true);
  assert.equal(
    ((await loadScreen(alice, "/account")) as { activityEmail: boolean })
      .activityEmail,
    true,
  );
  assert.equal(
    (
      await db.query(
        "SELECT email_pending FROM notification WHERE recipient_id=$1",
        [alice],
      )
    ).rows.some((r) => r.email_pending),
    false,
  );
});

test("comments notify the content owner and addressed commenter without self-alerts or duplicate owner alerts", async () => {
  const { alice, ben, cam, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const direct = await addComment(ben, conversation, "A direct comment", false);
  await addComment(cam, conversation, "Reply to Ben", false, direct);
  assert.equal(await unread(alice), 4);
  assert.equal(await unread(ben), 1);
  assert.equal(await unread(cam), 0);
  const own = await addComment(alice, conversation, "Owner comment", false);
  assert.equal(await unread(alice), 4);
  await addComment(ben, conversation, "Reply to owner", false, own);
  assert.equal(await unread(alice), 5);
});

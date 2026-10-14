import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  setup,
  friend,
  db,
  denied,
  pending,
  cookieFor,
  bearerFor,
} from "./social-fixture";
import { updateProfile } from "../../src/server/profiles";
import { changeRelationship } from "../../src/server/relationships";
import { updateTitleActivity } from "../../src/server/title-actions";
import {
  addComment,
  removeComment,
  createDiscussionPost,
  createTitleComment,
} from "../../src/server/comments";
import { setReaction } from "../../src/server/reactions";
import { saveReview } from "../../src/server/reviews";
import { uploadPhoto } from "../../src/server/photos";
import { loadScreen } from "../../src/server/screens";
import {
  notification,
  notifications,
  type NotificationPage,
  readNotification,
  readAllNotifications,
  respondToFriendRequest,
  saveActivityEmail,
} from "../../src/server/notifications";
import { createInvitation, completeSignup } from "../../src/server/invitations";
import { GET } from "../../src/app/api/screenr/[action]/route";

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
    denied.notification,
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

function readPage(cookie: string, query: string, held?: string) {
  const headers = new Headers({ Cookie: cookie });
  if (held) headers.set("If-None-Match", held);
  return GET(
    new Request(`http://localhost:3000/api/screenr/notifications?${query}`, {
      headers,
    }),
    { params: Promise.resolve({ action: "notifications" }) },
  );
}
async function changedPage(cookie: string, query: string, held?: string) {
  const response = await readPage(cookie, query, held);
  assert.equal(response.status, 200);
  const version = response.headers.get("ETag");
  assert.match(version ?? "", /^W\/"[\w-]{43}"$/);
  if (held) assert.notEqual(version, held);
  return {
    version: version!,
    page: (await response.json()) as NotificationPage,
  };
}
async function unchangedPage(cookie: string, query: string, version: string) {
  const response = await readPage(cookie, query, version);
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("ETag"), version);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await response.text(), "");
}

test("unchanged notification pages answer 304, while arrivals, reads, and older pages answer in full with their boundary", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  for (let i = 0; i < 34; i++)
    await addComment(ben, conversation, `Comment ${i}`, false);
  const cookie = await cookieFor(alice);
  const latest = await changedPage(cookie, "unread=false");
  await unchangedPage(cookie, "unread=false", latest.version);
  const olderQuery = `unread=false&before=${latest.page.next}&through=${latest.page.through}`;
  const older = await changedPage(cookie, olderQuery, latest.version);
  assert.equal(older.page.items.length, 5);
  await unchangedPage(cookie, olderQuery, older.version);

  // An arrival changes the older page's unread count, not its items or
  // bulk-read boundary.
  await addComment(ben, conversation, "Arrived after the latest page", false);
  const counted = await changedPage(cookie, olderQuery, older.version);
  assert.deepEqual(counted.page.items, older.page.items);
  assert.equal(counted.page.through, latest.page.through);
  assert.equal(counted.page.unread, older.page.unread + 1);
  const arrived = await changedPage(cookie, "unread=false", latest.version);
  assert.notEqual(arrived.page.through, latest.page.through);

  await readNotification(alice, arrived.page.items[0].id);
  const read = await changedPage(cookie, "unread=false", arrived.version);
  assert.equal(read.page.items[0].read, true);
  await readAllNotifications(alice, read.page.through);
  const all = await changedPage(cookie, "unread=false", read.version);
  assert.equal(all.page.unread, 0);
  await unchangedPage(cookie, "unread=false", all.version);

  // A version answers only for the page whose body it hashes.
  const other = await changedPage(
    await cookieFor(ben),
    "unread=false",
    all.version,
  );
  assert.notDeepEqual(other.page, all.page);
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
    denied.notification,
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
  await assert.rejects(readNotification(alice, old.id), denied.notification);
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

async function friendship(a: string, b: string) {
  return (
    await db.query<{ accepted: boolean }>(
      `SELECT accepted_at IS NOT NULL AS accepted FROM friendship
       WHERE low_id=least($1,$2) AND high_id=greatest($1,$2)`,
      [a, b],
    )
  ).rows[0];
}

async function readAt(id: string) {
  return (
    await db.query<{ read: boolean; email_pending: boolean }>(
      "SELECT read_at IS NOT NULL AS read,email_pending FROM notification WHERE id=$1",
      [id],
    )
  ).rows[0];
}

test("friend-request notifications identify the requester and answer only that pending request", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await saveActivityEmail(alice, true);
  await changeRelationship(ben, alice, "request");
  const [request] = (await notifications(alice)).items;
  assert.equal(request.kind, "friend_request");
  assert.equal(request.actorId, ben);
  assert.equal((await readAt(request.id)).email_pending, true);
  await assert.rejects(
    respondToFriendRequest(outsider, request.id, "accept"),
    denied.pendingRequest,
  );
  await assert.rejects(
    respondToFriendRequest(alice, request.id, "remove"),
    /Unknown friend request action/,
  );
  await assert.rejects(
    respondToFriendRequest(alice, "oops", "accept"),
    /Invalid notification/,
  );
  await respondToFriendRequest(alice, request.id, "accept");
  assert.deepEqual(await friendship(alice, ben), { accepted: true });
  assert.deepEqual(await readAt(request.id), {
    read: true,
    email_pending: false,
  });
  assert.equal(await unread(alice), 0);
  assert.equal((await notifications(ben)).items[0].kind, "friend_accepted");
  // A stale Decline never ends the friendship the request became.
  await assert.rejects(
    respondToFriendRequest(alice, request.id, "decline"),
    denied.pendingRequest,
  );
  assert.deepEqual(await friendship(alice, ben), { accepted: true });

  await changeRelationship(cam, alice, "request");
  const [declined] = (await notifications(alice)).items;
  await respondToFriendRequest(alice, declined.id, "decline");
  assert.equal(await friendship(alice, cam), undefined);
  assert.equal((await readAt(declined.id)).read, true);
  assert.equal(await unread(alice), 0);
  await assert.rejects(
    respondToFriendRequest(alice, declined.id, "accept"),
    denied.pendingRequest,
  );
  assert.equal(await friendship(alice, cam), undefined);

  // Other notification kinds and the requester's own copy cannot answer.
  await addComment(ben, conversation, "Not a request", false);
  const [comment] = (await notifications(alice)).items;
  assert.equal(comment.kind, "comment");
  await assert.rejects(
    respondToFriendRequest(alice, comment.id, "accept"),
    denied.pendingRequest,
  );
  await changeRelationship(outsider, alice, "request");
  const [sent] = (await notifications(alice)).items;
  await assert.rejects(
    respondToFriendRequest(outsider, sent.id, "accept"),
    denied.pendingRequest,
  );
  await changeRelationship(alice, outsider, "block");
  await assert.rejects(
    respondToFriendRequest(alice, sent.id, "accept"),
    denied.pendingRequest,
  );
});

// The iPhone push extension's single-notification read
// (docs/data-and-access.md#single-notification-read).
const hidden = { visible: false };
async function shown(viewer: string, id: string) {
  const content = await notification(viewer, id);
  assert.ok(content.visible, `notification ${id} is hidden`);
  return content.notification;
}
async function isRead(id: string) {
  return (
    await db.query<{ read: boolean }>(
      "SELECT read_at IS NOT NULL AS read FROM notification WHERE id=$1",
      [id],
    )
  ).rows[0].read;
}

test("the push extension's read gives the bell's notification with its excerpt and reply target, without marking it read", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const bytes = Buffer.alloc(4000, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  const { photo } = await uploadPhoto(ben, bytes);
  const comment = await addComment(
    ben,
    conversation,
    "  Loved\n\nthis   one. ",
    false,
  );
  const [commented] = (await notifications(alice)).items;
  assert.equal(commented.kind, "comment");
  assert.equal(commented.actorPhoto, photo);
  assert.deepEqual(await notification(alice, commented.id), {
    visible: true,
    notification: {
      ...commented,
      title: "Test Movie",
      excerpt: "Loved this one.",
      spoiler: false,
      thread: conversation,
      comment,
    },
  });
  assert.equal(await isRead(commented.id), false);

  // A long reply ends at a word with an ellipsis and never splits a
  // character.
  const words = `${"🎬 scene ".repeat(40)}final`;
  const own = await addComment(alice, conversation, "Agreed", false, comment);
  const answer = await addComment(ben, conversation, words, false, own);
  const [replied] = (await notifications(alice)).items;
  const reply = await shown(alice, replied.id);
  assert.equal(reply.kind, "reply");
  assert.equal(reply.thread, conversation);
  assert.equal(reply.comment, answer);
  const excerpt = reply.excerpt!;
  assert.ok(excerpt.endsWith(" scene…"), excerpt);
  assert.ok(excerpt.isWellFormed());
  assert.ok([...new Intl.Segmenter().segment(excerpt)].length <= 160);
  assert.ok(words.startsWith(excerpt.slice(0, -1)));

  // Friendships have no title, excerpt, thread, or comment.
  await changeRelationship(ben, alice, "remove");
  await changeRelationship(ben, alice, "request");
  const [request] = (await notifications(alice)).items;
  assert.equal(request.kind, "friend_request");
  assert.deepEqual(await notification(alice, request.id), {
    visible: true,
    notification: {
      ...request,
      title: null,
      excerpt: null,
      spoiler: false,
      thread: null,
      comment: null,
    },
  });
  await changeRelationship(alice, ben, "accept");
  const [accepted] = (await notifications(ben)).items;
  assert.equal(accepted.kind, "friend_accepted");
  assert.equal((await shown(ben, accepted.id)).href, "/people/alice");
  assert.equal(await isRead(request.id), false);
});

test("the push extension's read omits the excerpt of a spoiler reply and of every reply in a spoiler entry's thread", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  const post = await createTitleComment(alice, "movie:1", "Plain post", false);
  const marked = await addComment(ben, post, "The twist is a dream", true);
  const covered = [
    await createTitleComment(alice, "movie:1", "Twist", true),
    await saveReview(alice, "movie:1", 4, "Ending reveal", true),
    await createDiscussionPost(alice, "Finale talk", true),
  ];
  for (const entry of covered)
    await addComment(ben, entry, "The twist is a dream", false);
  const replies = (await notifications(alice)).items.filter(
    (item) => item.kind === "comment",
  );
  assert.equal(replies.length, 4);
  for (const item of replies) {
    const content = await shown(alice, item.id);
    assert.equal(content.spoiler, true);
    assert.equal(content.excerpt, null);
    assert.ok(!JSON.stringify(content).includes("dream"));
  }
  // The extension can still reply to a spoiler.
  const spoiler = await shown(alice, replies.at(-1)!.id);
  assert.deepEqual([spoiler.thread, spoiler.comment], [post, marked]);
});

test("the push extension's read hides notifications from blocked and unfriended actors, of removed comments, and of other members alike", async () => {
  const { alice, ben, cam, outsider, conversation } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  const parent = await addComment(ben, conversation, "Nice pick", false);
  const reply = await addComment(cam, conversation, "Agreed", false, parent);
  const [toBen] = (await notifications(ben)).items;
  assert.equal(toBen.kind, "reply");
  assert.equal((await shown(ben, toBen.id)).excerpt, "Agreed");

  // Blocking in either direction hides it until unblocked.
  await changeRelationship(ben, cam, "block");
  assert.deepEqual(await notification(ben, toBen.id), hidden);
  await changeRelationship(ben, cam, "unblock");
  await shown(ben, toBen.id);
  await changeRelationship(cam, ben, "block");
  assert.deepEqual(await notification(ben, toBen.id), hidden);
  await changeRelationship(cam, ben, "unblock");
  await shown(ben, toBen.id);

  // Unfriending hides the actor's comments and the acceptance.
  const [toAlice] = (await notifications(alice)).items;
  assert.equal(toAlice.actorId, cam);
  const accepted = (await notifications(alice)).items.find(
    (item) => item.kind === "friend_accepted" && item.actorId === cam,
  )!;
  await shown(alice, accepted.id);
  await changeRelationship(alice, cam, "remove");
  assert.deepEqual(await notification(alice, toAlice.id), hidden);
  assert.deepEqual(await notification(alice, accepted.id), hidden);
  assert.deepEqual(await notification(ben, toBen.id), hidden);
  await friend(alice, cam);
  await shown(alice, toAlice.id);

  // A removed comment, another member's notification, and an unknown ID give
  // the same answer, so the read reveals nothing about which applies.
  for (const viewer of [ben, cam, outsider])
    assert.deepEqual(await notification(viewer, toAlice.id), hidden);
  assert.deepEqual(await notification(alice, "999999"), hidden);
  await removeComment(cam, reply);
  assert.deepEqual(await notification(alice, toAlice.id), hidden);
  for (const invalid of [null, "", "-1", "oops", "9223372036854775808"])
    await assert.rejects(notification(alice, invalid), /Invalid notification/);
  assert.equal(await isRead(toAlice.id), false);
  assert.equal(await isRead(toBen.id), false);
});

test("the push extension reads one notification with its bearer token, with one response for every hidden notification", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  await addComment(ben, conversation, "Nice pick", false);
  const [commented] = (await notifications(alice)).items;
  async function request(token: string, id: string) {
    const response = await GET(
      new Request(`http://localhost:3000/api/screenr/notification?id=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ action: "notification" }) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return {
      version: response.headers.get("ETag"),
      body: (await response.json()) as unknown,
    };
  }
  const own = await request(await bearerFor(alice), commented.id);
  assert.deepEqual(own.body, await notification(alice, commented.id));
  const other = await bearerFor(ben);
  const unknown = await request(other, "999999");
  assert.deepEqual(unknown.body, hidden);
  assert.deepEqual(await request(other, commented.id), unknown);
  assert.equal(await isRead(commented.id), false);
});

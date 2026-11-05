import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, friend, person, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { conversations } = await import("../../src/server/feed");
const { addComment, createDiscussionPost, removeComment } =
  await import("../../src/server/comments");
const { changeRelationship } = await import("../../src/server/relationships");

// The friends feed and profiles page their histories, 50 entries at a time
// (docs/title-feed.md#paged-histories).
useDatabase();
const pageSize = 50;

// `count` posts by `owner`, oldest first, a minute apart, the newest an hour
// before the entries that tests add later.
async function posts(owner: string, count: number) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++)
    ids.push(await createDiscussionPost(owner, `Post ${n}`, false));
  await db.query(
    `UPDATE discussion_post p SET created_at=now()-interval '1 hour'-($2-t.n)*interval '1 minute'
    FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n) WHERE p.id=t.id`,
    [ids, count],
  );
  return ids;
}

type Entry = {
  id: string;
  visible_activity: string;
  comments: { id: string }[];
};
type Paged = {
  conversations: Entry[];
  since?: string | null;
  older?: boolean;
  target?: { item: string; reply?: string } | null;
  targetUnavailable?: boolean;
};
async function read(viewer: string, path: string) {
  const screen = (await loadScreen(viewer, path)) as unknown as Paged;
  // The JSON a screen read sends.
  return JSON.parse(JSON.stringify(screen)) as Paged;
}
const ids = (screen: Paged) => screen.conversations.map((c) => c.id);
const placed = (entries: Entry[]) =>
  entries.map(({ id, visible_activity }) => ({ id, visible_activity }));
const window = (since: string) => `since=${encodeURIComponent(since)}`;
const earlier = (since: string) => `before=${encodeURIComponent(since)}`;

test("the friends feed sends its newest page, keeps each window it names, and reads older pages", async () => {
  const { alice, ben, conversation } = await setup();
  await friend(alice, ben);
  const old = await posts(ben, 120);
  const all = (await conversations(alice)).map((c) => ({
    id: c.id,
    visible_activity: new Date(c.visible_activity).toISOString(),
  }));
  assert.equal(all.length, 121);
  assert.deepEqual(all.at(-1)!.id, old[0]);

  const first = await read(alice, "/?before=now");
  assert.deepEqual(placed(first.conversations), all.slice(0, pageSize));
  assert.equal(first.conversations[0].id, conversation);
  assert.equal(first.since, all[pageSize - 1].visible_activity);
  assert.equal(first.older, true);
  // Later reads of the window send the same entries, and new activity joins
  // them without pushing the oldest out.
  assert.deepEqual(await read(alice, `/?${window(first.since!)}`), first);
  const added = await createDiscussionPost(ben, "Brand new", false);
  const polled = await read(alice, `/?${window(first.since!)}`);
  assert.deepEqual(ids(polled), [added, ...ids(first)]);
  assert.equal(polled.since, first.since);
  assert.equal(polled.older, true);

  // Show older reads the next page with every newer entry.
  const second = await read(alice, `/?${earlier(polled.since!)}`);
  assert.deepEqual(ids(second), [
    added,
    ...all.slice(0, 2 * pageSize).map((c) => c.id),
  ]);
  assert.equal(second.since, all[2 * pageSize - 1].visible_activity);
  assert.equal(second.older, true);
  const third = await read(alice, `/?${earlier(second.since!)}`);
  assert.deepEqual(ids(third), [added, ...all.map((c) => c.id)]);
  assert.equal(third.since, all.at(-1)!.visible_activity);
  assert.equal(third.older, false);

  // A reply moves an old entry back into the newest page.
  await addComment(alice, old[0], "Back to this one", false);
  assert.equal(ids(await read(alice, "/?before=now"))[0], old[0]);

  // A read without a window, such as an installed iPhone build's, sends the
  // whole history and no paging fields.
  const whole = await read(alice, "/");
  assert.equal(whole.conversations.length, 122);
  assert.ok(!("since" in whole) && !("older" in whole));
});

test("a page includes every entry tied with its last one, and a time that does not parse reads the newest page", async () => {
  const { alice, ben } = await setup();
  await friend(alice, ben);
  await posts(ben, 60);
  // The 49th through 52nd newest entries share the 50th's time.
  const tied = ids(await read(alice, "/?before=now")).slice(48, 50);
  const after = (await conversations(alice)).slice(50, 52).map((c) => c.id);
  tied.push(...after);
  await db.query(
    `UPDATE discussion_post SET created_at=(SELECT created_at FROM discussion_post WHERE id=$2)
    WHERE id=ANY($1::uuid[])`,
    [tied, tied[1]],
  );
  const page = await read(alice, "/?before=now");
  assert.equal(page.conversations.length, pageSize + 2);
  for (const id of tied) assert.ok(ids(page).includes(id));
  assert.equal(page.older, true);
  for (const path of ["/?since=soon", "/?before=later", "/?since=&before=x"])
    assert.deepEqual(await read(alice, path), page, path);
});

test("a link to an entry older than the page sends that entry too", async () => {
  const { alice, ben, outsider } = await setup();
  await friend(alice, ben);
  const old = await posts(ben, 70);
  const reply = await addComment(alice, old[0], "Linked reply", false);
  // The reply would bring the post to the top, so it is backdated.
  await db.query(
    "UPDATE comment SET created_at=now()-interval '3 hours' WHERE id::text=$1",
    [reply],
  );
  const linked = await read(
    alice,
    `/?before=now&item=${old[0]}&reply=${reply}`,
  );
  assert.equal(linked.conversations.length, pageSize + 1);
  assert.equal(ids(linked).at(-1), old[0]);
  assert.deepEqual(linked.target, { item: old[0], reply });
  assert.equal(linked.targetUnavailable, false);
  // The window stays the page's own.
  const page = await read(alice, "/?before=now");
  assert.equal(linked.since, page.since);
  assert.deepEqual(ids(linked).slice(0, -1), ids(page));
  // A link that the reader cannot follow sends nothing extra.
  const hidden = await read(outsider, `/?before=now&item=${old[0]}`);
  assert.deepEqual(hidden.conversations, []);
  assert.equal(hidden.targetUnavailable, true);
  assert.equal(hidden.since, null);
  assert.equal(hidden.older, false);
});

test("profiles page their owner's entries, and unreadable or empty histories send no page", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  const old = await posts(ben, 55);
  await posts(alice, 5);
  const own = await conversations(alice, { owner: ben });
  const page = await read(alice, "/people/ben?before=now");
  assert.deepEqual(
    ids(page),
    own.slice(0, pageSize).map((c) => c.id),
  );
  assert.equal(page.older, true);
  const rest = await read(alice, `/people/ben?${earlier(page.since!)}`);
  assert.deepEqual(
    ids(rest),
    own.map((c) => c.id),
  );
  assert.equal(rest.older, false);
  assert.equal(ids(rest).at(-1), old[0]);
  const whole = await read(alice, "/people/ben");
  assert.equal(whole.conversations.length, 55);
  assert.ok(!("since" in whole) && !("older" in whole));
  // Cam is not Ben's friend, so his entries stay friends-only.
  const unreadable = await read(cam, "/people/ben?before=now");
  assert.deepEqual(unreadable.conversations, []);
  assert.equal(unreadable.since, null);
  assert.equal(unreadable.older, false);
  const nora = await person("nora");
  const empty = await read(nora, "/?before=now");
  assert.deepEqual(empty.conversations, []);
  assert.equal(empty.since, null);
  assert.equal(empty.older, false);
});

test("access changes and removals leave a page through the same rules as the whole history", async () => {
  const { alice, ben, cam } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await friend(ben, cam);
  await posts(ben, 30);
  await posts(cam, 30);
  const camReply = await addComment(
    cam,
    (await posts(ben, 1))[0],
    "Cam",
    false,
  );
  const matches = async () => {
    const page = await read(alice, "/?before=now");
    const whole = (await conversations(alice)).slice(
      0,
      page.conversations.length,
    );
    assert.deepEqual(page.conversations, JSON.parse(JSON.stringify(whole)));
    return page;
  };
  await matches();
  await changeRelationship(alice, cam, "block");
  const blocked = await matches();
  assert.ok(
    blocked.conversations.every(
      (c) => !c.comments.some((r) => r.id === camReply),
    ),
  );
  await changeRelationship(alice, cam, "unblock");
  await removeComment(cam, camReply);
  await changeRelationship(alice, ben, "remove");
  const page = await matches();
  assert.ok(page.conversations.length <= pageSize);
});

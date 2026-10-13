import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useDatabase, db, friend, person } from "./social-fixture";
import type { FriendAction, FriendActivity } from "../../src/shared";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship } = await import("../../src/server/relationships");
const { updateTitleActivity, updateTopTen } =
  await import("../../src/server/title-actions");
const { createTitleComment } = await import("../../src/server/comments");
const { TitleFriends } = await import("../../src/components/title-friends");

useDatabase();

async function titles() {
  await db.query(`INSERT INTO title(id,kind,tmdb_id,name) VALUES
    ('movie:1','movie',1,'Test Movie'),('movie:2','movie',2,'Other Movie')
    ON CONFLICT DO NOTHING`);
}

async function people(...names: string[]) {
  const ids: string[] = [];
  for (const name of names) ids.push(await person(name));
  return ids;
}

// The viewer's title page data and its friend line as display names.
async function friendLine(viewer: string) {
  const data = await loadScreen(viewer, "/titles/movie/1");
  assert.ok(data.kind === "title");
  const names = (group: FriendAction[]) => group.map((f) => f.display_name);
  return {
    recommended: names(data.friends.recommended),
    want_to_watch: names(data.friends.want_to_watch),
    data,
  };
}
async function groups(viewer: string) {
  const line = await friendLine(viewer);
  return [line.recommended, line.want_to_watch];
}

test("the title friend line groups current friends' actions, most recent first, without the viewer", async () => {
  await titles();
  const [viewer, maya, sam, theo, ana, lee] = await people(
    "viewer",
    "maya",
    "sam",
    "theo",
    "ana",
    "lee",
  );
  for (const id of [maya, sam, theo, ana, lee]) await friend(viewer, id);
  assert.deepEqual(await groups(viewer), [[], []]);

  await updateTitleActivity(viewer, "movie:1", "recommended", true);
  await updateTitleActivity(maya, "movie:1", "recommended", true);
  await updateTitleActivity(sam, "movie:1", "recommended", true);
  await updateTitleActivity(theo, "movie:1", "want_to_watch", true);
  await updateTitleActivity(ana, "movie:1", "recommended", true);
  // Other titles and standalone comments are not title actions.
  await updateTitleActivity(lee, "movie:2", "recommended", true);
  await createTitleComment(lee, "movie:1", "Only a comment", false);
  const line = await friendLine(viewer);
  assert.deepEqual(line.recommended, ["ana", "sam", "maya"]);
  assert.deepEqual(line.want_to_watch, ["theo"]);
  // Each name links to that friend's entry in the title feed.
  for (const action of [
    ...line.data.friends.recommended,
    ...line.data.friends.want_to_watch,
  ]) {
    const entry = line.data.conversations.find((c) => c.id === action.item);
    assert.equal(entry?.owner_id, action.user_id);
    assert.equal(entry?.active, true);
  }

  // Switching moves a friend between groups; withdrawing removes them.
  await updateTitleActivity(maya, "movie:1", "want_to_watch", true);
  await updateTitleActivity(sam, "movie:1", "recommended", false);
  assert.deepEqual(await groups(viewer), [["ana"], ["maya", "theo"]]);
  // Maya sees her friend's action, but neither her own nor nonfriends'.
  assert.deepEqual(await groups(maya), [["viewer"], []]);
});

test("the title friend line follows the title feed's friendship and blocking rules", async () => {
  await titles();
  const [
    viewer,
    current,
    stranger,
    requested,
    incoming,
    blocked,
    blocker,
    unfriended,
    secondDegree,
  ] = await people(
    "viewer",
    "current",
    "stranger",
    "requested",
    "incoming",
    "blocked",
    "blocker",
    "unfriended",
    "seconddegree",
  );
  for (const id of [current, blocked, blocker, unfriended])
    await friend(viewer, id);
  await friend(current, secondDegree);
  await changeRelationship(viewer, requested, "request");
  await changeRelationship(incoming, viewer, "request");
  for (const id of [
    current,
    stranger,
    requested,
    incoming,
    blocked,
    blocker,
    unfriended,
    secondDegree,
  ])
    await updateTitleActivity(id, "movie:1", "recommended", true);
  await changeRelationship(viewer, blocked, "block");
  await changeRelationship(blocker, viewer, "block");
  await changeRelationship(viewer, unfriended, "remove");
  assert.deepEqual((await friendLine(viewer)).recommended, ["current"]);
  // The rules apply to each reader: the friend of a friend sees only their
  // own friend, and a blocked person loses the viewer's entries too.
  await updateTitleActivity(viewer, "movie:1", "want_to_watch", true);
  assert.deepEqual(await groups(secondDegree), [["current"], []]);
  assert.deepEqual(await groups(blocked), [[], []]);
  assert.deepEqual(await groups(current), [["seconddegree"], ["viewer"]]);

  // Restored friendships restore the friend line like the feed.
  await changeRelationship(viewer, blocked, "unblock");
  await friend(viewer, blocked);
  await friend(unfriended, viewer);
  assert.deepEqual((await friendLine(viewer)).recommended, [
    "unfriended",
    "blocked",
    "current",
  ]);
});

test("the title friend line shows top 10 ranks, best first, then the rest newest first", async () => {
  await titles();
  const [viewer, maya, sam, theo, ana, kai] = await people(
    "viewer",
    "maya",
    "sam",
    "theo",
    "ana",
    "kai",
  );
  for (const id of [maya, sam, theo, ana, kai]) await friend(viewer, id);
  await updateTitleActivity(maya, "movie:1", "recommended", true);
  await updateTopTen(sam, "movie:2", "add");
  await updateTopTen(sam, "movie:1", "add"); // #2
  await updateTitleActivity(theo, "movie:1", "recommended", true);
  await updateTopTen(ana, "movie:1", "add"); // #1
  await updateTitleActivity(kai, "movie:1", "want_to_watch", true);
  // The viewer's own top 10 does not add them to the line.
  await updateTopTen(viewer, "movie:1", "add");
  const ranks = (group: FriendAction[]) => group.map((f) => f.rank);
  let line = await friendLine(viewer);
  assert.deepEqual(line.recommended, ["ana", "sam", "theo", "maya"]);
  assert.deepEqual(ranks(line.data.friends.recommended), [1, 2, null, null]);
  assert.deepEqual(line.want_to_watch, ["kai"]);
  assert.deepEqual(ranks(line.data.friends.want_to_watch), [null]);

  // Leaving the list returns a friend to the newest-first order, and a rank
  // follows its owner's list.
  await updateTopTen(ana, "movie:1", "remove");
  await updateTopTen(sam, "movie:2", "remove");
  line = await friendLine(viewer);
  assert.deepEqual(line.recommended, ["sam", "ana", "theo", "maya"]);
  assert.deepEqual(ranks(line.data.friends.recommended), [1, null, null, null]);
});

const friendsNamed = (prefix: string, count: number): FriendAction[] =>
  Array.from({ length: count }, (_, index) => ({
    item: `${prefix}-${index}`,
    user_id: `${prefix}-user-${index}`,
    display_name: `${prefix.toUpperCase()}${index + 1}`,
    rank: null,
  }));
function render(activity: FriendActivity) {
  return renderToStaticMarkup(
    createElement(TitleFriends, { friends: activity, showEntry: () => {} }),
  );
}
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, "").replaceAll("\u00a0", " ");

test("the title friend line names up to three friends per group, then counts the rest", () => {
  assert.equal(render({ recommended: [], want_to_watch: [] }), "");
  for (const [recommended, wanted, expected] of [
    [1, 0, "Recommended by R1"],
    [2, 0, "Recommended by R1 and R2"],
    [3, 0, "Recommended by R1, R2, and R3"],
    [4, 0, "Recommended by R1, R2, R3, and 1 more"],
    [6, 0, "Recommended by R1, R2, R3, and 3 more"],
    [0, 1, "W1 wants to watch"],
    [0, 2, "W1 and W2 want to watch"],
    [0, 5, "W1, W2, W3, and 2 more want to watch"],
    [2, 1, "Recommended by R1 and R2 · W1 wants to watch"],
    [
      5,
      4,
      "Recommended by R1, R2, R3, and 2 more · W1, W2, W3, and 1 more want to watch",
    ],
  ] as const) {
    const markup = render({
      recommended: friendsNamed("r", recommended),
      want_to_watch: friendsNamed("w", wanted),
    });
    assert.equal(text(markup), expected);
    // Each named friend links to their entry; counted friends are plain text.
    const links = [...markup.matchAll(/<a href="#item-([^"]+)">/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(links, [
      ...friendsNamed("r", Math.min(recommended, 3)).map((f) => f.item),
      ...friendsNamed("w", Math.min(wanted, 3)).map((f) => f.item),
    ]);
  }
});

test("the title friend line shows each recommender's top 10 rank beside their name", () => {
  const markup = render({
    recommended: [
      { item: "a", user_id: "maya", display_name: "Maya Chen", rank: 1 },
      { item: "b", user_id: "sam", display_name: "Sam Okafor", rank: null },
    ],
    want_to_watch: friendsNamed("w", 1),
  });
  assert.equal(
    text(markup),
    "Recommended by Maya Chen (#1) and Sam Okafor · W1 wants to watch",
  );
  // The link names the friend; the rank follows it.
  assert.match(markup, /<a href="#item-a">Maya Chen<\/a> \(#1\)/);
});

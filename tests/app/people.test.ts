import { test } from "node:test";
import assert from "node:assert/strict";
import { useDatabase, db, person, friend, setup } from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { changeRelationship, updateTitleActivity, thread } =
  await import("../../src/server/social");

useDatabase();

test("people suggestions list distinct friends of friends and all mutual friends without private activity", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(cam, alice);
  await friend(ben, cam);
  await friend(ben, outsider);
  await friend(outsider, cam);
  const aaron = await person("aaron");
  const zara = await person("zara");
  await friend(ben, zara);
  await friend(aaron, cam);
  const incoming = await person("incoming");
  const outgoing = await person("outgoing");
  await friend(ben, incoming);
  await friend(ben, outgoing);
  await changeRelationship(incoming, alice, "request");
  await changeRelationship(alice, outgoing, "request");
  const pendingBridge = await person("pendingbridge");
  const distant = await person("distant");
  await changeRelationship(alice, pendingBridge, "request");
  await friend(pendingBridge, distant);
  await friend(outsider, distant);
  const pendingSecond = await person("pendingsecond");
  await changeRelationship(ben, pendingSecond, "request");
  await person("unconnected");
  const privateItem = await updateTitleActivity(
    outsider,
    "movie:1",
    "recommended",
    true,
  );

  const screen = await loadScreen(alice, "/people");
  assert.ok(screen.kind === "people");
  const mutualBen = { user_id: ben, username: "ben", display_name: "ben" };
  const mutualCam = { user_id: cam, username: "cam", display_name: "cam" };
  assert.deepEqual(screen.suggestions, [
    {
      user_id: outsider,
      username: "outsider",
      display_name: "outsider",
      mutual_friends: [mutualBen, mutualCam],
    },
    {
      user_id: aaron,
      username: "aaron",
      display_name: "aaron",
      mutual_friends: [mutualCam],
    },
    {
      user_id: zara,
      username: "zara",
      display_name: "zara",
      mutual_friends: [mutualBen],
    },
  ]);
  assert.equal(JSON.stringify(screen).includes(privateItem), false);
  const profile = await loadScreen(alice, "/people/outsider");
  assert.ok(profile.kind === "profile");
  assert.equal(profile.profile.can_read, false);
  assert.deepEqual(profile.conversations, []);
  await assert.rejects(thread(alice, privateItem), /not found/i);
});

test("people suggestions follow requests, acceptance, and loss of each mutual friendship", async () => {
  const { alice, ben, cam, outsider } = await setup();
  const suggestions = async () => {
    const screen = await loadScreen(alice, "/people");
    assert.ok(screen.kind === "people");
    return screen.suggestions;
  };
  assert.deepEqual(await suggestions(), []);
  await friend(alice, ben);
  await changeRelationship(ben, outsider, "request");
  assert.deepEqual(await suggestions(), []);
  await changeRelationship(outsider, ben, "accept");
  assert.equal((await suggestions())[0].user_id, outsider);
  for (const [sender, recipient] of [
    [alice, outsider],
    [outsider, alice],
  ]) {
    await changeRelationship(sender, recipient, "request");
    assert.deepEqual(await suggestions(), []);
    await changeRelationship(recipient, sender, "remove");
    assert.equal((await suggestions())[0].user_id, outsider);
  }
  await friend(alice, outsider);
  assert.deepEqual(await suggestions(), []);
  await changeRelationship(alice, outsider, "remove");
  await friend(alice, cam);
  await friend(cam, outsider);
  assert.equal((await suggestions())[0].mutual_friends.length, 2);
  await changeRelationship(ben, outsider, "remove");
  assert.deepEqual(
    (await suggestions())[0].mutual_friends.map((p) => p.username),
    ["cam"],
  );
  await changeRelationship(alice, cam, "remove");
  assert.deepEqual(await suggestions(), []);
});

for (const pair of [
  [0, 2],
  [2, 0],
  [0, 1],
  [1, 0],
  [1, 2],
  [2, 1],
]) {
  test(`people suggestions respect blocks along every path (${pair.join(" blocks ")})`, async () => {
    const { alice, ben, cam, outsider } = await setup();
    await friend(alice, ben);
    await friend(ben, outsider);
    await friend(alice, cam);
    await friend(cam, outsider);
    const ids = [alice, ben, outsider];
    // Also cover retained relationship rows, so the result enforces the block
    // itself instead of relying only on the normal action deleting friendships.
    await db.query("INSERT INTO block(blocker_id,blocked_id) VALUES($1,$2)", [
      ids[pair[0]],
      ids[pair[1]],
    ]);
    const screen = await loadScreen(alice, "/people");
    assert.ok(screen.kind === "people");
    if (pair.includes(0) && pair.includes(2)) {
      assert.deepEqual(screen.suggestions, []);
    } else {
      assert.deepEqual(screen.suggestions, [
        {
          user_id: outsider,
          username: "outsider",
          display_name: "outsider",
          mutual_friends: [
            { user_id: cam, username: "cam", display_name: "cam" },
          ],
        },
      ]);
      await changeRelationship(cam, outsider, "remove");
      const empty = await loadScreen(alice, "/people");
      assert.ok(empty.kind === "people");
      assert.deepEqual(empty.suggestions, []);
    }
  });
}

test("profiles list accepted friends for owners, friends, and nonfriends without exposing private activity or requests", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, cam);
  await friend(alice, ben);
  const incoming = await person("incoming");
  const outgoing = await person("outgoing");
  await changeRelationship(incoming, alice, "request");
  await changeRelationship(alice, outgoing, "request");

  for (const viewer of [alice, ben, outsider]) {
    const screen = await loadScreen(viewer, "/people/ALICE");
    assert.ok(screen.kind === "profile");
    assert.deepEqual(screen.profile.friends, [
      { user_id: ben, username: "ben", display_name: "ben" },
      { user_id: cam, username: "cam", display_name: "cam" },
    ]);
    assert.equal(screen.conversations.length, viewer === outsider ? 0 : 1);
  }
  const empty = await loadScreen(alice, "/people/outsider");
  assert.ok(empty.kind === "profile");
  assert.deepEqual(empty.profile.friends, []);
});

test("profile friends hide blocked people in both directions and reject blocked profiles", async () => {
  const { alice, ben, cam, outsider } = await setup();
  await friend(alice, ben);
  await friend(alice, cam);
  await changeRelationship(outsider, ben, "block");
  await changeRelationship(cam, outsider, "block");
  const filtered = await loadScreen(outsider, "/people/alice");
  assert.ok(filtered.kind === "profile");
  assert.deepEqual(filtered.profile.friends, []);
  const owner = await loadScreen(alice, "/people/alice");
  assert.ok(owner.kind === "profile");
  assert.equal(owner.profile.friends.length, 2);
  await changeRelationship(outsider, alice, "block");
  await assert.rejects(loadScreen(outsider, "/people/alice"), /not found/i);
  await assert.rejects(loadScreen(alice, "/people/outsider"), /not found/i);
});

test("profile friends follow acceptance, removal, and blocking on each read", async () => {
  const { alice, ben, outsider } = await setup();
  const friends = async () => {
    const screen = await loadScreen(outsider, "/people/alice");
    assert.ok(screen.kind === "profile");
    return screen.profile.friends.map((p) => p.username);
  };
  await changeRelationship(alice, ben, "request");
  assert.deepEqual(await friends(), []);
  await changeRelationship(ben, alice, "accept");
  assert.deepEqual(await friends(), ["ben"]);
  await changeRelationship(ben, alice, "remove");
  assert.deepEqual(await friends(), []);
  await friend(alice, ben);
  assert.deepEqual(await friends(), ["ben"]);
  await changeRelationship(alice, ben, "block");
  assert.deepEqual(await friends(), []);
});

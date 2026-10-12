import { test } from "node:test";
import assert from "node:assert/strict";
import {
  useDatabase,
  db,
  denied,
  assertRouteError,
  pending,
  person,
  cookieFor,
} from "./social-fixture";
const { loadScreen } = await import("../../src/server/screens");
const { createInvitation, completeSignup, listInvitations } =
  await import("../../src/server/invitations");
const { profileFor } = await import("../../src/server/profiles");
const { updateTitleActivity } = await import("../../src/server/title-actions");
const { addComment } = await import("../../src/server/comments");

useDatabase();

async function rename(
  cookie: string,
  data: unknown,
  origin = "http://localhost:3000",
  action = "display-name",
) {
  const { POST } = await import("../../src/app/api/screenr/[action]/route");
  return POST(
    new Request(`http://localhost:3000/api/screenr/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify(data),
    }),
    { params: Promise.resolve({ action }) },
  );
}

const editProfile = (cookie: string, data: unknown, origin?: string) =>
  rename(cookie, data, origin, "profile");

test("account profile edits update both names across existing social views and preserve identity", async () => {
  const ben = await person("ben");
  const invite = await createInvitation(ben, 2);
  const alice = await pending("alice", invite.token);
  await completeSignup(alice, "Alice", "alice");
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Test Movie') ON CONFLICT DO NOTHING",
  );
  const item = await updateTitleActivity(alice, "movie:1", "recommended", true);
  const comment = await addComment(alice, item, "Existing reply", false);
  const reply = await addComment(
    ben,
    item,
    "Addressed to Alice",
    false,
    comment,
  );
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  const cookie = await cookieFor(alice);
  const response = await editProfile(cookie, {
    name: "  Renée Movie Fan 🎬  ",
    username: "  Alice_New  ",
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    user_id: alice,
    username: "alice_new",
    display_name: "Renée Movie Fan 🎬",
    photo: null,
  });
  const profile = await profileFor(ben, "ALICE_NEW");
  assert.equal(profile.user_id, alice);
  assert.equal(profile.display_name, "Renée Movie Fan 🎬");
  assert.ok(profile.accepted_at);
  await assert.rejects(profileFor(ben, "alice"), denied.person);
  for (const path of ["/", "/titles/movie/1", "/people/alice_new"]) {
    const data = await loadScreen(ben, path);
    assert.ok("conversations" in data && data.conversations);
    const existing = data.conversations.find((entry) => entry.id === item)!;
    assert.equal(existing.owner_id, alice);
    assert.equal(existing.username, "alice_new");
    assert.equal(existing.display_name, "Renée Movie Fan 🎬");
    const earlier = existing.comments.find((entry) => entry.id === comment)!;
    assert.equal(earlier.author_id, alice);
    assert.equal(earlier.username, "alice_new");
    assert.equal(earlier.display_name, "Renée Movie Fan 🎬");
    assert.equal(
      existing.comments.find((entry) => entry.id === reply)?.addressed_username,
      "alice_new",
    );
  }
  const friends = await loadScreen(ben, "/people");
  assert.ok(friends.kind === "people");
  assert.equal(friends.connections[0].username, "alice_new");
  assert.equal((await listInvitations(ben))[0].joined[0].username, "alice_new");
  const together = await loadScreen(ben, "/watch-together?with=alice_new");
  assert.ok(together.kind === "watch-together");
  assert.equal(
    together.participants.find((p) => p.user_id === alice)?.username,
    "alice_new",
  );
  // An existing session and a fresh email sign-in still reach the same member.
  assert.equal(
    (await editProfile(cookie, { name: "ben", username: "ALICE_NEW" })).status,
    200,
  );
  const signedInAgain = await cookieFor(alice);
  assert.equal(
    (await editProfile(signedInAgain, { name: "ben", username: "alice_new" }))
      .status,
    200,
  );
  assert.equal((await profileFor(ben, "alice_new")).user_id, alice);
});

test("account profile edits validate signup rules and roll back both fields on conflicts", async () => {
  const alice = await person("alice");
  await person("taken");
  const cookie = await cookieFor(alice);
  for (const username of [
    "",
    "  ",
    "ab",
    "x".repeat(25),
    "has space",
    "@alice",
    "élise",
    null,
    42,
    {},
  ]) {
    const response = await editProfile(cookie, { name: "Changed", username });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /[Uu]sername/);
    assert.equal((await profileFor(alice, "alice")).display_name, "alice");
  }
  for (const name of ["", " \n ", "x".repeat(61), null, 42, {}]) {
    const response = await editProfile(cookie, { name, username: "new_name" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Display name/);
    assert.equal((await profileFor(alice, "alice")).display_name, "alice");
  }
  const conflict = await editProfile(cookie, {
    name: "Changed",
    username: " TAKEN ",
  });
  assert.equal(conflict.status, 400);
  assert.equal(
    (await conflict.json()).error,
    "That username is already taken.",
  );
  assert.equal((await profileFor(alice, "alice")).display_name, "alice");
  for (const [name, username] of [
    ["x", "abc"],
    ["x".repeat(60), "x".repeat(24)],
  ]) {
    assert.equal((await editProfile(cookie, { name, username })).status, 200);
    assert.equal((await profileFor(alice, username)).display_name, name);
  }
});

test("account profile edits require membership and only update the signed-in member", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  const cookie = await cookieFor(alice);
  const data = {
    name: "Changed",
    username: "changed",
    user_id: ben,
    target: ben,
  };
  await assertRouteError(await editProfile("", data), denied.signedOut);
  await assertRouteError(
    await editProfile(cookie, data, "https://other.example"),
    denied.origin,
  );
  const invite = await createInvitation(null);
  const incomplete = await pending("incomplete", invite.token);
  await assertRouteError(
    await editProfile(await cookieFor(incomplete), data),
    denied.incompleteProfile,
  );
  assert.equal((await editProfile(cookie, data)).status, 200);
  assert.equal((await profileFor(alice, "changed")).user_id, alice);
  assert.equal((await profileFor(alice, "ben")).display_name, "ben");
});

test("account profile edits cannot claim the same username concurrently", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  const cookies = [await cookieFor(alice), await cookieFor(ben)];
  const responses = await Promise.all(
    cookies.map((cookie) =>
      editProfile(cookie, { name: "Updated", username: "shared_handle" }),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 400],
  );
  const winner = responses.findIndex((response) => response.status === 200);
  assert.equal(
    (await profileFor(alice, "shared_handle")).user_id,
    [alice, ben][winner],
  );
  const loser = ["alice", "ben"][1 - winner];
  assert.equal((await profileFor(alice, loser)).display_name, loser);
});

test("display name edits update existing social views without changing identity", async () => {
  const ben = await person("ben");
  const invite = await createInvitation(ben, 2);
  const alice = await pending("alice", invite.token);
  await completeSignup(alice, "Alice", "alice");
  assert.ok((await profileFor(alice, "ben")).accepted_at);
  await db.query(
    "INSERT INTO title(id,kind,tmdb_id,name) VALUES('movie:1','movie',1,'Test Movie') ON CONFLICT DO NOTHING",
  );
  const item = await updateTitleActivity(alice, "movie:1", "recommended", true);
  const comment = await addComment(alice, item, "An existing reply", false);
  await updateTitleActivity(alice, "movie:1", "want_to_watch", true);
  await updateTitleActivity(ben, "movie:1", "want_to_watch", true);
  const response = await rename(await cookieFor(alice), {
    name: "  Renée Movie Fan 🎬  ",
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    user_id: alice,
    username: "alice",
    display_name: "Renée Movie Fan 🎬",
    photo: null,
  });
  const profile = await profileFor(ben, "alice");
  assert.equal(profile.user_id, alice);
  assert.equal(profile.display_name, "Renée Movie Fan 🎬");
  assert.ok(profile.accepted_at);
  for (const path of ["/", "/titles/movie/1", "/people/alice"]) {
    const data = await loadScreen(ben, path);
    assert.ok("conversations" in data);
    assert.ok(data.conversations);
    const existing = data.conversations.find((entry) => entry.id === item)!;
    assert.equal(existing.owner_id, alice);
    assert.equal(existing.display_name, "Renée Movie Fan 🎬");
    assert.equal(
      existing.comments.find((entry) => entry.id === comment)?.display_name,
      "Renée Movie Fan 🎬",
    );
  }
  const friends = await loadScreen(ben, "/people");
  assert.ok(friends.kind === "people");
  assert.equal(friends.connections[0].display_name, "Renée Movie Fan 🎬");
  assert.equal(
    (await listInvitations(ben))[0].joined[0].display_name,
    "Renée Movie Fan 🎬",
  );
  const together = await loadScreen(ben, "/watch-together?with=alice");
  assert.ok(together.kind === "watch-together");
  assert.equal(
    together.participants.find((p) => p.user_id === alice)?.display_name,
    "Renée Movie Fan 🎬",
  );
  await cookieFor(alice);
  assert.equal(
    (await profileFor(alice, "alice")).display_name,
    "Renée Movie Fan 🎬",
  );
});

test("display name edits validate input and allow duplicate names", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  const cookie = await cookieFor(alice);
  for (const name of ["", " \n ", "x".repeat(61), null, 42, {}]) {
    const response = await rename(cookie, { name });
    assert.equal(response.status, 400);
    assert.match(
      (await response.json()).error,
      /Display name must contain 1–60 characters/,
    );
    assert.equal((await profileFor(alice, "alice")).display_name, "alice");
  }
  for (const name of ["x", "x".repeat(60), " ben "]) {
    assert.equal((await rename(cookie, { name })).status, 200);
    assert.equal((await profileFor(alice, "alice")).display_name, name.trim());
  }
  assert.equal((await profileFor(alice, "ben")).display_name, "ben");
  assert.notEqual(alice, ben);
});

// Every \p{Cc} control boundary, both Unicode line separators, and every
// bidirectional embedding, override, and isolate control (#108).
const hiddenCharacters = [
  ...["\u0000", "\t", "\n", "\r", "\u001b", "\u001f"],
  ...["\u007f", "\u0085", "\u009f", "\u2028", "\u2029"],
  ...["\u202a", "\u202b", "\u202c", "\u202d", "\u202e"],
  ...["\u2066", "\u2067", "\u2068", "\u2069"],
];
// Accents, CJK, emoji with skin tones, ZWJ and variation sequences, RTL
// scripts, and Indic conjuncts that use zero-width joiners.
const legitimateNames = [
  "Zoë Saldaña",
  "北野武",
  "김지운",
  "Sam 🎬",
  "\u{1f469}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} family",
  "\u{1f469}\u{1f3fd}\u200d\u{1f4bb} coder",
  "\u{1f3f3}\ufe0f\u200d\u{1f308}",
  "مريم",
  "עִבְרִית",
  "Sam מרים",
  "\u0915\u094d\u200d\u0937 \u0915\u094d\u200c\u0937",
];
const hiddenCharacterError =
  "Remove line breaks and hidden control characters from your display name.";

test("display names reject control and bidirectional override characters in every form", async () => {
  const alice = await person("alice");
  const cookie = await cookieFor(alice);
  const { token } = await createInvitation(null);
  const newcomer = await pending("newcomer", token);
  for (const character of hiddenCharacters) {
    const name = `Sam${character}Verify your account`;
    for (const response of [
      await rename(cookie, { name }),
      await editProfile(cookie, { name, username: "new_name" }),
    ]) {
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, hiddenCharacterError);
    }
    await assert.rejects(completeSignup(newcomer, name, "newcomer"), {
      message: hiddenCharacterError,
    });
    assert.equal((await profileFor(alice, "alice")).display_name, "alice");
  }
  assert.equal(
    (await db.query("SELECT 1 FROM profile WHERE user_id=$1", [newcomer]))
      .rowCount,
    0,
  );
  for (const name of legitimateNames) {
    assert.equal((await rename(cookie, { name })).status, 200);
    assert.equal((await profileFor(alice, "alice")).display_name, name);
    assert.equal(
      (await editProfile(cookie, { name, username: "alice" })).status,
      200,
    );
    assert.equal((await profileFor(alice, "alice")).display_name, name);
  }
  await completeSignup(newcomer, legitimateNames[4], "newcomer");
  assert.equal(
    (await profileFor(alice, "newcomer")).display_name,
    legitimateNames[4],
  );
});

test("the database rejects stored display names with hidden characters", async () => {
  const alice = await person("alice");
  // PostgreSQL text cannot store NUL at all.
  for (const character of hiddenCharacters.filter((c) => c !== "\u0000")) {
    await assert.rejects(
      db.query("UPDATE profile SET display_name=$2 WHERE user_id=$1", [
        alice,
        `Sam${character}Evil`,
      ]),
      { code: "23514", constraint: "profile_display_name_characters" },
    );
  }
  for (const name of legitimateNames) {
    await db.query("UPDATE profile SET display_name=$2 WHERE user_id=$1", [
      alice,
      name,
    ]);
    assert.equal((await profileFor(alice, "alice")).display_name, name);
  }
});

test("display name edits require membership and only update the signed-in member", async () => {
  const alice = await person("alice"),
    ben = await person("ben");
  const cookie = await cookieFor(alice);
  await assertRouteError(
    await rename("", { name: "Changed" }),
    denied.signedOut,
  );
  await assertRouteError(
    await rename(cookie, { name: "Changed" }, "https://other.example"),
    denied.origin,
  );
  const invite = await createInvitation(null);
  const incomplete = await pending("incomplete", invite.token);
  await assertRouteError(
    await rename(await cookieFor(incomplete), { name: "Changed" }),
    denied.incompleteProfile,
  );
  const response = await rename(cookie, {
    name: "Changed",
    user_id: ben,
    target: ben,
    username: "stolen",
  });
  assert.equal(response.status, 200);
  assert.equal((await profileFor(alice, "alice")).display_name, "Changed");
  assert.equal((await profileFor(alice, "ben")).display_name, "ben");
});
